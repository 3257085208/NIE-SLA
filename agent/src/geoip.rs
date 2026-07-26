use crate::{percent_encode_query, Config, HttpClient};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::thread;
use std::time::Duration;

const GEOIP_RETRY_SEC: u64 = 3600;
const GEOIP_REFRESH_SEC: u64 = 86400;

#[derive(Clone, Debug, Default)]
struct GeoLocation {
    ipv4: Option<String>,
    ipv6: Option<String>,
    country_code: String,
    country: String,
    city: String,
    provider: String,
}

pub(crate) fn spawn_geoip_worker(cfg: Config, http: HttpClient) {
    if cfg.once {
        return;
    }
    thread::spawn(move || loop {
        let delay = match refresh_location(&cfg, &http) {
            Ok(()) => GEOIP_REFRESH_SEC,
            Err(error) => {
                eprintln!(
                    "{{\"ok\":false,\"geoip_error\":{}}}",
                    serde_json::to_string(&error.to_string())
                        .unwrap_or_else(|_| "\"geoip failed\"".into())
                );
                GEOIP_RETRY_SEC
            }
        };
        thread::sleep(Duration::from_secs(delay));
    });
}

fn refresh_location(cfg: &Config, http: &HttpClient) -> Result<()> {
    let config_url = format!(
        "{}/api/agent/config?agent_id={}",
        cfg.api.trim_end_matches('/'),
        percent_encode_query(&cfg.agent_id)
    );
    let config: Value = serde_json::from_str(&http.get(&config_url, &cfg.token)?)?;
    let geo = config.get("geoip").cloned().unwrap_or(Value::Null);
    let provider = geo
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("ip_sb");
    let custom_url = geo.get("custom_url").and_then(Value::as_str).unwrap_or("");
    let location = lookup_location(http, provider, custom_url)?;
    let payload = json!({
        "provider": location.provider,
        "ipv4": location.ipv4,
        "ipv6": location.ipv6,
        "country_code": location.country_code,
        "country": location.country,
        "city": location.city,
    });
    let post_url = format!(
        "{}/api/agent/location?agent_id={}",
        cfg.api.trim_end_matches('/'),
        percent_encode_query(&cfg.agent_id)
    );
    http.post_json(&post_url, &cfg.token, &payload.to_string())?;
    Ok(())
}

fn lookup_location(http: &HttpClient, provider: &str, custom_url: &str) -> Result<GeoLocation> {
    match provider {
        "cloudflare" => lookup_cloudflare(http),
        "ipip_net" => lookup_ipip(http),
        "custom" => lookup_custom(http, custom_url),
        _ => lookup_ip_sb(http),
    }
}

fn lookup_ip_sb(http: &HttpClient) -> Result<GeoLocation> {
    let ipv4 = http
        .get_public("https://api-ipv4.ip.sb/geoip")
        .ok()
        .and_then(|body| parse_ip_sb(&body, 4));
    let ipv6 = http
        .get_public("https://api-ipv6.ip.sb/geoip")
        .ok()
        .and_then(|body| parse_ip_sb(&body, 6));
    merge_families("ip_sb", ipv4, ipv6)
}

fn lookup_cloudflare(http: &HttpClient) -> Result<GeoLocation> {
    let ipv4 = http
        .get_public("https://1.1.1.1/cdn-cgi/trace")
        .ok()
        .and_then(|body| parse_cloudflare_trace(&body, 4));
    let ipv6 = http
        .get_public("https://[2606:4700:4700::1111]/cdn-cgi/trace")
        .ok()
        .and_then(|body| parse_cloudflare_trace(&body, 6));
    merge_families("cloudflare", ipv4, ipv6)
}

fn lookup_ipip(http: &HttpClient) -> Result<GeoLocation> {
    let body = http.get_public("https://myip.ipip.net/json")?;
    let mut location =
        parse_ipip(&body).ok_or_else(|| anyhow!("IPIP.net returned an invalid response"))?;
    location.provider = "ipip_net".to_string();
    Ok(location)
}

fn lookup_custom(http: &HttpClient, url: &str) -> Result<GeoLocation> {
    if !url.starts_with("https://") {
        return Err(anyhow!("custom GeoIP URL must use HTTPS"));
    }
    let body = http.get_public(url)?;
    let mut location = parse_custom(&body)
        .ok_or_else(|| anyhow!("custom GeoIP response does not match the standard JSON schema"))?;
    location.provider = "custom".to_string();
    Ok(location)
}

fn merge_families(
    provider: &str,
    ipv4: Option<GeoLocation>,
    ipv6: Option<GeoLocation>,
) -> Result<GeoLocation> {
    let primary = ipv4
        .as_ref()
        .or(ipv6.as_ref())
        .ok_or_else(|| anyhow!("GeoIP provider is unavailable"))?;
    let country_code = primary.country_code.clone();
    let country = primary.country.clone();
    let city = primary.city.clone();
    Ok(GeoLocation {
        ipv4: ipv4.and_then(|item| item.ipv4),
        ipv6: ipv6.and_then(|item| item.ipv6),
        country_code,
        country,
        city,
        provider: provider.to_string(),
    })
}

