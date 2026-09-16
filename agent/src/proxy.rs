use std::pin::Pin;
use std::task::{Context, Poll};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use meow_common::{Metadata, ProxyAdapter, ProxyConn};
use meow_proxy::{
    AnytlsAdapter, HttpAdapter, Hy2Adapter, Hy2Obfs, Hy2Options, ShadowsocksAdapter, SnellAdapter,
    SnellObfs, SnellVersion, Socks5Adapter, TransportChain, TrojanAdapter, VlessAdapter, VlessFlow,
    VmessAdapter,
};
use meow_transport::grpc::{GrpcConfig, GrpcLayer};
use meow_transport::h2::{H2Config, H2Layer};
use meow_transport::httpupgrade::{HttpUpgradeConfig, HttpUpgradeLayer};
use meow_transport::tls::{RealityConfig, TlsConfig, TlsLayer};
use meow_transport::ws::{WsConfig, WsLayer};
use meow_transport::{Stream as TransportStream, Transport};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

const MAX_PROXY_CONCURRENCY: usize = 16;
const MAX_PROXY_TARGETS: usize = 100;

#[derive(Clone, Debug, PartialEq, Eq)]
enum ProxyProtocol {
    Socks5,
    Http,
    Shadowsocks,
    Vless,
    Vmess,
    Trojan,
    Hysteria2,
    Snell,
    Anytls,
}

