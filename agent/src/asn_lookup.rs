use std::collections::HashMap;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::Duration;

// Resolve the origin ASN of an IP through Team Cymru's DNS service
// (`<reversed-ip>.origin.asn.cymru.com` TXT). The Agent previously relied on
// traceroute `-A` (rarely available) or a small IP-prefix table, which made
// dedicated lines such as 9929/10099/CMIN2 collapse into 4837/CMI. DNS is
// already required by the installer, needs no external binary and returns
// authoritative ASN data for allocated addresses.
pub struct AsnResolver {
    servers: Vec<SocketAddr>,
    cache: HashMap<String, Option<u32>>,
}

impl AsnResolver {
    pub fn new() -> Self {
        Self {
            servers: system_nameservers(),
            cache: HashMap::new(),
        }
    }

    pub fn resolve(&mut self, ip: &str) -> Option<u32> {
        let key = ip.trim().to_string();
        if let Some(value) = self.cache.get(&key) {
            return *value;
        }
        let value = match key.parse::<Ipv4Addr>() {
            Ok(address) if !is_non_public(address) => {
                let reversed = address.octets();
                let name = format!(
                    "{}.{}.{}.{}.origin.asn.cymru.com",
                    reversed[3], reversed[2], reversed[1], reversed[0]
                );
                self.query_txt_asn(&name)
            }
            _ => None,
        };
        self.cache.insert(key, value);
        value
    }

    fn query_txt_asn(&self, name: &str) -> Option<u32> {
        let (query, id) = build_query(name)?;
        for server in &self.servers {
            let Ok(socket) = UdpSocket::bind("0.0.0.0:0") else {
                continue;
            };
            let _ = socket.set_read_timeout(Some(Duration::from_secs(2)));
            if socket.connect(server).is_err() || socket.send(&query).is_err() {
                continue;
            }
            let mut buffer = [0u8; 1500];
            if let Ok(size) = socket.recv(&mut buffer) {
                if let Some(asn) = parse_txt_asn(&buffer[..size], id) {
                    return Some(asn);
                }
            }
        }
        None
    }
}

fn is_non_public(address: Ipv4Addr) -> bool {
    let octets = address.octets();
    address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_unspecified()
        || address.is_multicast()
        || address.is_broadcast()
        || octets[0] == 0
        || octets[0] >= 240
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 2)
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
        || (octets[0] == 203 && octets[1] == 0 && octets[2] == 113)
}

fn system_nameservers() -> Vec<SocketAddr> {
    let mut servers = Vec::new();
    if let Ok(contents) = fs::read_to_string("/etc/resolv.conf") {
        for line in contents.lines() {
            let trimmed = line.trim();
            let Some(rest) = trimmed.strip_prefix("nameserver") else {
                continue;
            };
            let value = rest.split_whitespace().next().unwrap_or("");
            if let Ok(address) = value.parse::<Ipv4Addr>() {
                servers.push(SocketAddr::from((address, 53)));
            }
        }
    }
    for fallback in ["1.1.1.1", "8.8.8.8", "223.5.5.5"] {
        if let Ok(address) = fallback.parse::<Ipv4Addr>() {
            let addr = SocketAddr::from((address, 53));
            if !servers.contains(&addr) {
                servers.push(addr);
            }
        }
    }
    servers
}

fn build_query(name: &str) -> Option<(Vec<u8>, u16)> {
    let id = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos()
        & 0xffff) as u16;
    let mut packet = Vec::with_capacity(64 + name.len());
    packet.extend_from_slice(&id.to_be_bytes());
    packet.extend_from_slice(&[0x01, 0x00]);
    packet.extend_from_slice(&1u16.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    packet.extend_from_slice(&0u16.to_be_bytes());
    for label in name.split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        packet.push(label.len() as u8);
        packet.extend_from_slice(label.as_bytes());
    }
    packet.push(0);
    packet.extend_from_slice(&16u16.to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes());
    Some((packet, id))
}

