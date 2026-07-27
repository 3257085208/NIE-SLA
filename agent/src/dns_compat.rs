use anyhow::{anyhow, Result};
use std::collections::BTreeSet;
use std::net::{IpAddr, ToSocketAddrs};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QueryType {
    A,
    Aaaa,
    Unsupported,
}

pub(crate) fn run(args: &[String]) -> Result<()> {
    let (tool, tool_args) = args
        .split_first()
        .ok_or_else(|| anyhow!("DNS compatibility tool is required"))?;
    match tool.as_str() {
        "dig" => print!("{}", dig_output(tool_args, resolve_host)?),
        "nslookup" => print!("{}", nslookup_output(tool_args, resolve_host)?),
        _ => return Err(anyhow!("unsupported DNS compatibility tool")),
    }
    Ok(())
}

fn resolve_host(host: &str) -> Vec<IpAddr> {
    (host, 0)
        .to_socket_addrs()
        .map(|addresses| addresses.map(|address| address.ip()).collect())
        .unwrap_or_default()
}

fn dig_output<F>(args: &[String], resolve: F) -> Result<String>
where
    F: FnOnce(&str) -> Vec<IpAddr>,
{
    if args.iter().any(|arg| arg == "-v" || arg == "-V") {
        return Ok("DiG NIE-SLA compatibility resolver\n".to_string());
    }
    let short = args.iter().any(|arg| arg == "+short");
    let query_type = args
        .iter()
        .find_map(|arg| match arg.to_ascii_uppercase().as_str() {
            "A" => Some(QueryType::A),
            "AAAA" => Some(QueryType::Aaaa),
            "MX" | "TXT" | "CNAME" | "NS" | "PTR" => Some(QueryType::Unsupported),
            _ => None,
        })
        .unwrap_or(QueryType::A);
    let host = args
        .iter()
        .rev()
        .find(|arg| !arg.starts_with('+') && !arg.starts_with('-') && !is_query_type(arg))
        .ok_or_else(|| anyhow!("DNS query host is required"))?;
    validate_host(host)?;
    let addresses = filter_addresses(resolve(host), query_type);
    if short {
        return Ok(addresses
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + if addresses.is_empty() { "" } else { "\n" });
    }
    Ok(format!(
        ";; ->>HEADER<<- opcode: QUERY, status: {}, id: 1\n;; flags: qr rd ra; QUERY: 1, ANSWER: {}, AUTHORITY: 0, ADDITIONAL: 0\n",
        if addresses.is_empty() { "NXDOMAIN" } else { "NOERROR" },
        addresses.len()
    ))
}

fn nslookup_output<F>(args: &[String], resolve: F) -> Result<String>
where
    F: FnOnce(&str) -> Vec<IpAddr>,
{
    let host = args
        .iter()
        .find(|arg| !arg.starts_with('-'))
        .ok_or_else(|| anyhow!("DNS query host is required"))?;
    validate_host(host)?;
    let addresses = unique_addresses(resolve(host));
    let mut output = "Server: 127.0.0.1\nAddress: 127.0.0.1#53\n".to_string();
    for address in addresses {
        output.push_str(&format!("Name: {}\nAddress: {}\n", host, address));
    }
    Ok(output)
}

fn filter_addresses(addresses: Vec<IpAddr>, query_type: QueryType) -> Vec<IpAddr> {
    unique_addresses(addresses)
        .into_iter()
        .filter(|address| match query_type {
            QueryType::A => address.is_ipv4(),
            QueryType::Aaaa => address.is_ipv6(),
            QueryType::Unsupported => false,
        })
        .collect()
}

fn unique_addresses(addresses: Vec<IpAddr>) -> Vec<IpAddr> {
    addresses
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn is_query_type(value: &str) -> bool {
    matches!(
        value.to_ascii_uppercase().as_str(),
        "A" | "AAAA" | "MX" | "TXT" | "CNAME" | "NS" | "PTR"
    )
}

fn validate_host(host: &str) -> Result<()> {
    if host.is_empty()
        || host.len() > 253
        || host.starts_with('.')
        || host.ends_with('.')
        || host
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && byte != b'.' && byte != b'-')
        || host.split('.').any(|label| {
            label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
        })
    {
        return Err(anyhow!("invalid DNS query host"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    fn answer_count(output: &str) -> usize {
        output
            .split("ANSWER: ")
            .nth(1)
            .and_then(|value| value.split(',').next())
            .and_then(|value| value.parse().ok())
            .unwrap_or(0)
    }

    #[test]
    fn ordinary_domain_reports_real_answers_for_native_detection() {
        let output = dig_output(&strings(&["example.com"]), |_| {
            vec![
                Ipv4Addr::new(192, 0, 2, 1).into(),
                Ipv4Addr::new(192, 0, 2, 2).into(),
                Ipv4Addr::new(192, 0, 2, 3).into(),
            ]
        })
        .unwrap();
        assert_eq!(answer_count(&output), 3);
    }

    #[test]
    fn unresolved_random_domain_is_native_but_wildcard_resolution_is_dns() {
        let native = dig_output(&strings(&["test123.example.com"]), |_| vec![]).unwrap();
        let dns = dig_output(&strings(&["test123.example.com"]), |_| {
            vec![Ipv4Addr::new(203, 0, 113, 8).into()]
        })
        .unwrap();
        assert_eq!(answer_count(&native), 0);
        assert_eq!(answer_count(&dns), 1);
    }

    #[test]
    fn short_queries_filter_address_family() {
        let output = dig_output(&strings(&["AAAA", "example.com", "+short"]), |_| {
            vec![
                Ipv4Addr::new(192, 0, 2, 1).into(),
                Ipv6Addr::LOCALHOST.into(),
            ]
        })
        .unwrap();
        assert_eq!(output, "::1\n");
    }

    #[test]
    fn nslookup_shape_matches_upstream_parser() {
        let output = nslookup_output(&strings(&["example.com"]), |_| {
            vec![Ipv4Addr::new(192, 0, 2, 1).into()]
        })
        .unwrap();
        let fields = output.split_whitespace().collect::<Vec<_>>();
        let name_index = fields.iter().position(|field| *field == "Name:").unwrap();
        assert_eq!(fields[name_index + 3], "192.0.2.1");
        assert_eq!(fields[1], "127.0.0.1");
    }

    #[test]
    fn rejects_shell_syntax_and_unsupported_tools() {
        assert!(dig_output(&strings(&["example.com;id"]), |_| vec![]).is_err());
        assert!(run(&strings(&["curl", "example.com"])).is_err());
    }
}