impl ProxyProtocol {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "socks5" => Some(Self::Socks5),
            "http" | "https" => Some(Self::Http),
            "ss" | "shadowsocks" => Some(Self::Shadowsocks),
            "vless" => Some(Self::Vless),
            "vmess" => Some(Self::Vmess),
            "trojan" => Some(Self::Trojan),
            "hysteria2" | "hy2" => Some(Self::Hysteria2),
            "snell" => Some(Self::Snell),
            "anytls" => Some(Self::Anytls),
            _ => None,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::Socks5 => "socks5",
            Self::Http => "http",
            Self::Shadowsocks => "ss",
            Self::Vless => "vless",
            Self::Vmess => "vmess",
            Self::Trojan => "trojan",
            Self::Hysteria2 => "hysteria2",
            Self::Snell => "snell",
            Self::Anytls => "anytls",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ProxyTransport {
    Tcp,
    Tls,
    Ws,
    TlsWs,
    Grpc,
    TlsGrpc,
    H2,
    TlsH2,
    HttpUpgrade,
    TlsHttpUpgrade,
    Quic,
}

impl ProxyTransport {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "tcp" => Some(Self::Tcp),
            "tls" => Some(Self::Tls),
            "ws" => Some(Self::Ws),
            "tls-ws" => Some(Self::TlsWs),
            "grpc" => Some(Self::Grpc),
            "tls-grpc" => Some(Self::TlsGrpc),
            "h2" => Some(Self::H2),
            "tls-h2" => Some(Self::TlsH2),
            "httpupgrade" => Some(Self::HttpUpgrade),
            "tls-httpupgrade" => Some(Self::TlsHttpUpgrade),
            "quic" => Some(Self::Quic),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ProxyTarget {
    id: String,
    name: String,
    protocol: ProxyProtocol,
    server: String,
    port: u16,
    transport: ProxyTransport,
    sni: String,
    ws_path: String,
    ws_host: String,
    timeout_ms: u64,
    enabled: bool,
    uuid: Option<[u8; 16]>,
    username: String,
    password: String,
    cipher: String,
    plugin: String,
    plugin_opts: String,
    flow: String,
    grpc_service_name: String,
    h2_path: String,
    http_upgrade_path: String,
    skip_cert_verify: bool,
    obfs: String,
    obfs_password: String,
    obfs_host: String,
    snell_version: String,
    fingerprint: String,
    alpn: String,
    vless_security: String,
    reality_public_key: String,
    reality_short_id: String,
    vmess_security: String,
    vmess_alter_id: u32,
}

#[derive(Clone, Debug)]
pub(crate) struct ProxyCheckResult {
    pub(crate) target_id: String,
    pub(crate) name: String,
    pub(crate) protocol: String,
    pub(crate) ts: i64,
    pub(crate) latency_ms: Option<u128>,
    pub(crate) handshake_ms: Option<u128>,
    pub(crate) first_byte_ms: Option<u128>,
    pub(crate) total_ms: Option<u128>,
    pub(crate) ok: bool,
    pub(crate) stage: String,
    pub(crate) error: Option<String>,
}

impl ProxyTarget {
    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub(crate) fn from_json(value: &Value) -> Result<Self, String> {
        let protocol_name = value
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let protocol = ProxyProtocol::parse(protocol_name)
            .ok_or_else(|| "unsupported proxy protocol".to_string())?;
        let transport_name = value
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("tcp");
        let transport = ProxyTransport::parse(transport_name)
            .ok_or_else(|| "unsupported proxy transport".to_string())?;
        match protocol {
            ProxyProtocol::Socks5 | ProxyProtocol::Http | ProxyProtocol::Shadowsocks
                if !matches!(transport, ProxyTransport::Tcp | ProxyTransport::Tls) =>
            {
                return Err("this proxy protocol only supports tcp or tls transport".into());
            }
            ProxyProtocol::Hysteria2 if transport != ProxyTransport::Quic => {
                return Err("hysteria2 transport must be quic".into());
            }
            ProxyProtocol::Trojan | ProxyProtocol::Anytls
                if !matches!(transport, ProxyTransport::Tcp | ProxyTransport::Tls) =>
            {
                return Err("this proxy protocol currently supports direct tls only".into());
            }
            ProxyProtocol::Snell
                if !matches!(transport, ProxyTransport::Tcp | ProxyTransport::Tls) =>
            {
                return Err("snell transport must be tcp or tls".into());
            }
            _ => {}
        }
        let server = value
            .get("server")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let port = value
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|value| u16::try_from(value).ok())
            .ok_or_else(|| "invalid proxy port".to_string())?;
        if server.is_empty() || port == 0 {
            return Err("invalid proxy endpoint".into());
        }
        let secret = value
            .get("secret")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let uuid = match protocol {
            ProxyProtocol::Vless | ProxyProtocol::Vmess => Some(parse_uuid(
                secret
                    .get("uuid")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )?),
            _ => None,
        };
        let timeout_ms = value
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .unwrap_or(5000)
            .clamp(1000, 15_000);
        let sni = value
            .get("sni")
            .and_then(Value::as_str)
            .unwrap_or(&server)
            .trim()
            .to_string();
        let ws_path = value
            .get("ws_path")
            .and_then(Value::as_str)
            .unwrap_or("/")
            .trim()
            .to_string();
        let ws_host = value
            .get("ws_host")
            .and_then(Value::as_str)
            .unwrap_or(&sni)
            .trim()
            .to_string();
        if !ws_path.starts_with('/') || ws_path.contains(['\r', '\n']) {
            return Err("invalid websocket path".into());
        }
        if [server.as_str(), sni.as_str(), ws_host.as_str()]
            .iter()
            .any(|value| {
                value.is_empty() || value.chars().any(|character| character.is_whitespace())
            })
        {
            return Err("invalid proxy host".into());
        }
        let security = secret
            .get("security")
            .and_then(Value::as_str)
            .unwrap_or("auto")
            .trim()
            .to_ascii_lowercase();
        let vmess_alter_id = secret
            .get("alter_id")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u32::MAX as u64) as u32;
        let cipher = secret_string(&secret, "cipher");
        let plugin = secret_string(&secret, "plugin");
        let plugin_opts = secret_string(&secret, "plugin_opts");
        let flow = secret_string(&secret, "flow");
        let grpc_service_name = secret_string(&secret, "grpc_service_name");
        let h2_path = secret_string(&secret, "h2_path");
        let http_upgrade_path = secret_string(&secret, "http_upgrade_path");
        let skip_cert_verify =
            secret_bool(&secret, "skip_cert_verify") || secret_bool(&secret, "insecure");
        let obfs = secret_string(&secret, "obfs");
        let obfs_password = secret_string(&secret, "obfs_password");
        let obfs_host = secret_string(&secret, "obfs_host");
        let snell_version = secret_string(&secret, "snell_version");
        let fingerprint = secret_string(&secret, "fingerprint");
        let alpn = secret_string(&secret, "alpn");
        if matches!(protocol, ProxyProtocol::Shadowsocks)
            && (cipher.is_empty() || secret_string(&secret, "password").is_empty())
        {
            return Err("shadowsocks cipher and password are required".into());
        }
        if matches!(
            protocol,
            ProxyProtocol::Trojan
                | ProxyProtocol::Hysteria2
                | ProxyProtocol::Snell
                | ProxyProtocol::Anytls
        ) && secret_string(&secret, "password").is_empty()
        {
            return Err("proxy password is required".into());
        }
        Ok(Self {
            id: bounded_string(value.get("id").and_then(Value::as_str), 128),
            name: bounded_string(value.get("name").and_then(Value::as_str), 96),
            protocol,
            server,
            port,
            transport,
            sni,
            ws_path,
            ws_host,
            timeout_ms,
            enabled: value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            uuid,
            username: bounded_string(secret.get("username").and_then(Value::as_str), 256),
            password: bounded_string(secret.get("password").and_then(Value::as_str), 512),
            cipher,
            plugin,
            plugin_opts,
            flow,
            grpc_service_name,
            h2_path,
            http_upgrade_path,
            skip_cert_verify,
            obfs,
            obfs_password,
            obfs_host,
            snell_version,
            fingerprint,
            alpn,
            vless_security: security.clone(),
            reality_public_key: secret_string(&secret, "reality_public_key"),
            reality_short_id: secret_string(&secret, "reality_short_id"),
            vmess_security: security,
            vmess_alter_id,
        })
    }
}