fn skip_name(packet: &[u8], mut offset: usize) -> Option<usize> {
    loop {
        let length = *packet.get(offset)? as usize;
        if length == 0 {
            return Some(offset + 1);
        }
        if length & 0xc0 == 0xc0 {
            return Some(offset + 2);
        }
        offset += 1 + length;
        if offset > packet.len() {
            return None;
        }
    }
}

fn parse_txt_asn(packet: &[u8], expected_id: u16) -> Option<u32> {
    if packet.len() < 12 {
        return None;
    }
    let id = u16::from_be_bytes([packet[0], packet[1]]);
    if id != expected_id || packet[2] & 0x80 == 0 {
        return None;
    }
    let qdcount = u16::from_be_bytes([packet[4], packet[5]]) as usize;
    let ancount = u16::from_be_bytes([packet[6], packet[7]]) as usize;
    let mut offset = 12usize;
    for _ in 0..qdcount {
        offset = skip_name(packet, offset)?;
        offset = offset.checked_add(4)?;
        if offset > packet.len() {
            return None;
        }
    }
    for _ in 0..ancount {
        offset = skip_name(packet, offset)?;
        if offset + 10 > packet.len() {
            return None;
        }
        let record_type = u16::from_be_bytes([packet[offset], packet[offset + 1]]);
        let rdlength = u16::from_be_bytes([packet[offset + 8], packet[offset + 9]]) as usize;
        offset += 10;
        if offset + rdlength > packet.len() {
            return None;
        }
        if record_type == 16 {
            let mut text = String::new();
            let mut cursor = offset;
            let end = offset + rdlength;
            while cursor < end {
                let length = packet[cursor] as usize;
                cursor += 1;
                if cursor + length > end {
                    break;
                }
                text.push_str(&String::from_utf8_lossy(&packet[cursor..cursor + length]));
                cursor += length;
            }
            if let Some(asn) = parse_asn_field(&text) {
                return Some(asn);
            }
        }
        offset += rdlength;
    }
    None
}

fn parse_asn_field(text: &str) -> Option<u32> {
    let first = text.split('|').next()?.trim();
    first.parse::<u32>().ok().filter(|value| *value > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synthetic_response(id: u16, txt: &str) -> Vec<u8> {
        let mut packet = Vec::new();
        packet.extend_from_slice(&id.to_be_bytes());
        packet.extend_from_slice(&[0x81, 0x80]);
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet.extend_from_slice(&0u16.to_be_bytes());
        packet.extend_from_slice(&0u16.to_be_bytes());
        packet.push(1);
        packet.push(b'x');
        packet.push(0);
        packet.extend_from_slice(&16u16.to_be_bytes());
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet.extend_from_slice(&[0xc0, 0x0c]);
        packet.extend_from_slice(&16u16.to_be_bytes());
        packet.extend_from_slice(&1u16.to_be_bytes());
        packet.extend_from_slice(&60u32.to_be_bytes());
        let bytes = txt.as_bytes();
        packet.extend_from_slice(&((bytes.len() + 1) as u16).to_be_bytes());
        packet.push(bytes.len() as u8);
        packet.extend_from_slice(bytes);
        packet
    }

    #[test]
    fn parses_cymru_txt_records() {
        let packet = synthetic_response(7, "9929 | 210.78.0.0/16 | CN | apnic | 2004-01-01");
        assert_eq!(parse_txt_asn(&packet, 7), Some(9929));
        assert_eq!(parse_txt_asn(&packet, 8), None);
    }

    #[test]
    fn builds_well_formed_queries() {
        let (packet, id) = build_query("1.0.0.127.origin.asn.cymru.com").unwrap();
        assert_eq!(u16::from_be_bytes([packet[0], packet[1]]), id);
        assert_eq!(&packet[2..4], &[0x01, 0x00]);
        assert!(packet.ends_with(&[0, 16, 0, 1]));
    }

    #[test]
    fn skips_private_addresses() {
        let mut resolver = AsnResolver {
            servers: Vec::new(),
            cache: HashMap::new(),
        };
        assert_eq!(resolver.resolve("10.0.0.1"), None);
        assert_eq!(resolver.resolve("192.168.1.1"), None);
        assert_eq!(resolver.resolve("127.0.0.1"), None);
    }
}