fn parse_ip_sb(body: &str, family: u8) -> Option<GeoLocation> {
    let value: Value = serde_json::from_str(body).ok()?;
    location_from_fields(
        value.get("ip")?.as_str()?,
        family,
        value
            .get("country_code")
            .and_then(Value::as_str)
            .unwrap_or(""),
        value.get("country").and_then(Value::as_str).unwrap_or(""),
        value.get("city").and_then(Value::as_str).unwrap_or(""),
    )
}

fn parse_cloudflare_trace(body: &str, family: u8) -> Option<GeoLocation> {
    let mut ip = "";
    let mut country = "";
    for line in body.lines() {
        if let Some(value) = line.strip_prefix("ip=") {
            ip = value.trim();
        }
        if let Some(value) = line.strip_prefix("loc=") {
            country = value.trim();
        }
    }
    location_from_fields(ip, family, country, "", "")
}

fn parse_ipip(body: &str) -> Option<GeoLocation> {
    let value: Value = serde_json::from_str(body).ok()?;
    if value.get("ret").and_then(Value::as_str) != Some("ok") {
        return None;
    }
    let data = value.get("data")?;
    let ip = data.get("ip")?.as_str()?;
    let location = data.get("location")?.as_array()?;
    let country = location.first().and_then(Value::as_str).unwrap_or("");
    let city = location.get(2).and_then(Value::as_str).unwrap_or("");
    location_from_fields(ip, if ip.contains(':') { 6 } else { 4 }, "", country, city)
}

fn parse_custom(body: &str) -> Option<GeoLocation> {
    let value: Value = serde_json::from_str(body).ok()?;
    let ipv4 = value
        .get("ipv4")
        .and_then(Value::as_str)
        .filter(|ip| valid_ip_family(ip, 4))
        .map(str::to_string);
    let ipv6 = value
        .get("ipv6")
        .and_then(Value::as_str)
        .filter(|ip| valid_ip_family(ip, 6))
        .map(str::to_string);
    let generic = value.get("ip").and_then(Value::as_str).unwrap_or("");
    let (ipv4, ipv6) = if generic.contains(':') {
        (ipv4, ipv6.or_else(|| Some(generic.to_string())))
    } else {
        (
            ipv4.or_else(|| (!generic.is_empty()).then(|| generic.to_string())),
            ipv6,
        )
    };
    if ipv4.is_none() && ipv6.is_none() {
        return None;
    }
    Some(GeoLocation {
        ipv4,
        ipv6,
        country_code: text_field(&value, "country_code", 2).to_ascii_uppercase(),
        country: text_field(&value, "country", 80),
        city: text_field(&value, "city", 80),
        provider: String::new(),
    })
}

fn location_from_fields(
    ip: &str,
    family: u8,
    country_code: &str,
    country: &str,
    city: &str,
) -> Option<GeoLocation> {
    if !valid_ip_family(ip, family) {
        return None;
    }
    Some(GeoLocation {
        ipv4: (family == 4).then(|| ip.to_string()),
        ipv6: (family == 6).then(|| ip.to_ascii_lowercase()),
        country_code: country_code
            .trim()
            .chars()
            .take(2)
            .collect::<String>()
            .to_ascii_uppercase(),
        country: country.trim().chars().take(80).collect(),
        city: city.trim().chars().take(80).collect(),
        provider: String::new(),
    })
}

fn valid_ip_family(value: &str, family: u8) -> bool {
    value
        .parse::<std::net::IpAddr>()
        .map(|ip| {
            matches!(
                (family, ip),
                (4, std::net::IpAddr::V4(_)) | (6, std::net::IpAddr::V6(_))
            )
        })
        .unwrap_or(false)
}

fn text_field(value: &Value, key: &str, max: usize) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(max)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_provider_formats() {
        let ip_sb = parse_ip_sb(r#"{"ip":"203.0.113.8","country_code":"US","country":"United States","city":"Los Angeles"}"#, 4).unwrap();
        assert_eq!(ip_sb.ipv4.as_deref(), Some("203.0.113.8"));
        assert_eq!(ip_sb.city, "Los Angeles");

        let trace = parse_cloudflare_trace("ip=2001:db8::8\nloc=US\n", 6).unwrap();
        assert_eq!(trace.ipv6.as_deref(), Some("2001:db8::8"));
        assert_eq!(trace.country_code, "US");

        let ipip = parse_ipip(r#"{"ret":"ok","data":{"ip":"203.0.113.8","location":["中国","福建","龙岩","","移动"]}}"#).unwrap();
        assert_eq!(ipip.country, "中国");
        assert_eq!(ipip.city, "龙岩");
    }

    #[test]
    fn custom_format_supports_both_families() {
        let value = parse_custom(r#"{"ipv4":"203.0.113.8","ipv6":"2001:db8::8","country_code":"US","country":"美国","city":"洛杉矶"}"#).unwrap();
        assert_eq!(value.ipv4.as_deref(), Some("203.0.113.8"));
        assert_eq!(value.ipv6.as_deref(), Some("2001:db8::8"));
    }
}