pub(crate) fn run_proxy_checks(
    targets: &[ProxyTarget],
    canary_host: &str,
    canary_port: u16,
) -> Vec<ProxyCheckResult> {
    let selected: Vec<_> = targets
        .iter()
        .filter(|target| target.enabled)
        .take(MAX_PROXY_TARGETS)
        .cloned()
        .collect();
    let mut results = Vec::with_capacity(selected.len());
    for batch in selected.chunks(MAX_PROXY_CONCURRENCY) {
        let handles: Vec<_> = batch
            .iter()
            .cloned()
            .map(|target| {
                let canary_host = canary_host.to_string();
                let fallback_target = target.clone();
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                    thread::spawn(move || probe_proxy_target(&target, &canary_host, canary_port))
                }))
                .map_err(|_| fallback_target)
            })
            .collect();
        for handle in handles {
            match handle {
                Ok(handle) => results.extend(handle.join().ok()),
                Err(target) => results.push(probe_proxy_target(&target, canary_host, canary_port)),
            }
        }
    }
    results.sort_by(|left, right| left.target_id.cmp(&right.target_id));
    results
}

fn probe_proxy_target(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> ProxyCheckResult {
    let started = Instant::now();
    let outcome = probe_proxy_target_inner(target, canary_host, canary_port);
    match outcome {
        Ok(timing) => ProxyCheckResult {
            target_id: target.id.clone(),
            name: target.name.clone(),
            protocol: target.protocol.as_str().to_string(),
            ts: super::now_sec(),
            latency_ms: Some(timing.total_ms),
            handshake_ms: Some(timing.handshake_ms),
            first_byte_ms: Some(timing.first_byte_ms),
            total_ms: Some(timing.total_ms),
            ok: true,
            stage: "canary".into(),
            error: None,
        },
        Err(error) => ProxyCheckResult {
            target_id: target.id.clone(),
            name: target.name.clone(),
            protocol: target.protocol.as_str().to_string(),
            ts: super::now_sec(),
            latency_ms: None,
            handshake_ms: None,
            first_byte_ms: None,
            total_ms: Some(started.elapsed().as_millis()),
            ok: false,
            stage: error.stage.into(),
            error: Some(error.code.into()),
        },
    }
}

#[derive(Clone, Copy, Debug)]
struct ProbeError {
    stage: &'static str,
    code: &'static str,
}

#[derive(Clone, Copy, Debug)]
struct ProbeTiming {
    handshake_ms: u128,
    first_byte_ms: u128,
    total_ms: u128,
}

fn probe_proxy_target_inner(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    if canary_host.trim().is_empty()
        || canary_host
            .chars()
            .any(|character| character.is_whitespace())
        || canary_host.contains(['/', '\\', '\r', '\n'])
        || canary_port == 0
    {
        return Err(ProbeError {
            stage: "config",
            code: "invalid_config",
        });
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|_| ProbeError {
            stage: "runtime",
            code: "runtime_failed",
        })?;
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_millis(target.timeout_ms), async {
            match target.protocol {
                ProxyProtocol::Socks5 => probe_socks5(target, canary_host, canary_port).await,
                ProxyProtocol::Http => probe_http(target, canary_host, canary_port).await,
                ProxyProtocol::Shadowsocks => {
                    probe_shadowsocks(target, canary_host, canary_port).await
                }
                ProxyProtocol::Vless => probe_vless(target, canary_host, canary_port).await,
                ProxyProtocol::Vmess => probe_vmess(target, canary_host, canary_port).await,
                ProxyProtocol::Trojan => probe_trojan(target, canary_host, canary_port).await,
                ProxyProtocol::Hysteria2 => probe_hysteria2(target, canary_host, canary_port).await,
                ProxyProtocol::Snell => probe_snell(target, canary_host, canary_port).await,
                ProxyProtocol::Anytls => probe_anytls(target, canary_host, canary_port).await,
            }
        })
        .await
        .map_err(|_| ProbeError {
            stage: "connect",
            code: "timeout",
        })?
    })
}

async fn probe_socks5(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    let auth = if target.username.is_empty() && target.password.is_empty() {
        None
    } else {
        Some((target.username.clone(), target.password.clone()))
    };
    let adapter = Socks5Adapter::new(
        "nie-sla-proxy-check",
        &target.server,
        target.port,
        auth,
        matches!(target.transport, ProxyTransport::Tls),
        target.skip_cert_verify,
    );
    probe_adapter(&adapter, canary_host, canary_port).await
}

async fn probe_http(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    let auth = if target.username.is_empty() && target.password.is_empty() {
        None
    } else {
        Some((target.username.clone(), target.password.clone()))
    };
    let adapter = HttpAdapter::new(
        "nie-sla-proxy-check",
        &target.server,
        target.port,
        auth,
        matches!(target.transport, ProxyTransport::Tls),
        target.skip_cert_verify,
        Vec::new(),
    );
    probe_adapter(&adapter, canary_host, canary_port).await
}

async fn probe_shadowsocks(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    let adapter = ShadowsocksAdapter::new(
        "nie-sla-proxy-check",
        &target.server,
        target.port,
        &target.password,
        &target.cipher,
        false,
        (!target.plugin.is_empty()).then_some(target.plugin.as_str()),
        (!target.plugin_opts.is_empty()).then_some(target.plugin_opts.as_str()),
    )
    .map_err(|error| map_adapter_error(&error.to_string(), "config"))?;
    probe_adapter(&adapter, canary_host, canary_port).await
}

async fn probe_vless(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    let uuid = target.uuid.ok_or(ProbeError {
        stage: "config",
        code: "invalid_config",
    })?;
    let chain = build_transport_chain(target)?;
    let flow = match target.flow.to_ascii_lowercase().as_str() {
        "" => None,
        "xtls-rprx-vision" => Some(VlessFlow::XtlsRprxVision),
        _ => {
            return Err(ProbeError {
                stage: "config",
                code: "unsupported",
            })
        }
    };
    let adapter = VlessAdapter::new(
        "nie-sla-proxy-check",
        &target.server,
        target.port,
        uuid,
        flow,
        false,
        chain,
    );
    probe_adapter(&adapter, canary_host, canary_port).await
}

async fn probe_vmess(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    if target.vmess_alter_id > 0 {
        return Err(ProbeError {
            stage: "config",
            code: "unsupported",
        });
    }
    let uuid = target.uuid.ok_or(ProbeError {
        stage: "config",
        code: "invalid_config",
    })?;
    let security = match target.vmess_security.as_str() {
        "auto" => meow_proxy::vmess::header::auto_security(),
        "aes-128-gcm" => meow_proxy::vmess::Security::Aes128Gcm,
        "chacha20-poly1305" => meow_proxy::vmess::Security::ChaCha20Poly1305,
        "none" => meow_proxy::vmess::Security::None,
        _ => {
            return Err(ProbeError {
                stage: "config",
                code: "invalid_config",
            })
        }
    };
    let chain = build_transport_chain(target)?;
    let adapter = VmessAdapter::new(
        "nie-sla-proxy-check",
        &target.server,
        target.port,
        uuid,
        security,
        false,
        chain,
    );
    probe_adapter(&adapter, canary_host, canary_port).await
}

async fn probe_trojan(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    let adapter = TrojanAdapter::new(
        "nie-sla-proxy-check",
        &target.server,
        target.port,
        &target.password,
        &target.sni,
        target.skip_cert_verify,
        false,
    );
    probe_adapter(&adapter, canary_host, canary_port).await
}

async fn probe_hysteria2(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    let obfs = match target.obfs.to_ascii_lowercase().as_str() {
        "" => None,
        "salamander" => Some(Hy2Obfs::Salamander),
        _ => {
            return Err(ProbeError {
                stage: "config",
                code: "unsupported",
            })
        }
    };
    let adapter = Hy2Adapter::new(Hy2Options {
        name: "nie-sla-proxy-check".into(),
        server: target.server.clone(),
        port: target.port,
        password: target.password.clone(),
        sni: (!target.sni.is_empty()).then_some(target.sni.clone()),
        skip_cert_verify: target.skip_cert_verify,
        udp: false,
        up_bps: 0,
        down_bps: 0,
        obfs,
        obfs_password: (!target.obfs_password.is_empty()).then_some(target.obfs_password.clone()),
        ports: None,
        hop_interval: None,
        fingerprint: (!target.fingerprint.is_empty()).then_some(target.fingerprint.clone()),
        fast_open: false,
    })
    .map_err(|error| map_adapter_error(&error, "config"))?;
    probe_adapter(&adapter, canary_host, canary_port).await
}

async fn probe_snell(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    let version = match target.snell_version.to_ascii_lowercase().as_str() {
        "" | "v4" => SnellVersion::V4,
        "v3" => SnellVersion::V3,
        "v5" => SnellVersion::V5,
        _ => {
            return Err(ProbeError {
                stage: "config",
                code: "invalid_config",
            })
        }
    };
    let obfs = match target.obfs.to_ascii_lowercase().as_str() {
        "" => SnellObfs::None,
        "http" => SnellObfs::Http {
            host: if target.obfs_host.is_empty() {
                target.sni.clone()
            } else {
                target.obfs_host.clone()
            },
        },
        "tls" => SnellObfs::Tls {
            server: if target.obfs_host.is_empty() {
                target.sni.clone()
            } else {
                target.obfs_host.clone()
            },
        },
        _ => {
            return Err(ProbeError {
                stage: "config",
                code: "unsupported",
            })
        }
    };
    let adapter = SnellAdapter::new(
        "nie-sla-proxy-check",
        &target.server,
        target.port,
        &target.password,
        obfs,
        version,
        false,
        false,
    )
    .map_err(|error| map_adapter_error(&error.to_string(), "config"))?;
    probe_adapter(&adapter, canary_host, canary_port).await
}

async fn probe_anytls(
    target: &ProxyTarget,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    let adapter = AnytlsAdapter::new(
        "nie-sla-proxy-check",
        &target.server,
        target.port,
        &target.password,
        (!target.sni.is_empty()).then_some(target.sni.as_str()),
        target.skip_cert_verify,
        false,
    )
    .map_err(|error| map_adapter_error(&error, "config"))?;
    probe_adapter(&adapter, canary_host, canary_port).await
}

async fn probe_adapter(
    adapter: &dyn ProxyAdapter,
    canary_host: &str,
    canary_port: u16,
) -> Result<ProbeTiming, ProbeError> {
    let handshake_started = Instant::now();
    let metadata = canary_metadata(canary_host, canary_port);
    let mut connection = adapter
        .dial_tcp(&metadata)
        .await
        .map_err(|error| map_adapter_error(&error.to_string(), "handshake"))?;
    let handshake_ms = handshake_started.elapsed().as_millis();
    let first_byte_ms = if canary_port == 443 {
        verify_https_canary(connection, canary_host).await?
    } else {
        verify_canary(connection.as_mut(), canary_host, Instant::now()).await?
    };
    Ok(ProbeTiming {
        handshake_ms,
        first_byte_ms,
        total_ms: handshake_started.elapsed().as_millis(),
    })
}

struct ProxyStream(Box<dyn ProxyConn>);

impl AsyncRead for ProxyStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.0).poll_read(context, buffer)
    }
}

impl AsyncWrite for ProxyStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut *self.0).poll_write(context, buffer)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.0).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.0).poll_shutdown(context)
    }
}

async fn verify_https_canary(
    connection: Box<dyn ProxyConn>,
    canary_host: &str,
) -> Result<u128, ProbeError> {
    let started = Instant::now();
    let tls_config = TlsConfig::new(canary_host);
    let tls = TlsLayer::new(&tls_config).map_err(|_| ProbeError {
        stage: "canary",
        code: "canary_failed",
    })?;
    let stream: Box<dyn TransportStream> = Box::new(ProxyStream(connection));
    let mut tls_connection = tls.connect(stream).await.map_err(|_| ProbeError {
        stage: "canary",
        code: "canary_failed",
    })?;
    verify_canary(tls_connection.as_mut(), canary_host, started).await
}

fn build_transport_chain(target: &ProxyTarget) -> Result<TransportChain, ProbeError> {
    let mut chain = TransportChain::empty();
    let reality = matches!(target.protocol, ProxyProtocol::Vless)
        && target.vless_security.eq_ignore_ascii_case("reality");
    if matches!(
        target.transport,
        ProxyTransport::Tls
            | ProxyTransport::TlsWs
            | ProxyTransport::TlsGrpc
            | ProxyTransport::TlsH2
            | ProxyTransport::TlsHttpUpgrade
    ) || reality
    {
        let mut tls_config = TlsConfig::new(if target.sni.is_empty() {
            &target.server
        } else {
            &target.sni
        });
        tls_config.skip_cert_verify = target.skip_cert_verify;
        if !target.alpn.is_empty() {
            tls_config.alpn = target
                .alpn
                .split(',')
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .collect();
        }
        if !target.fingerprint.is_empty() {
            tls_config.fingerprint = Some(target.fingerprint.clone());
        }
        if reality {
            let public_key = if target.reality_public_key.is_empty() {
                return Err(ProbeError {
                    stage: "config",
                    code: "unsupported",
                });
            } else {
                parse_reality_public_key(&target.reality_public_key).ok_or(ProbeError {
                    stage: "config",
                    code: "invalid_config",
                })?
            };
            let short_id = parse_reality_short_id(&target.reality_short_id).ok_or(ProbeError {
                stage: "config",
                code: "invalid_config",
            })?;
            tls_config.reality = Some(RealityConfig {
                public_key,
                short_id,
                support_x25519_mlkem768: false,
            });
        }
        let layer = TlsLayer::new(&tls_config).map_err(|_| ProbeError {
            stage: "config",
            code: "invalid_config",
        })?;
        chain.push(Box::new(layer));
    }
    if matches!(target.transport, ProxyTransport::Ws | ProxyTransport::TlsWs) {
        let config = WsConfig {
            path: if target.ws_path.is_empty() {
                "/".into()
            } else {
                target.ws_path.clone()
            },
            host_header: Some(if target.ws_host.is_empty() {
                target.server.clone()
            } else {
                target.ws_host.clone()
            }),
            ..WsConfig::default()
        };
        let layer = WsLayer::new(config).map_err(|_| ProbeError {
            stage: "config",
            code: "invalid_config",
        })?;
        chain.push(Box::new(layer));
    }
    match target.transport {
        ProxyTransport::Grpc | ProxyTransport::TlsGrpc => {
            chain.push(Box::new(GrpcLayer::new(GrpcConfig {
                service_name: if target.grpc_service_name.is_empty() {
                    "GunService".into()
                } else {
                    target.grpc_service_name.clone()
                },
                authority: if target.ws_host.is_empty() {
                    target.server.clone()
                } else {
                    target.ws_host.clone()
                },
            })))
        }
        ProxyTransport::H2 | ProxyTransport::TlsH2 => {
            chain.push(Box::new(H2Layer::new(H2Config {
                path: if target.h2_path.is_empty() {
                    "/".into()
                } else {
                    target.h2_path.clone()
                },
                hosts: vec![if target.ws_host.is_empty() {
                    target.server.clone()
                } else {
                    target.ws_host.clone()
                }],
            })))
        }
        ProxyTransport::HttpUpgrade | ProxyTransport::TlsHttpUpgrade => {
            chain.push(Box::new(HttpUpgradeLayer::new(HttpUpgradeConfig {
                path: if target.http_upgrade_path.is_empty() {
                    target.ws_path.clone()
                } else {
                    target.http_upgrade_path.clone()
                },
                host_header: Some(if target.ws_host.is_empty() {
                    target.server.clone()
                } else {
                    target.ws_host.clone()
                }),
                extra_headers: Vec::new(),
            })))
        }
        ProxyTransport::Quic => {
            return Err(ProbeError {
                stage: "config",
                code: "unsupported",
            })
        }
        _ => {}
    }
    Ok(chain)
}

fn parse_reality_public_key(value: &str) -> Option<[u8; 32]> {
    let mut normalized = value.trim().replace('-', "+").replace('_', "/");
    if normalized.is_empty()
        || !normalized
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return None;
    }
    while normalized.len() % 4 != 0 {
        normalized.push('=');
    }
    let bytes = BASE64_STANDARD.decode(normalized).ok()?;
    bytes.try_into().ok()
}

fn parse_reality_short_id(value: &str) -> Option<[u8; 8]> {
    let normalized = value.trim();
    if normalized.len() > 16
        || normalized.len() % 2 != 0
        || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    let mut output = [0_u8; 8];
    for (index, pair) in normalized.as_bytes().chunks(2).enumerate() {
        output[index] = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(output)
}

fn canary_metadata(host: &str, port: u16) -> Metadata {
    Metadata {
        host: host.into(),
        dst_port: port,
        ..Metadata::default()
    }
}

async fn verify_canary<S>(
    connection: &mut S,
    canary_host: &str,
    started: Instant,
) -> Result<u128, ProbeError>
where
    S: AsyncRead + AsyncWrite + Unpin + ?Sized,
{
    let request = format!(
        "HEAD / HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nUser-Agent: NIE-SLA-Proxy-Check/1\r\n\r\n",
        canary_host
    );
    connection
        .write_all(request.as_bytes())
        .await
        .map_err(|_| ProbeError {
            stage: "canary",
            code: "canary_failed",
        })?;
    let mut response = [0_u8; 5];
    connection
        .read_exact(&mut response[..1])
        .await
        .map_err(|_| ProbeError {
            stage: "canary",
            code: "canary_failed",
        })?;
    let first_byte_ms = started.elapsed().as_millis();
    connection
        .read_exact(&mut response[1..])
        .await
        .map_err(|_| ProbeError {
            stage: "canary",
            code: "canary_failed",
        })?;
    if &response != b"HTTP/" {
        return Err(ProbeError {
            stage: "canary",
            code: "canary_failed",
        });
    }
    Ok(first_byte_ms)
}

fn map_adapter_error(message: &str, stage: &'static str) -> ProbeError {
    let lower = message.to_ascii_lowercase();
    let code = if lower.contains("authentication")
        || lower.contains("auth")
        || lower.contains("credential")
        || lower.contains("uuid")
    {
        "auth_failed"
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "timeout"
    } else if lower.contains("not supported") {
        "unsupported"
    } else {
        "handshake_failed"
    };
    ProbeError { stage, code }
}

fn parse_uuid(value: &str) -> Result<[u8; 16], String> {
    let compact: String = value
        .chars()
        .filter(|character| *character != '-')
        .collect();
    if compact.len() != 32 {
        return Err("invalid uuid".into());
    }
    let mut output = [0_u8; 16];
    for (index, byte) in output.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&compact[index * 2..index * 2 + 2], 16)
            .map_err(|_| "invalid uuid".to_string())?;
    }
    Ok(output)
}

fn secret_string(secret: &serde_json::Map<String, Value>, key: &str) -> String {
    bounded_string(secret.get(key).and_then(Value::as_str), 2048)
}

fn secret_bool(secret: &serde_json::Map<String, Value>, key: &str) -> bool {
    secret.get(key).is_some_and(|value| {
        value.as_bool().unwrap_or_else(|| {
            value
                .as_str()
                .map(|raw| {
                    matches!(
                        raw.trim().to_ascii_lowercase().as_str(),
                        "1" | "true" | "yes"
                    )
                })
                .unwrap_or(false)
        })
    })
}

fn bounded_string(value: Option<&str>, max_len: usize) -> String {
    value
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max_len)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_uuid_with_or_without_hyphens() {
        let canonical = parse_uuid("8c7f969f-0000-4000-8000-000000000001").unwrap();
        let compact = parse_uuid("8c7f969f000040008000000000000001").unwrap();
        assert_eq!(canonical, compact);
    }

    #[test]
    fn rejects_legacy_vmess_alter_id_before_network_access() {
        let target = ProxyTarget::from_json(&serde_json::json!({
            "id": "vmess",
            "name": "VMess",
            "protocol": "vmess",
            "server": "127.0.0.1",
            "port": 443,
            "transport": "tcp",
            "sni": "127.0.0.1",
            "ws_path": "/",
            "ws_host": "127.0.0.1",
            "timeout_ms": 1000,
            "enabled": true,
            "secret": {
                "uuid": "00000000-0000-4000-8000-000000000000",
                "security": "auto",
                "alter_id": 1
            }
        }))
        .unwrap();
        let error = probe_proxy_target_inner(&target, "example.com", 80).unwrap_err();
        assert_eq!(error.code, "unsupported");
    }

    #[test]
    fn parses_reality_material_and_builds_a_reality_transport() {
        let public_key = BASE64_STANDARD.encode([0x42_u8; 32]);
        let target = ProxyTarget::from_json(&serde_json::json!({
            "id": "reality",
            "name": "Reality",
            "protocol": "vless",
            "server": "127.0.0.1",
            "port": 443,
            "transport": "tls",
            "sni": "example.com",
            "ws_path": "/",
            "ws_host": "example.com",
            "timeout_ms": 1000,
            "enabled": true,
            "secret": {
                "uuid": "00000000-0000-4000-8000-000000000000",
                "security": "reality",
                "flow": "xtls-rprx-vision",
                "reality_public_key": public_key,
                "reality_short_id": "0a0b"
            }
        }))
        .unwrap();

        assert_eq!(target.vless_security, "reality");
        assert!(build_transport_chain(&target).is_ok());
    }

    #[test]
    fn reality_short_id_is_zero_padded_and_rejects_unsafe_values() {
        assert_eq!(
            parse_reality_short_id("0a0b").unwrap(),
            [0x0a, 0x0b, 0, 0, 0, 0, 0, 0]
        );
        assert_eq!(parse_reality_short_id("").unwrap(), [0; 8]);
        assert!(parse_reality_short_id("0").is_none());
        assert!(parse_reality_short_id("0123456789abcdef0").is_none());
        assert!(parse_reality_short_id("zz").is_none());
    }
}
