use std::fmt::Display;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use async_imap::{types::NameAttribute, Client};
use futures::TryStreamExt;
use pebble_core::{new_id, Folder, FolderRole, FolderType, PebbleError, Result};
use serde::de::Deserializer;
use tokio::io::{self, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_native_tls as async_native_tls;
use tokio_rustls::client::TlsStream;
use tracing::debug;
use tracing::info;

use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider},
    pki_types::{CertificateDer, ServerName, UnixTime},
    server::ParsedCertificate,
    DigitallySignedStruct, Error as TlsError, SignatureScheme,
};

/// Connection security mode for mail protocols.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionSecurity {
    /// Implicit TLS — connect over TLS immediately (IMAP 993, SMTP 465).
    #[default]
    Tls,
    /// STARTTLS — connect plain then upgrade to TLS (IMAP 143, SMTP 587).
    #[serde(rename = "starttls")]
    StartTls,
    /// No encryption (not recommended).
    Plain,
}

/// Optional SOCKS5 proxy configuration.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProxyConfig {
    pub host: String,
    pub port: u16,
}

/// Configuration for an IMAP connection.
#[derive(Clone, serde::Serialize)]
pub struct ImapConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip_serializing)]
    pub password: String,
    pub security: ConnectionSecurity,
    #[serde(default, skip_serializing_if = "is_false")]
    pub accept_invalid_certs: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxyConfig>,
}

impl std::fmt::Debug for ImapConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImapConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field("security", &self.security)
            .field("accept_invalid_certs", &self.accept_invalid_certs)
            .field("proxy", &self.proxy)
            .finish()
    }
}

// Custom Deserialize to handle legacy `use_tls: bool` configs.
impl<'de> serde::Deserialize<'de> for ImapConfig {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(serde::Deserialize)]
        struct Raw {
            host: String,
            port: u16,
            username: String,
            password: String,
            #[serde(default)]
            security: Option<ConnectionSecurity>,
            #[serde(default)]
            use_tls: Option<bool>,
            #[serde(default)]
            accept_invalid_certs: bool,
            #[serde(default)]
            proxy: Option<ProxyConfig>,
        }

        let raw = Raw::deserialize(deserializer)?;
        let security = raw.security.unwrap_or(match raw.use_tls {
            Some(false) => ConnectionSecurity::Plain,
            _ => ConnectionSecurity::Tls,
        });

        Ok(ImapConfig {
            host: raw.host,
            port: raw.port,
            username: raw.username,
            password: raw.password,
            security,
            accept_invalid_certs: raw.accept_invalid_certs,
            proxy: raw.proxy,
        })
    }
}

/// Configuration for an SMTP connection.
#[derive(Clone, serde::Serialize)]
pub struct SmtpConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(skip_serializing)]
    pub password: String,
    pub security: ConnectionSecurity,
    #[serde(default, skip_serializing_if = "is_false")]
    pub accept_invalid_certs: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxyConfig>,
}

impl std::fmt::Debug for SmtpConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SmtpConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .field("security", &self.security)
            .field("accept_invalid_certs", &self.accept_invalid_certs)
            .field("proxy", &self.proxy)
            .finish()
    }
}

// Custom Deserialize to handle legacy `use_tls: bool` configs.
impl<'de> serde::Deserialize<'de> for SmtpConfig {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(serde::Deserialize)]
        struct Raw {
            host: String,
            port: u16,
            username: String,
            password: String,
            #[serde(default)]
            security: Option<ConnectionSecurity>,
            #[serde(default)]
            use_tls: Option<bool>,
            #[serde(default)]
            accept_invalid_certs: bool,
            #[serde(default)]
            proxy: Option<ProxyConfig>,
        }

        let raw = Raw::deserialize(deserializer)?;
        let security = raw.security.unwrap_or(match raw.use_tls {
            Some(false) => ConnectionSecurity::Plain,
            _ => ConnectionSecurity::Tls,
        });

        Ok(SmtpConfig {
            host: raw.host,
            port: raw.port,
            username: raw.username,
            password: raw.password,
            security,
            accept_invalid_certs: raw.accept_invalid_certs,
            proxy: raw.proxy,
        })
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn incremental_fetch_uids(since_uid: Option<u32>, searched_uids: &[u32]) -> Vec<u32> {
    let Some(since_uid) = since_uid else {
        return searched_uids.to_vec();
    };
    let mut uids = searched_uids
        .iter()
        .copied()
        .filter(|uid| *uid > since_uid)
        .collect::<Vec<_>>();
    uids.sort_unstable();
    uids.dedup();
    uids
}

fn should_search_incremental_uids(next_uid: u32, mailbox_uid_next: Option<u32>) -> bool {
    mailbox_uid_next.is_none_or(|uid_next| next_uid < uid_next)
}

/// Stream wrapper that replays buffered prefix bytes, then delegates to inner.
/// Used to replay the IMAP greeting after manually sending an ID command.
#[derive(Debug)]
struct PrefixedStream<T> {
    prefix: Vec<u8>,
    pos: usize,
    inner: T,
}

impl<T> PrefixedStream<T> {
    fn with_prefix(prefix: Vec<u8>, inner: T) -> Self {
        Self {
            prefix,
            pos: 0,
            inner,
        }
    }
}

impl<T: AsyncRead + Unpin> AsyncRead for PrefixedStream<T> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.pos < this.prefix.len() {
            let remaining = &this.prefix[this.pos..];
            let n = remaining.len().min(buf.remaining());
            buf.put_slice(&remaining[..n]);
            this.pos += n;
            Poll::Ready(Ok(()))
        } else {
            Pin::new(&mut this.inner).poll_read(cx, buf)
        }
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<T> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, buf)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// A stream that is either wrapped in TLS or raw TCP. Implementing the
/// tokio async I/O traits on this enum means `async_imap::Session` is
/// generic over a single type, so every operation site can drop the old
/// `match self.session { Tls(_) => ..., Plain(_) => ... }` duplication.
enum InnerStream {
    Tls(Box<TlsStream<TcpStream>>),
    NativeTls(Box<async_native_tls::TlsStream<TcpStream>>),
    Plain(TcpStream),
}

impl std::fmt::Debug for InnerStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            InnerStream::Tls(_) => f.debug_struct("InnerStream::Tls").finish(),
            InnerStream::NativeTls(_) => f.debug_struct("InnerStream::NativeTls").finish(),
            InnerStream::Plain(_) => f.debug_struct("InnerStream::Plain").finish(),
        }
    }
}

impl AsyncRead for InnerStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            InnerStream::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
            InnerStream::NativeTls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
            InnerStream::Plain(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for InnerStream {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            InnerStream::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
            InnerStream::NativeTls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
            InnerStream::Plain(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            InnerStream::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
            InnerStream::NativeTls(s) => Pin::new(s.as_mut()).poll_flush(cx),
            InnerStream::Plain(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            InnerStream::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
            InnerStream::NativeTls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
            InnerStream::Plain(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// Unified IMAP session type — a single `async_imap::Session` regardless
/// of whether the underlying transport is TLS or plain TCP.
type ImapSession = async_imap::Session<PrefixedStream<InnerStream>>;

const IMAP_CONNECT_TIMEOUT_SECS: u64 = 15;
const IMAP_COMMAND_TIMEOUT_SECS: u64 = 45;
const IMAP_STATUS_PROBE_TIMEOUT_SECS: u64 = 10;
// Downloading full RFC822 bodies is materially slower than ordinary IMAP
// commands, especially when a message contains large attachments. The history
// sync uses small pages that retry in even smaller sub-pages on timeout, so a
// 完整 MIME 拉取（含大附件）允许 2 分钟；之前 45s 太短，barn lights
// 这种带大附件的邮件拉不到正文 → 打开后只能看到邮件头。
const IMAP_BODY_FETCH_TIMEOUT_SECS: u64 = 120;

fn imap_timeout_error(operation: &str, seconds: u64) -> PebbleError {
    PebbleError::Network(format!("{operation} timed out after {seconds}s"))
}

async fn with_imap_timeout<T, E, Fut>(operation: &str, seconds: u64, future: Fut) -> Result<T>
where
    E: Display,
    Fut: Future<Output = std::result::Result<T, E>>,
{
    match tokio::time::timeout(Duration::from_secs(seconds), future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(PebbleError::Network(format!("{operation} failed: {error}"))),
        Err(_) => Err(imap_timeout_error(operation, seconds)),
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ImapMailboxStatus {
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    pub highest_modseq: Option<u64>,
    /// Number of messages in the mailbox as reported by SELECT.
    pub exists: u32,
}

/// An IMAP provider that manages a connection and session.
#[derive(Clone)]
pub struct ImapProvider {
    config: ImapConfig,
    session: Arc<Mutex<Option<ImapSession>>>,
    /// Valid only within uninterrupted body-fetch calls. Every other session
    /// user invalidates this cache while holding the session lock, including
    /// reconnect, IDLE, failed SELECT and arbitrary mailbox operations.
    /// 最近一次 SELECT 的 mailbox。同一文件夹连续 FETCH 时跳过重复 SELECT
    /// （一次 SELECT 是一次完整网络往返，逐封拉取时会显著拖慢）。
    last_selected: Arc<tokio::sync::Mutex<Option<String>>>,
}

/// Build a rustls TLS connector with bundled root certificates.
fn build_tls_connector(accept_invalid_certs: bool) -> Result<tokio_rustls::TlsConnector> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| PebbleError::Network(format!("TLS protocol versions: {e}")))?;
    let config = if accept_invalid_certs {
        builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptInvalidCertsVerifier {
                roots: root_store,
                provider,
            }))
            .with_no_client_auth()
    } else {
        builder
            .with_root_certificates(root_store)
            .with_no_client_auth()
    };
    Ok(tokio_rustls::TlsConnector::from(Arc::new(config)))
}

/// Perform a TLS handshake using rustls on the given TCP stream.
async fn tls_connect(
    host: &str,
    tcp: TcpStream,
    accept_invalid_certs: bool,
) -> Result<TlsStream<TcpStream>> {
    let connector = build_tls_connector(accept_invalid_certs)?;
    let server_name = rustls::pki_types::ServerName::try_from(host)
        .map_err(|e| PebbleError::Network(format!("Invalid server name '{}': {}", host, e)))?
        .to_owned();
    with_imap_timeout(
        &format!("TLS handshake with {host}"),
        IMAP_CONNECT_TIMEOUT_SECS,
        connector.connect(server_name, tcp),
    )
    .await
}

/// Build a native-tls connector (delegates to OS TLS: SChannel/SecureTransport/OpenSSL).
fn build_native_tls_connector(
    accept_invalid_certs: bool,
) -> Result<async_native_tls::TlsConnector> {
    let mut builder = native_tls::TlsConnector::builder();
    if accept_invalid_certs {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
        builder.min_protocol_version(Some(native_tls::Protocol::Tlsv10));
    }
    let connector = builder
        .build()
        .map_err(|e| PebbleError::Network(format!("native-tls init: {e}")))?;
    Ok(async_native_tls::TlsConnector::from(connector))
}

/// Perform a TLS handshake using native-tls (OS TLS backend) on the given TCP stream.
/// Used as fallback when rustls fails (e.g. servers that only offer DHE cipher suites).
async fn native_tls_connect(
    host: &str,
    tcp: TcpStream,
    accept_invalid_certs: bool,
) -> Result<async_native_tls::TlsStream<TcpStream>> {
    let connector = build_native_tls_connector(accept_invalid_certs)?;
    with_imap_timeout(
        &format!("TLS handshake (native-tls) with {host}"),
        IMAP_CONNECT_TIMEOUT_SECS,
        connector.connect(host, tcp),
    )
    .await
}

#[derive(Debug)]
pub(crate) struct AcceptInvalidCertsVerifier {
    roots: rustls::RootCertStore,
    provider: Arc<CryptoProvider>,
}

impl AcceptInvalidCertsVerifier {
    pub(crate) fn new(roots: rustls::RootCertStore) -> Self {
        Self {
            roots,
            provider: Arc::new(rustls::crypto::aws_lc_rs::default_provider()),
        }
    }
}

impl ServerCertVerifier for AcceptInvalidCertsVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, TlsError> {
        if !self.roots.is_empty() {
            if let Ok(cert) = ParsedCertificate::try_from(end_entity) {
                let _ = rustls::client::verify_server_cert_signed_by_trust_anchor(
                    &cert,
                    &self.roots,
                    intermediates,
                    now,
                    self.provider.signature_verification_algorithms.all,
                );
                let _ = rustls::client::verify_server_name(&cert, server_name);
            }
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

impl ImapProvider {
    /// Create a new provider with the given configuration.
    pub fn new(config: ImapConfig) -> Self {
        Self {
            config,
            session: Arc::new(Mutex::new(None)),
            last_selected: Arc::new(tokio::sync::Mutex::new(None)),
        }
    }

    /// Return a clone of the connection configuration.
    pub fn config(&self) -> ImapConfig {
        self.config.clone()
    }

    /// Whether this host requires an RFC 2971 ID command before LOGIN
    /// (Coremail-based servers reject as "Unsafe Login" without it).
    fn needs_id_command(&self) -> bool {
        let h = self.config.host.to_lowercase();
        h.contains("163.com")
            || h.contains("126.com")
            || h.contains("188.com")
            || h.contains("yeah.net")
            || h.contains("netease.com")
            || h.contains("sina.com")
            || h.contains("sina.cn")
            || h.contains("qq.com")
            || h.contains("exmail.qq.com")
            || h.contains("tencent.com")
    }

    /// Send IMAP ID command on a raw stream, returning the greeting bytes
    /// so they can be replayed for `Client::new()`.
    async fn send_id_before_login<S: AsyncRead + AsyncWrite + Unpin>(
        stream: &mut S,
    ) -> Result<Vec<u8>> {
        // Read server greeting (e.g. "* OK Coremail ...")
        let mut greeting = vec![0u8; 8192];
        let n = with_imap_timeout(
            "Read greeting",
            IMAP_COMMAND_TIMEOUT_SECS,
            stream.read(&mut greeting),
        )
        .await?;
        greeting.truncate(n);

        // Send ID command
        with_imap_timeout(
            "Send ID",
            IMAP_COMMAND_TIMEOUT_SECS,
            stream.write_all(
                b"A000 ID (\"name\" \"Pebble\" \"version\" \"1.0\" \"vendor\" \"Pebble\")\r\n",
            ),
        )
        .await?;
        with_imap_timeout("Flush ID", IMAP_COMMAND_TIMEOUT_SECS, stream.flush()).await?;

        // Read ID response until we see the tagged response (A000 OK/NO/BAD)
        let mut resp = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = with_imap_timeout(
                "Read ID response",
                IMAP_COMMAND_TIMEOUT_SECS,
                stream.read(&mut buf),
            )
            .await?;
            if n == 0 {
                return Err(PebbleError::Network("Connection closed during ID".into()));
            }
            resp.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&resp);
            if text.contains("A000 OK") || text.contains("A000 NO") || text.contains("A000 BAD") {
                break;
            }
        }
        debug!("IMAP ID command accepted");
        Ok(greeting)
    }

    /// Send STARTTLS command and read the server response.
    /// Returns the TCP stream ready for TLS upgrade.
    async fn negotiate_starttls(mut tcp: TcpStream) -> Result<TcpStream> {
        with_imap_timeout(
            "Send STARTTLS",
            IMAP_COMMAND_TIMEOUT_SECS,
            tcp.write_all(b"A001 STARTTLS\r\n"),
        )
        .await?;
        with_imap_timeout("Flush STARTTLS", IMAP_COMMAND_TIMEOUT_SECS, tcp.flush()).await?;

        let mut resp = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = with_imap_timeout(
                "Read STARTTLS response",
                IMAP_COMMAND_TIMEOUT_SECS,
                tcp.read(&mut buf),
            )
            .await?;
            if n == 0 {
                return Err(PebbleError::Network(
                    "Connection closed during STARTTLS".into(),
                ));
            }
            resp.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&resp);
            if text.contains("A001 OK") {
                break;
            }
            if text.contains("A001 NO") || text.contains("A001 BAD") {
                return Err(PebbleError::Network(format!(
                    "Server rejected STARTTLS: {}",
                    text.trim()
                )));
            }
        }
        debug!("STARTTLS accepted, upgrading connection");
        Ok(tcp)
    }

    /// Connect via STARTTLS: read greeting, optionally send ID, negotiate
    /// STARTTLS, upgrade to TLS (rustls or native-tls), then login.
    async fn connect_starttls(
        &self,
        tcp: TcpStream,
        needs_id: bool,
        use_native_tls: bool,
    ) -> Result<ImapSession> {
        let mut tcp = tcp;

        // Read greeting
        let mut greeting = vec![0u8; 8192];
        let n = with_imap_timeout(
            "Read greeting",
            IMAP_COMMAND_TIMEOUT_SECS,
            tcp.read(&mut greeting),
        )
        .await?;
        greeting.truncate(n);

        // Send ID command before STARTTLS if needed (on plain connection)
        if needs_id {
            with_imap_timeout(
                "Send ID",
                IMAP_COMMAND_TIMEOUT_SECS,
                tcp.write_all(
                    b"A000 ID (\"name\" \"Pebble\" \"version\" \"1.0\" \"vendor\" \"Pebble\")\r\n",
                ),
            )
            .await?;
            with_imap_timeout("Flush ID", IMAP_COMMAND_TIMEOUT_SECS, tcp.flush()).await?;

            let mut resp = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                let n = with_imap_timeout(
                    "Read ID response",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    tcp.read(&mut buf),
                )
                .await?;
                if n == 0 {
                    return Err(PebbleError::Network("Connection closed during ID".into()));
                }
                resp.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&resp);
                if text.contains("A000 OK") || text.contains("A000 NO") || text.contains("A000 BAD")
                {
                    break;
                }
            }
            debug!("IMAP ID command accepted (pre-STARTTLS)");
        }

        // STARTTLS negotiation
        let tcp = Self::negotiate_starttls(tcp).await?;

        // TLS upgrade
        let inner = if use_native_tls {
            let tls = native_tls_connect(&self.config.host, tcp, self.config.accept_invalid_certs)
                .await?;
            InnerStream::NativeTls(Box::new(tls))
        } else {
            let tls = tls_connect(&self.config.host, tcp, self.config.accept_invalid_certs).await?;
            InnerStream::Tls(Box::new(tls))
        };

        // Replay the original greeting so Client::new() is happy
        let stream = PrefixedStream::with_prefix(greeting, inner);
        let client = Client::new(stream);
        tokio::time::timeout(
            Duration::from_secs(IMAP_COMMAND_TIMEOUT_SECS),
            client.login(&self.config.username, &self.config.password),
        )
        .await
        .map_err(|_| imap_timeout_error("IMAP login", IMAP_COMMAND_TIMEOUT_SECS))?
        .map_err(|(e, _)| PebbleError::Auth(format!("IMAP login failed: {e}")))
    }

    /// Establish a TCP connection, optionally through a SOCKS5 proxy.
    async fn tcp_connect(&self) -> Result<TcpStream> {
        let addr = format!("{}:{}", self.config.host, self.config.port);

        let tcp = if let Some(ref proxy) = self.config.proxy {
            let proxy_addr = format!("{}:{}", proxy.host, proxy.port);
            debug!(
                "Connecting to {} via SOCKS5 proxy {} (security={:?})...",
                addr, proxy_addr, self.config.security
            );
            let stream = with_imap_timeout(
                &format!("SOCKS5 proxy connect to {addr} via {proxy_addr}"),
                IMAP_CONNECT_TIMEOUT_SECS,
                tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), addr.as_str()),
            )
            .await?;
            let tcp = stream.into_inner();
            if let Ok(peer) = tcp.peer_addr() {
                debug!("SOCKS5 connected to {} (proxy peer: {})", addr, peer);
            }
            tcp
        } else {
            debug!(
                "Resolving and connecting to {} (security={:?})...",
                addr, self.config.security
            );
            let tcp = with_imap_timeout(
                &format!("TCP connect to {addr}"),
                IMAP_CONNECT_TIMEOUT_SECS,
                TcpStream::connect(&addr),
            )
            .await?;
            if let Ok(peer) = tcp.peer_addr() {
                debug!("TCP connected to {} (resolved IP: {})", addr, peer);
            }
            tcp
        };

        Ok(tcp)
    }

    /// Connect to the IMAP server and log in.
    pub async fn connect(&self) -> Result<()> {
        let tcp = self.tcp_connect().await?;

        let needs_id = self.needs_id_command();

        let session: ImapSession = match self.config.security {
            ConnectionSecurity::Tls => {
                // Implicit TLS — wrap immediately; try rustls, fall back to native-tls
                debug!("Starting TLS handshake with SNI={}", self.config.host);
                let inner = match tls_connect(
                    &self.config.host,
                    tcp,
                    self.config.accept_invalid_certs,
                )
                .await
                {
                    Ok(tls) => InnerStream::Tls(Box::new(tls)),
                    Err(rustls_err) => {
                        debug!(
                            "rustls handshake failed ({}), retrying with native-tls",
                            rustls_err
                        );
                        let tcp = self.tcp_connect().await?;
                        let tls = native_tls_connect(
                            &self.config.host,
                            tcp,
                            self.config.accept_invalid_certs,
                        )
                            .await
                            .map_err(|e| {
                                PebbleError::Network(format!(
                                    "TLS failed with both backends — rustls: {rustls_err}, native-tls: {e}"
                                ))
                            })?;
                        InnerStream::NativeTls(Box::new(tls))
                    }
                };

                let mut inner = inner;
                let prefix = if needs_id {
                    Self::send_id_before_login(&mut inner).await?
                } else {
                    Vec::new()
                };
                let stream = PrefixedStream::with_prefix(prefix, inner);

                let client = Client::new(stream);
                tokio::time::timeout(
                    Duration::from_secs(IMAP_COMMAND_TIMEOUT_SECS),
                    client.login(&self.config.username, &self.config.password),
                )
                .await
                .map_err(|_| imap_timeout_error("IMAP login", IMAP_COMMAND_TIMEOUT_SECS))?
                .map_err(|(e, _)| PebbleError::Auth(format!("IMAP login failed: {e}")))?
            }
            ConnectionSecurity::StartTls => {
                // Connect plain, read greeting, optionally send ID, STARTTLS, upgrade TLS.
                // Try rustls first, fall back to native-tls on handshake failure.
                match self.connect_starttls(tcp, needs_id, false).await {
                    Ok(session) => session,
                    Err(rustls_err) => {
                        debug!(
                            "STARTTLS with rustls failed ({}), retrying with native-tls",
                            rustls_err
                        );
                        let tcp = self.tcp_connect().await?;
                        self.connect_starttls(tcp, needs_id, true)
                            .await
                            .map_err(|native_err| {
                                PebbleError::Network(format!(
                                    "STARTTLS failed with both TLS backends — rustls: {rustls_err}, native-tls: {native_err}"
                                ))
                            })?
                    }
                }
            }
            ConnectionSecurity::Plain => {
                // Plain TCP — no encryption
                let mut tcp = tcp;
                let prefix = if needs_id {
                    Self::send_id_before_login(&mut tcp).await?
                } else {
                    Vec::new()
                };
                let stream = PrefixedStream::with_prefix(prefix, InnerStream::Plain(tcp));

                let client = Client::new(stream);
                tokio::time::timeout(
                    Duration::from_secs(IMAP_COMMAND_TIMEOUT_SECS),
                    client.login(&self.config.username, &self.config.password),
                )
                .await
                .map_err(|_| imap_timeout_error("IMAP login", IMAP_COMMAND_TIMEOUT_SECS))?
                .map_err(|(e, _)| PebbleError::Auth(format!("IMAP login failed: {e}")))?
            }
        };

        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        *guard = Some(session);
        debug!(
            "IMAP connected to {} ({:?})",
            self.config.host, self.config.security
        );
        Ok(())
    }

    /// Test connectivity without logging in. Returns a diagnostic summary.
    /// Tries TCP connect → TLS handshake → read IMAP greeting.
    pub async fn test_connection(config: &ImapConfig) -> Result<String> {
        use std::time::Instant;
        let addr = format!("{}:{}", config.host, config.port);
        let mut report = String::new();

        // Step 1: TCP connect (optionally via proxy)
        let t0 = Instant::now();
        let tcp = if let Some(ref proxy) = config.proxy {
            let proxy_addr = format!("{}:{}", proxy.host, proxy.port);
            let stream = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), addr.as_str()),
            )
            .await
            .map_err(|_| {
                PebbleError::Network(format!("SOCKS5 connect to {proxy_addr} timed out (10s)"))
            })?
            .map_err(|e| PebbleError::Network(format!("SOCKS5 proxy: {e}")))?;
            let tcp = stream.into_inner();
            report.push_str(&format!(
                "TCP via SOCKS5 {proxy_addr}: OK ({:.0}ms)\n",
                t0.elapsed().as_millis()
            ));
            tcp
        } else {
            let tcp = tokio::time::timeout(
                std::time::Duration::from_secs(10),
                TcpStream::connect(&addr),
            )
            .await
            .map_err(|_| PebbleError::Network(format!("TCP connect to {addr} timed out (10s)")))?
            .map_err(|e| PebbleError::Network(format!("TCP connect: {e}")))?;
            if let Ok(peer) = tcp.peer_addr() {
                report.push_str(&format!(
                    "TCP direct to {addr} (IP: {peer}): OK ({:.0}ms)\n",
                    t0.elapsed().as_millis()
                ));
            } else {
                report.push_str(&format!(
                    "TCP direct to {addr}: OK ({:.0}ms)\n",
                    t0.elapsed().as_millis()
                ));
            }
            tcp
        };

        // Helper: reconnect TCP for TLS fallback (no report, just the socket)
        let reconnect_tcp = |config: &ImapConfig| {
            let addr_clone = addr.clone();
            let proxy = config.proxy.clone();
            async move {
                if let Some(ref proxy) = proxy {
                    let proxy_addr = format!("{}:{}", proxy.host, proxy.port);
                    let stream = tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        tokio_socks::tcp::Socks5Stream::connect(
                            proxy_addr.as_str(),
                            addr_clone.as_str(),
                        ),
                    )
                    .await
                    .map_err(|_| {
                        PebbleError::Network(format!(
                            "SOCKS5 reconnect to {proxy_addr} timed out (10s)"
                        ))
                    })?
                    .map_err(|e| PebbleError::Network(format!("SOCKS5 proxy: {e}")))?;
                    Ok::<TcpStream, PebbleError>(stream.into_inner())
                } else {
                    let tcp = tokio::time::timeout(
                        std::time::Duration::from_secs(10),
                        TcpStream::connect(&addr_clone),
                    )
                    .await
                    .map_err(|_| {
                        PebbleError::Network(format!(
                            "TCP reconnect to {addr_clone} timed out (10s)"
                        ))
                    })?
                    .map_err(|e| PebbleError::Network(format!("TCP reconnect: {e}")))?;
                    Ok::<TcpStream, PebbleError>(tcp)
                }
            }
        };

        // Step 2: TLS handshake (if applicable)
        match config.security {
            ConnectionSecurity::Tls => {
                let t1 = Instant::now();
                match tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    tls_connect(&config.host, tcp, config.accept_invalid_certs),
                )
                .await
                {
                    Ok(Ok(mut tls)) => {
                        report.push_str(&format!(
                            "TLS handshake (rustls): OK ({:.0}ms)\n",
                            t1.elapsed().as_millis()
                        ));
                        let t2 = Instant::now();
                        let mut buf = vec![0u8; 4096];
                        let n = tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            tls.read(&mut buf),
                        )
                        .await
                        .map_err(|_| {
                            PebbleError::Network("Read IMAP greeting timed out (10s)".into())
                        })?
                        .map_err(|e| PebbleError::Network(format!("Read greeting: {e}")))?;
                        let greeting = String::from_utf8_lossy(&buf[..n]);
                        report.push_str(&format!(
                            "IMAP greeting ({:.0}ms): {}\n",
                            t2.elapsed().as_millis(),
                            greeting.trim()
                        ));
                    }
                    Ok(Err(rustls_err)) => {
                        report
                            .push_str(&format!("TLS handshake (rustls): FAILED — {rustls_err}\n"));
                        let tcp = reconnect_tcp(config).await?;
                        let t_ntls = Instant::now();
                        let mut tls = tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            native_tls_connect(&config.host, tcp, config.accept_invalid_certs),
                        )
                        .await
                        .map_err(|_| {
                            PebbleError::Network("native-tls handshake timed out (10s)".into())
                        })??;
                        report.push_str(&format!(
                            "TLS handshake (native-tls fallback): OK ({:.0}ms)\n",
                            t_ntls.elapsed().as_millis()
                        ));
                        let t2 = Instant::now();
                        let mut buf = vec![0u8; 4096];
                        let n = tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            tls.read(&mut buf),
                        )
                        .await
                        .map_err(|_| {
                            PebbleError::Network("Read IMAP greeting timed out (10s)".into())
                        })?
                        .map_err(|e| PebbleError::Network(format!("Read greeting: {e}")))?;
                        let greeting = String::from_utf8_lossy(&buf[..n]);
                        report.push_str(&format!(
                            "IMAP greeting ({:.0}ms): {}\n",
                            t2.elapsed().as_millis(),
                            greeting.trim()
                        ));
                    }
                    Err(_) => {
                        return Err(PebbleError::Network("TLS handshake timed out (10s)".into()));
                    }
                }
            }
            ConnectionSecurity::StartTls => {
                // Read plain greeting first
                let mut tcp = tcp;
                let t1 = Instant::now();
                let mut buf = vec![0u8; 4096];
                let n =
                    tokio::time::timeout(std::time::Duration::from_secs(10), tcp.read(&mut buf))
                        .await
                        .map_err(|_| {
                            PebbleError::Network("Read plain greeting timed out (10s)".into())
                        })?
                        .map_err(|e| PebbleError::Network(format!("Read greeting: {e}")))?;
                let greeting = String::from_utf8_lossy(&buf[..n]);
                report.push_str(&format!(
                    "Plain greeting ({:.0}ms): {}\n",
                    t1.elapsed().as_millis(),
                    greeting.trim()
                ));

                // Send STARTTLS
                let t2 = Instant::now();
                tcp.write_all(b"A001 STARTTLS\r\n")
                    .await
                    .map_err(|e| PebbleError::Network(format!("Send STARTTLS: {e}")))?;
                tcp.flush()
                    .await
                    .map_err(|e| PebbleError::Network(format!("Flush: {e}")))?;
                let mut resp = vec![0u8; 4096];
                let n =
                    tokio::time::timeout(std::time::Duration::from_secs(10), tcp.read(&mut resp))
                        .await
                        .map_err(|_| {
                            PebbleError::Network("STARTTLS response timed out (10s)".into())
                        })?
                        .map_err(|e| {
                            PebbleError::Network(format!("Read STARTTLS response: {e}"))
                        })?;
                let resp_str = String::from_utf8_lossy(&resp[..n]);
                report.push_str(&format!(
                    "STARTTLS response ({:.0}ms): {}\n",
                    t2.elapsed().as_millis(),
                    resp_str.trim()
                ));

                // TLS upgrade — try rustls, fall back to native-tls
                let t3 = Instant::now();
                match tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    tls_connect(&config.host, tcp, config.accept_invalid_certs),
                )
                .await
                {
                    Ok(Ok(_)) => {
                        report.push_str(&format!(
                            "TLS upgrade (STARTTLS, rustls): OK ({:.0}ms)\n",
                            t3.elapsed().as_millis()
                        ));
                    }
                    Ok(Err(rustls_err)) => {
                        report.push_str(&format!(
                            "TLS upgrade (STARTTLS, rustls): FAILED — {rustls_err}\n"
                        ));
                        // Reconnect and redo STARTTLS with native-tls
                        let tcp = reconnect_tcp(config).await?;
                        let mut tcp = tcp;
                        // Re-read greeting (discard)
                        let mut discard = vec![0u8; 4096];
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            tcp.read(&mut discard),
                        )
                        .await
                        .map_err(|_| PebbleError::Network("Read greeting timed out (10s)".into()))?
                        .map_err(|e| PebbleError::Network(format!("Read greeting: {e}")))?;
                        // Re-send STARTTLS
                        tcp.write_all(b"A001 STARTTLS\r\n")
                            .await
                            .map_err(|e| PebbleError::Network(format!("Send STARTTLS: {e}")))?;
                        tcp.flush()
                            .await
                            .map_err(|e| PebbleError::Network(format!("Flush: {e}")))?;
                        let mut resp2 = vec![0u8; 4096];
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            tcp.read(&mut resp2),
                        )
                        .await
                        .map_err(|_| {
                            PebbleError::Network("STARTTLS response timed out (10s)".into())
                        })?
                        .map_err(|e| {
                            PebbleError::Network(format!("Read STARTTLS response: {e}"))
                        })?;
                        let t4 = Instant::now();
                        tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            native_tls_connect(&config.host, tcp, config.accept_invalid_certs),
                        )
                        .await
                        .map_err(|_| {
                            PebbleError::Network("native-tls upgrade timed out (10s)".into())
                        })??;
                        report.push_str(&format!(
                            "TLS upgrade (STARTTLS, native-tls fallback): OK ({:.0}ms)\n",
                            t4.elapsed().as_millis()
                        ));
                    }
                    Err(_) => {
                        return Err(PebbleError::Network("TLS upgrade timed out (10s)".into()));
                    }
                }
            }
            ConnectionSecurity::Plain => {
                // Read plain greeting
                let mut tcp = tcp;
                let t1 = Instant::now();
                let mut buf = vec![0u8; 4096];
                let n =
                    tokio::time::timeout(std::time::Duration::from_secs(10), tcp.read(&mut buf))
                        .await
                        .map_err(|_| {
                            PebbleError::Network("Read plain greeting timed out (10s)".into())
                        })?
                        .map_err(|e| PebbleError::Network(format!("Read greeting: {e}")))?;
                let greeting = String::from_utf8_lossy(&buf[..n]);
                report.push_str(&format!(
                    "Plain greeting ({:.0}ms): {}\n",
                    t1.elapsed().as_millis(),
                    greeting.trim()
                ));
            }
        }

        report.push_str("Connection test: PASSED");
        Ok(report)
    }

    /// Test connection with login. Extends `test_connection` by also attempting LOGIN.
    pub async fn test_connection_with_login(config: &ImapConfig) -> Result<String> {
        // First do the basic connectivity test
        let mut report = Self::test_connection(config).await?;

        // Now try an actual IMAP login
        report.push_str("\n--- Login test ---\n");
        let provider = ImapProvider::new(config.clone());
        match provider.connect().await {
            Ok(()) => {
                report.push_str("LOGIN: OK\n");
                report.push_str("Authentication test: PASSED");
            }
            Err(e) => {
                report.push_str(&format!("LOGIN: FAILED — {e}\n"));
                return Err(PebbleError::Auth(format!("Authentication failed: {e}")));
            }
        }
        Ok(report)
    }

    /// List folders for the given account, returning `Folder` structs.
    pub async fn list_folders(&self, account_id: &str) -> Result<Vec<Folder>> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        let mailboxes: Vec<(String, Vec<NameAttribute<'static>>)> = {
            let stream = sess
                .list(None, Some("*"))
                .await
                .map_err(|e| PebbleError::Network(format!("LIST failed: {e}")))?;
            stream
                .map_ok(|n| {
                    let attributes = n
                        .attributes()
                        .iter()
                        .cloned()
                        .map(NameAttribute::into_owned)
                        .collect();
                    (n.name().to_string(), attributes)
                })
                .try_collect()
                .await
                .map_err(|e| PebbleError::Network(format!("LIST collect: {e}")))?
        };

        let mut folders: Vec<Folder> = mailboxes
            .into_iter()
            .filter(|(_, attributes)| should_sync_listed_mailbox(attributes))
            .map(|(raw_name, attributes)| {
                // Decode IMAP Modified UTF-7 folder name to UTF-8
                let display_name = utf7_imap::decode_utf7_imap(raw_name.clone());
                let role = detect_folder_role_from_attributes(&attributes)
                    .or_else(|| detect_folder_role(&raw_name))
                    .or_else(|| detect_folder_role(&display_name));
                let sort_order = folder_sort_order(&role);
                // 只有带系统角色（INBOX/Sent/Trash 等）的才算系统文件夹；
                // 自定义文件夹（含服务器上 Trash/111 这类子文件夹）必须
                // 可删除/重命名，误标 is_system 会导致右键菜单禁用这些操作。
                let is_system = role.is_some();
                Folder {
                    id: new_id(),
                    account_id: account_id.to_string(),
                    remote_id: raw_name,
                    name: display_name,
                    folder_type: FolderType::Folder,
                    role,
                    parent_id: None,
                    color: None,
                    is_system,
                    sort_order,
                }
            })
            .collect();

        folders.sort_by_key(|f| f.sort_order);
        Ok(folders)
    }

    /// Return the hierarchy separator announced by the IMAP server (normally
    /// "/", but some servers use "." or another value). Folder create/move
    /// must never hard-code "/" or the server and local tree can diverge.
    pub async fn hierarchy_delimiter(&self) -> Result<String> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;
        let stream = sess
            .list(Some(""), Some(""))
            .await
            .map_err(|e| PebbleError::Network(format!("LIST delimiter failed: {e}")))?;
        let names: Vec<_> = stream
            .try_collect()
            .await
            .map_err(|e| PebbleError::Network(format!("LIST delimiter collect failed: {e}")))?;
        Ok(names
            .first()
            .and_then(|name| name.delimiter())
            .filter(|value| !value.is_empty())
            .unwrap_or("/")
            .to_string())
    }

    /// Fetch raw message bytes from a mailbox.
    /// Returns a list of `(uid, raw_bytes)` pairs.
    pub async fn fetch_messages_raw(
        &self,
        mailbox: &str,
        since_uid: Option<u32>,
        limit: u32,
    ) -> Result<Vec<(u32, Vec<u8>)>> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        macro_rules! do_fetch {
            ($s:expr) => {{
                let mailbox_info =
                    with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, $s.select(mailbox))
                        .await?;

                let exists = mailbox_info.exists;
                if exists == 0 {
                    return Ok(Vec::new());
                }

                let mut results = Vec::new();

                if let Some(uid) = since_uid {
                    let next_uid = match uid.checked_add(1) {
                        Some(n) => n,
                        None => return Ok(Vec::new()),
                    };
                    if !should_search_incremental_uids(next_uid, mailbox_info.uid_next) {
                        return Ok(Vec::new());
                    }
                    let search_query = format!("UID {next_uid}:*");
                    let searched_uids: Vec<u32> = with_imap_timeout(
                        "UID SEARCH",
                        IMAP_COMMAND_TIMEOUT_SECS,
                        $s.uid_search(&search_query),
                    )
                    .await?
                    .into_iter()
                    .collect();
                    let mut fetch_uids = incremental_fetch_uids(Some(uid), &searched_uids);
                    // Fetch the oldest outstanding UIDs first. Persisting the
                    // resulting maximum UID then lets the next poll continue
                    // without skipping a gap, while bounding memory, download
                    // time and the amount repeated after a network failure.
                    fetch_uids.truncate(limit as usize);
                    if fetch_uids.is_empty() {
                        return Ok(Vec::new());
                    }
                    let uid_set = fetch_uids
                        .iter()
                        .map(u32::to_string)
                        .collect::<Vec<_>>()
                        .join(",");
                    let fetches = with_imap_timeout(
                        "UID FETCH",
                        IMAP_COMMAND_TIMEOUT_SECS,
                        $s.uid_fetch(&uid_set, "(UID BODY.PEEK[])"),
                    )
                    .await?;
                    let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
                        "UID FETCH collect",
                        IMAP_BODY_FETCH_TIMEOUT_SECS,
                        fetches.try_collect(),
                    )
                    .await?;
                    for fetch in fetches {
                        if let Some(uid) = fetch.uid {
                            if let Some(body) = fetch.body() {
                                results.push((uid, body.to_vec()));
                            }
                        } else {
                            tracing::warn!("Skipping message without UID (seq={})", fetch.message);
                        }
                    }
                } else {
                    let start = if exists > limit {
                        exists - limit + 1
                    } else {
                        1
                    };
                    return Self::fetch_messages_sequence_range($s, start, exists).await;
                }

                results
            }};
        }

        let results = do_fetch!(sess);

        Ok(results)
    }

    /// Fetch only RFC822 headers. Message bodies and attachments are fetched
    /// lazily when the user opens a message.
    pub async fn fetch_messages_headers(
        &self,
        mailbox: &str,
        since_uid: Option<u32>,
        limit: u32,
    ) -> Result<Vec<(u32, Vec<u8>)>> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;
        let info = with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, sess.select(mailbox)).await?;
        if info.exists == 0 {
            return Ok(Vec::new());
        }
        let uids = if let Some(uid) = since_uid {
            let next = uid.checked_add(1).ok_or_else(|| PebbleError::Validation("IMAP UID overflow".into()))?;
            if !should_search_incremental_uids(next, info.uid_next) {
                return Ok(Vec::new());
            }
            let searched: Vec<u32> = with_imap_timeout(
                "UID SEARCH",
                IMAP_COMMAND_TIMEOUT_SECS,
                sess.uid_search(format!("UID {next}:*")),
            ).await?.into_iter().collect();
            let mut uids = incremental_fetch_uids(Some(uid), &searched);
            // For the visible/realtime path, fetch the newest messages first.
            // The history cursor separately walks older sequence ranges, so
            // taking the newest bounded batch cannot permanently skip them.
            uids.sort_unstable_by(|left, right| right.cmp(left));
            uids.truncate(limit as usize);
            if uids.is_empty() {
                return Ok(Vec::new());
            }
            let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
            let fetches = with_imap_timeout(
                "UID FETCH headers",
                IMAP_COMMAND_TIMEOUT_SECS,
                sess.uid_fetch(&set, "(UID BODY.PEEK[HEADER])"),
            ).await?;
            let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
                "UID FETCH headers collect",
                IMAP_BODY_FETCH_TIMEOUT_SECS,
                fetches.try_collect(),
            ).await?;
            let results: Vec<(u32, Vec<u8>)> = fetches
                .into_iter()
                .filter_map(|f| f.uid.zip(f.header().map(Vec::from)))
                .collect();
            return Ok(results);
        } else {
            let start = info.exists.saturating_sub(limit).saturating_add(1).max(1);
            let set = if start == info.exists { start.to_string() } else { format!("{start}:{}", info.exists) };
            let fetches = with_imap_timeout(
                "FETCH headers",
                IMAP_COMMAND_TIMEOUT_SECS,
                sess.fetch(&set, "(UID BODY.PEEK[HEADER])"),
            ).await?;
            let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
                "FETCH headers collect",
                IMAP_BODY_FETCH_TIMEOUT_SECS,
                fetches.try_collect(),
            ).await?;
            let results: Vec<(u32, Vec<u8>)> = fetches
                .into_iter()
                .filter_map(|f| f.uid.zip(f.header().map(Vec::from)))
                .collect();
            results
        };
        Ok(uids)
    }

    /// Fetch ONLY the headers of a sequence range `[start_seq, end_seq]`
    /// (history backfill). Returns `(uid, header_bytes)` pairs. Headers are
    /// tiny, so even attachment-heavy mailboxes backfill quickly; the full
    /// MIME body is downloaded later when the user opens a message
    /// (`fetch_message_raw_by_uid`).
    pub async fn fetch_messages_headers_range(
        &self,
        mailbox: &str,
        start_seq: u32,
        end_seq: u32,
    ) -> Result<Vec<(u32, Vec<u8>)>> {
        if start_seq == 0 || end_seq < start_seq {
            return Ok(Vec::new());
        }
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        macro_rules! do_fetch {
            ($s:expr) => {{
                let mailbox_info = with_imap_timeout(
                    "SELECT",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    $s.select(mailbox),
                )
                .await?;
                if mailbox_info.exists == 0 || start_seq > mailbox_info.exists {
                    return Ok(Vec::new());
                }
                let end = end_seq.min(mailbox_info.exists);
                let set = if start_seq == end {
                    start_seq.to_string()
                } else {
                    format!("{start_seq}:{end}")
                };
                let fetches = with_imap_timeout(
                    "FETCH headers",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    $s.fetch(&set, "(UID BODY.PEEK[HEADER])"),
                )
                .await?;
                let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
                    "FETCH headers collect",
                    IMAP_BODY_FETCH_TIMEOUT_SECS,
                    fetches.try_collect(),
                )
                .await?;
                {
                    // 诊断：打印本次拉取的 UID 分布，验证 sequence 与 UID 是否错位。
                    let uids: Vec<u32> = fetches.iter().filter_map(|f| f.uid).collect();
                    if !uids.is_empty() {
                        let min = uids.iter().copied().min().unwrap_or(0);
                        let max = uids.iter().copied().max().unwrap_or(0);
                        info!(
                            "fetch_headers {mailbox} seq {start_seq}:{end_seq} -> {} msgs, UID min={min} max={max}",
                            uids.len()
                        );
                    }
                }
                let rows = fetches.into_iter().map(|f| f.uid.zip(f.header().map(Vec::from))
                    .ok_or_else(|| PebbleError::Sync("IMAP history response omitted UID or header".into())))
                    .collect::<Result<Vec<_>>>()?;
                if rows.len() != (end - start_seq + 1) as usize {
                    return Err(PebbleError::Sync("IMAP history page was incomplete; cursor not advanced".into()));
                }
                Ok(rows)
            }};
        }

        do_fetch!(sess)
    }

    /// Repair concrete history holes without walking sequence ranges again.
    pub async fn fetch_headers_by_uids(&self, mailbox: &str, expected_epoch: u32, uids: &[u32]) -> Result<Vec<(u32, Vec<u8>)>> {
        if uids.is_empty() { return Ok(Vec::new()); }
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard.as_mut().ok_or_else(|| PebbleError::Network("Not connected".into()))?;
        let selected = with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, sess.select(mailbox)).await?;
        let epoch = match selected.uid_validity {
            Some(epoch) => Some(epoch),
            None => with_imap_timeout("STATUS UIDVALIDITY", IMAP_STATUS_PROBE_TIMEOUT_SECS,
                sess.status(mailbox, "(UIDVALIDITY)")).await?.uid_validity,
        };
        if epoch != Some(expected_epoch) {
            return Err(PebbleError::Sync("IMAP UIDVALIDITY changed during header repair; retry next pass".into()));
        }
        *self.last_selected.lock().await = Some(mailbox.to_string());
        let set = uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let stream = with_imap_timeout("UID FETCH headers", IMAP_COMMAND_TIMEOUT_SECS,
            sess.uid_fetch(&set, "(UID BODY.PEEK[HEADER])")).await?;
        let fetched: Vec<async_imap::types::Fetch> = with_imap_timeout("UID FETCH headers collect",
            IMAP_BODY_FETCH_TIMEOUT_SECS, stream.try_collect()).await?;
        // The caller persists valid rows and records every omitted requested UID
        // as a retryable failure; one malformed message must not starve the rest.
        let rows = fetched.into_iter().filter_map(|f|f.uid.zip(f.header().map(Vec::from)))
            .filter(|(uid,_)|uids.contains(uid)).collect();
        Ok(rows)
    }

    /// Fetch one complete MIME message by UID when a header-only message is opened.
    ///
    /// Root-cause fix for large-message timeouts: instead of one BODY.PEEK[]
    /// that must transfer the whole message within a single timeout window,
    /// fetch in 1 MiB chunks using the RFC 3501 `<offset.length>` partial
    /// fetch syntax. Every chunk is tiny, so the per-command timeout is
    /// generous and never trips on big attachments; the result is the complete
    /// raw message (headers + body + all attachments) concatenated in order.
    pub async fn fetch_message_raw_by_uid(&self, mailbox: &str, uid: u32) -> Result<Vec<u8>> {
        const CHUNK: usize = 1024 * 1024; // 1 MiB per FETCH command
        let mut guard = self.session.lock().await;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;
        // 同一文件夹连续 FETCH 时跳过重复 SELECT（一次 SELECT 是一整轮网络往返，
        // 逐封拉取几百封时每封都 SELECT 会拖慢数倍）。
        let mut last = self.last_selected.lock().await;
        if last.as_deref() != Some(mailbox) {
            *last = None;
            with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, sess.select(mailbox)).await?;
            *last = Some(mailbox.to_string());
        }
        drop(last);

        let mut result = Vec::new();
        let mut expected_size: Option<usize> = None;
        let mut offset: u64 = 0;
        loop {
            // mail-parser can parse a valid text body from a truncated MIME
            // prefix, so always compare the fetched bytes with RFC822.SIZE.
            let query = if expected_size.is_none() {
                format!("(UID RFC822.SIZE BODY.PEEK[]<{offset}.{CHUNK}>)")
            } else {
                format!("(UID BODY.PEEK[]<{offset}.{CHUNK}>)")
            };
            let fetches = with_imap_timeout(
                "UID FETCH message chunk",
                IMAP_COMMAND_TIMEOUT_SECS,
                sess.uid_fetch(uid.to_string(), &query),
            )
            .await?;
            let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
                "UID FETCH message chunk collect",
                IMAP_BODY_FETCH_TIMEOUT_SECS,
                fetches.try_collect(),
            )
            .await?;
            let fetch = fetches.into_iter().find(|f| f.uid == Some(uid));
            if expected_size.is_none() {
                expected_size = fetch.as_ref().and_then(|f| f.size).map(|size| size as usize);
            }
            let chunk = fetch.and_then(|f| f.body().map(Vec::from));
            match chunk {
                Some(bytes) if !bytes.is_empty() => {
                    if let Some(expected) = expected_size {
                        if result.len().saturating_add(bytes.len()) > expected {
                            return Err(PebbleError::Sync(format!(
                                "IMAP message UID {uid} exceeded RFC822.SIZE: received at least {} of {expected} bytes",
                                result.len().saturating_add(bytes.len())
                            )));
                        }
                    }
                    offset += bytes.len() as u64;
                    result.extend_from_slice(&bytes);
                    if let Some(expected) = expected_size {
                        if result.len() == expected {
                            break;
                        }
                    }
                    // A chunk shorter than CHUNK means we reached the end of
                    // the message when no total size is available. If the
                    // server did advertise RFC822.SIZE, keep asking: some
                    // servers cap literals below the requested chunk size.
                    if bytes.len() < CHUNK {
                        if expected_size.is_none() {
                            break;
                        }
                    }
                }
                // An empty chunk is only an end marker when no size was
                // advertised (or the advertised size has already arrived).
                _ => {
                    // Keep the legacy non-partial fallback available when a
                    // server omits the literal for the very first partial
                    // request. Once progress has been made, an empty chunk
                    // before RFC822.SIZE is a real truncation.
                    if result.is_empty() {
                        break;
                    }
                    if let Some(expected) = expected_size {
                        if result.len() < expected {
                            return Err(PebbleError::Sync(format!(
                                "IMAP message UID {uid} incomplete: received {} of {expected} bytes",
                                result.len()
                            )));
                        }
                    }
                    break;
                }
            }
        }

        // Compatibility fallback: a few servers return a valid response for
        // BODY.PEEK[] but omit the literal for partial BODY[]<offset.length>
        // requests. One non-partial fetch avoids falsely treating those
        // messages as missing while keeping the chunked path for large mail.
        if result.is_empty() {
            let fetches = with_imap_timeout(
                "UID FETCH message compatibility fallback",
                IMAP_COMMAND_TIMEOUT_SECS,
                sess.uid_fetch(uid.to_string(), "(UID RFC822.SIZE BODY.PEEK[])"),
            )
            .await?;
            let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
                "UID FETCH message compatibility fallback collect",
                IMAP_BODY_FETCH_TIMEOUT_SECS,
                fetches.try_collect(),
            )
            .await?;
            if let Some(fetch) = fetches.into_iter().find(|fetch| fetch.uid == Some(uid)) {
                let fallback_size = fetch.size.map(|size| size as usize).or(expected_size);
                if let Some(body) = fetch.body().map(Vec::from) {
                    if let Some(expected) = fallback_size {
                        if body.len() != expected {
                            return Err(PebbleError::Sync(format!(
                                "IMAP message UID {uid} incomplete: received {} of {expected} bytes",
                                body.len()
                            )));
                        }
                    }
                    result = body;
                }
            }
        }

        if result.is_empty() {
            return Err(PebbleError::Sync(format!("IMAP message UID {uid} has no body")));
        }
        if let Some(expected) = expected_size {
            if result.len() != expected {
                return Err(PebbleError::Sync(format!(
                    "IMAP message UID {uid} incomplete: received {} of {expected} bytes",
                    result.len()
                )));
            }
        }
        Ok(result)
    }

    /// 批量按 UID 拉取原始邮件（BODY.PEEK[]，无分片）。一次 SELECT + 一次
    /// UID FETCH 多封，显著减少网络往返（每封 1 次 SELECT 的浪费）。
    ///
    /// 调用方应控制 uids 长度（如 ≤10），避免单次 FETCH 响应过大撑爆内存；
    /// 超大附件邮件仍走 fetch_message_raw_by_uid 的分片路径。返回
    /// `(uid, raw_bytes)` 按服务器响应顺序。
    pub async fn fetch_messages_raw_by_uids(
        &self,
        mailbox: &str,
        uids: &[u32],
    ) -> Result<Vec<(u32, Vec<u8>)>> {
        Ok(self.fetch_messages_raw_by_uids_with_sizes(mailbox, uids).await?
            .into_iter().map(|(uid, raw, _)| (uid, raw)).collect())
    }

    /// Keep the size advertised with each body. A separate size-only FETCH
    /// can describe a different MIME representation on some servers.
    pub async fn fetch_messages_raw_by_uids_with_sizes(
        &self,
        mailbox: &str,
        uids: &[u32],
    ) -> Result<Vec<(u32, Vec<u8>, Option<u32>)>> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let mut guard = self.session.lock().await;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;
        let mut last = self.last_selected.lock().await;
        if last.as_deref() != Some(mailbox) {
            *last = None;
            with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, sess.select(mailbox)).await?;
            *last = Some(mailbox.to_string());
        }
        drop(last);

        let uid_set = uids
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let fetches = with_imap_timeout(
            "UID FETCH batch",
            IMAP_COMMAND_TIMEOUT_SECS,
            sess.uid_fetch(&uid_set, "(UID RFC822.SIZE BODY.PEEK[])"),
        )
        .await?;
        // 批量拉取本来就是为提速：若服务器（如 Zoho）对批量支持差、5 封也要
        // 拉很久，最多等 30s 就失败，由调用方降级为逐封分片拉取（更稳），
        // 避免每批都白等 120s 导致整体反而更慢。
        let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
            "UID FETCH batch collect",
            30,
            fetches.try_collect(),
        )
        .await?;
        let mut results = Vec::with_capacity(fetches.len());
        for fetch in fetches {
            if let Some(uid) = fetch.uid {
                if let Some(body) = fetch.body() {
                    results.push((uid, Vec::from(body), fetch.size));
                }
            }
        }
        Ok(results)
    }

    /// 批量按 UID 获取每封邮件的大小（RFC822.SIZE，单位字节）。
    /// 响应只有 uid+size 两列，极小，几百封一次命令也不会超时——
    /// 这是"先摸清大小、再决定批量还是单封"的成熟策略的第一步。
    /// 返回 `(uid, size_bytes)` 按服务器响应顺序。
    pub async fn fetch_message_sizes_by_uids(
        &self,
        mailbox: &str,
        uids: &[u32],
    ) -> Result<Vec<(u32, u32)>> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }
        let mut guard = self.session.lock().await;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;
        let mut last = self.last_selected.lock().await;
        if last.as_deref() != Some(mailbox) {
            *last = None;
            with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, sess.select(mailbox)).await?;
            *last = Some(mailbox.to_string());
        }
        drop(last);

        let uid_set = uids
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let fetches = with_imap_timeout(
            "UID FETCH sizes",
            IMAP_COMMAND_TIMEOUT_SECS,
            sess.uid_fetch(&uid_set, "(UID RFC822.SIZE)"),
        )
        .await?;
        let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
            "UID FETCH sizes collect",
            IMAP_COMMAND_TIMEOUT_SECS,
            fetches.try_collect(),
        )
        .await?;
        let mut results = Vec::with_capacity(fetches.len());
        for fetch in fetches {
            if let Some(uid) = fetch.uid {
                if let Some(size) = fetch.size {
                    results.push((uid, size));
                } else {
                    // A returned UID without SIZE is not evidence that this
                    // UID vanished. Let the caller use a full-body fetch.
                    return Err(PebbleError::Sync(
                        "IMAP size response omitted RFC822.SIZE for an existing UID".into(),
                    ));
                }
            }
        }
        Ok(results)
    }

    /// Fetch the raw bytes of the messages whose sequence numbers fall within
    /// `[start_seq, end_seq]` (inclusive), after selecting `mailbox`.
    ///
    /// Sequence numbers are stable for the lifetime of a session; callers that
    /// page backwards through a mailbox must issue these fetches on the same
    /// connection. Returns `(uid, raw_bytes)` pairs ordered by the server
    /// response, which is ascending sequence number.
    pub async fn fetch_messages_page(
        &self,
        mailbox: &str,
        start_seq: u32,
        end_seq: u32,
    ) -> Result<Vec<(u32, Vec<u8>)>> {
        if start_seq == 0 || end_seq < start_seq {
            return Ok(Vec::new());
        }
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        macro_rules! do_fetch {
            ($s:expr) => {{
                let mailbox_info =
                    with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, $s.select(mailbox))
                        .await?;
                if mailbox_info.exists == 0 || start_seq > mailbox_info.exists {
                    return Ok(Vec::new());
                }
                let end_seq = end_seq.min(mailbox_info.exists);
                Self::fetch_messages_sequence_range($s, start_seq, end_seq).await?
            }};
        }

        let results = do_fetch!(sess);

        Ok(results)
    }

    /// Fetch the raw bytes of the messages whose sequence numbers fall within
    /// `[start_seq, end_seq]` (inclusive). The caller must have already
    /// selected the mailbox on the same session.
    async fn fetch_messages_sequence_range(
        sess: &mut ImapSession,
        start_seq: u32,
        end_seq: u32,
    ) -> Result<Vec<(u32, Vec<u8>)>> {
        let seq_set = if start_seq == end_seq {
            start_seq.to_string()
        } else {
            format!("{start_seq}:{end_seq}")
        };
        let fetches = with_imap_timeout(
            "FETCH",
            IMAP_COMMAND_TIMEOUT_SECS,
            sess.fetch(&seq_set, "(UID BODY.PEEK[])"),
        )
        .await?;
        let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
            "FETCH collect",
            IMAP_BODY_FETCH_TIMEOUT_SECS,
            fetches.try_collect(),
        )
        .await?;
        let mut results = Vec::with_capacity(fetches.len());
        for fetch in fetches {
            if let Some(uid) = fetch.uid {
                if let Some(body) = fetch.body() {
                    results.push((uid, body.to_vec()));
                }
            } else {
                tracing::warn!("Skipping message without UID (seq={})", fetch.message);
            }
        }
        Ok(results)
    }

    /// Fetch flags for a set of UIDs. Returns `(uid, is_read, is_starred)`.
    pub async fn fetch_flags(&self, mailbox: &str, uids: &[u32]) -> Result<Vec<(u32, bool, bool)>> {
        if uids.is_empty() {
            return Ok(Vec::new());
        }

        let uid_set: String = uids
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        macro_rules! do_flags {
            ($s:expr) => {{
                with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, $s.select(mailbox)).await?;

                let fetches = with_imap_timeout(
                    "UID FETCH FLAGS",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    $s.uid_fetch(&uid_set, "FLAGS"),
                )
                .await?;
                let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
                    "FLAGS collect",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    fetches.try_collect(),
                )
                .await?;

                fetches
                    .into_iter()
                    .filter_map(|fetch| {
                        let uid = fetch.uid.or_else(|| {
                            tracing::warn!(
                                "Skipping flags for message without UID (seq={})",
                                fetch.message
                            );
                            None
                        })?;
                        let (is_read, is_starred) = parse_flags(fetch.flags());
                        Some((uid, is_read, is_starred))
                    })
                    .collect::<Vec<_>>()
            }};
        }

        let results = do_flags!(sess);
        Ok(results)
    }

    /// Set flags on a message identified by UID.
    pub async fn set_flags(
        &self,
        mailbox: &str,
        uid: u32,
        is_read: Option<bool>,
        is_starred: Option<bool>,
    ) -> Result<()> {
        let uid_str = uid.to_string();

        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        macro_rules! do_store {
            ($s:expr) => {{
                with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, $s.select(mailbox)).await?;

                if let Some(read) = is_read {
                    let flag_cmd = if read {
                        format!("+FLAGS (\\Seen)")
                    } else {
                        format!("-FLAGS (\\Seen)")
                    };
                    let store_result = with_imap_timeout(
                        "STORE \\Seen",
                        IMAP_COMMAND_TIMEOUT_SECS,
                        $s.uid_store(&uid_str, &flag_cmd),
                    )
                    .await?;
                    let _: Vec<async_imap::types::Fetch> = with_imap_timeout(
                        "STORE \\Seen collect",
                        IMAP_COMMAND_TIMEOUT_SECS,
                        store_result.try_collect(),
                    )
                    .await?;
                }

                if let Some(starred) = is_starred {
                    let flag_cmd = if starred {
                        format!("+FLAGS (\\Flagged)")
                    } else {
                        format!("-FLAGS (\\Flagged)")
                    };
                    let store_result = with_imap_timeout(
                        "STORE \\Flagged",
                        IMAP_COMMAND_TIMEOUT_SECS,
                        $s.uid_store(&uid_str, &flag_cmd),
                    )
                    .await?;
                    let _: Vec<async_imap::types::Fetch> = with_imap_timeout(
                        "STORE \\Flagged collect",
                        IMAP_COMMAND_TIMEOUT_SECS,
                        store_result.try_collect(),
                    )
                    .await?;
                }
            }};
        }

        do_store!(sess);

        Ok(())
    }

    /// Move a message by UID from one mailbox to another.
    ///
    /// Tries IMAP MOVE (uid_mv) first, falls back to UID COPY + UID STORE \Deleted + EXPUNGE.
    /// One-shot wrapper around [`move_message_with_dedup`] with retry-dedup disabled.
    pub async fn move_message(
        &self,
        source_mailbox: &str,
        uid: u32,
        dest_mailbox: &str,
    ) -> Result<()> {
        self.move_message_with_dedup(source_mailbox, uid, dest_mailbox, None)
            .await
    }

    /// Move a message by UID with an idempotent COPY fallback.
    ///
    /// Pass the message's `Message-ID` header so that, on retry after a partial
    /// COPY/EXPUNGE failure, the destination is searched for a matching copy
    /// before COPY runs — preventing duplicate messages. `None` or an empty
    /// header disables the check (one-shot move). `STORE \Deleted` + `EXPUNGE`
    /// are always run and are themselves idempotent.
    pub async fn move_message_with_dedup(
        &self,
        source_mailbox: &str,
        uid: u32,
        dest_mailbox: &str,
        message_id_header: Option<&str>,
    ) -> Result<()> {
        let uid_str = uid.to_string();

        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        macro_rules! do_move {
            ($s:expr) => {{
                with_imap_timeout(
                    "SELECT",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    $s.select(source_mailbox),
                )
                .await?;

                // Try MOVE extension first
                match with_imap_timeout(
                    "UID MOVE",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    $s.uid_mv(&uid_str, dest_mailbox),
                )
                .await
                {
                    Ok(_) => {
                        debug!(
                            "MOVE UID {} from {} to {} succeeded",
                            uid, source_mailbox, dest_mailbox
                        );
                    }
                    Err(_move_err) => {
                        // Fallback: COPY + flag Deleted + EXPUNGE
                        debug!(
                            "MOVE not supported, falling back to COPY+DELETE for UID {}",
                            uid
                        );

                        // Idempotency: on retry after a partial COPY/EXPUNGE
                        // failure the destination may already hold a copy (COPY
                        // preserves the Message-ID header). Search the dest and
                        // skip COPY if a match is found, so a retried move does
                        // not create duplicates. Any error here is treated as
                        // "no match" (fall through to COPY) — never block the move.
                        let mut already_copied = false;
                        if let Some(h) = message_id_header {
                            if !h.is_empty() {
                                let criteria = format!(
                                    "HEADER \"Message-ID\" \"{}\"",
                                    h.replace('\\', "\\\\").replace('"', "\\\"")
                                );
                                let dest_selected = with_imap_timeout(
                                    "SELECT",
                                    IMAP_COMMAND_TIMEOUT_SECS,
                                    $s.select(dest_mailbox),
                                )
                                .await
                                .is_ok();
                                if dest_selected {
                                    already_copied = match with_imap_timeout(
                                        "UID SEARCH",
                                        IMAP_COMMAND_TIMEOUT_SECS,
                                        $s.uid_search(criteria.as_str()),
                                    )
                                    .await
                                    {
                                        Ok(hits) => hits.into_iter().next().is_some(),
                                        Err(_) => false,
                                    };
                                }
                            }
                        }

                        // Re-select source (restores selection after the dest
                        // search above and in case the MOVE attempt changed state).
                        with_imap_timeout(
                            "SELECT",
                            IMAP_COMMAND_TIMEOUT_SECS,
                            $s.select(source_mailbox),
                        )
                        .await?;

                        if !already_copied {
                            with_imap_timeout(
                                "UID COPY",
                                IMAP_COMMAND_TIMEOUT_SECS,
                                $s.uid_copy(&uid_str, dest_mailbox),
                            )
                            .await?;
                        }

                        let store_result = with_imap_timeout(
                            "STORE \\Deleted",
                            IMAP_COMMAND_TIMEOUT_SECS,
                            $s.uid_store(&uid_str, "+FLAGS (\\Deleted)"),
                        )
                        .await?;
                        let _: Vec<async_imap::types::Fetch> = with_imap_timeout(
                            "STORE \\Deleted collect",
                            IMAP_COMMAND_TIMEOUT_SECS,
                            store_result.try_collect(),
                        )
                        .await?;

                        let expunge_result =
                            with_imap_timeout("EXPUNGE", IMAP_COMMAND_TIMEOUT_SECS, $s.expunge())
                                .await?;
                        let _: Vec<u32> = with_imap_timeout(
                            "EXPUNGE collect",
                            IMAP_COMMAND_TIMEOUT_SECS,
                            expunge_result.try_collect(),
                        )
                        .await?;

                        debug!(
                            "COPY+DELETE UID {} from {} to {} succeeded",
                            uid, source_mailbox, dest_mailbox
                        );
                    }
                }
            }};
        }

        do_move!(sess);

        Ok(())
    }

    /// Resolve the UID currently assigned to a Message-ID inside one mailbox.
    /// This is used after IMAP MOVE/COPY because destination UIDs are mailbox
    /// scoped and are usually different from the source UID.
    pub async fn find_uid_by_message_id(
        &self,
        mailbox: &str,
        message_id_header: &str,
    ) -> Result<Option<u32>> {
        if message_id_header.trim().is_empty() {
            return Ok(None);
        }
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;
        with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, sess.select(mailbox)).await?;
        let criteria = format!(
            "HEADER \"Message-ID\" \"{}\"",
            message_id_header.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let hits = with_imap_timeout(
            "UID SEARCH destination Message-ID",
            IMAP_COMMAND_TIMEOUT_SECS,
            sess.uid_search(criteria.as_str()),
        )
        .await?;
        let uid = hits.into_iter().max();
        *self.last_selected.lock().await = Some(mailbox.to_string());
        Ok(uid)
    }

    /// Delete a message by UID: flag as \Deleted and EXPUNGE.
    pub async fn delete_message(&self, mailbox: &str, uid: u32) -> Result<()> {
        let uid_str = uid.to_string();

        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        macro_rules! do_delete {
            ($s:expr) => {{
                with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, $s.select(mailbox)).await?;

                let store_result = with_imap_timeout(
                    "STORE \\Deleted",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    $s.uid_store(&uid_str, "+FLAGS (\\Deleted)"),
                )
                .await?;
                let _: Vec<async_imap::types::Fetch> = with_imap_timeout(
                    "STORE \\Deleted collect",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    store_result.try_collect(),
                )
                .await?;

                let expunge_result =
                    with_imap_timeout("EXPUNGE", IMAP_COMMAND_TIMEOUT_SECS, $s.expunge()).await?;
                let _: Vec<u32> = with_imap_timeout(
                    "EXPUNGE collect",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    expunge_result.try_collect(),
                )
                .await?;

                debug!("Deleted UID {} from {}", uid, mailbox);
            }};
        }

        do_delete!(sess);

        Ok(())
    }

    /// Create a new mailbox on the server.
    pub async fn create_folder(&self, name: &str) -> Result<()> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;
        with_imap_timeout("CREATE", IMAP_COMMAND_TIMEOUT_SECS, sess.create(name)).await?;
        Ok(())
    }

    /// Rename an existing mailbox on the server.
    pub async fn rename_folder(&self, old_name: &str, new_name: &str) -> Result<()> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;
        with_imap_timeout(
            "RENAME",
            IMAP_COMMAND_TIMEOUT_SECS,
            sess.rename(old_name, new_name),
        )
        .await?;
        Ok(())
    }

    /// Delete an existing mailbox on the server.
    pub async fn delete_folder(&self, name: &str) -> Result<()> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;
        with_imap_timeout("DELETE", IMAP_COMMAND_TIMEOUT_SECS, sess.delete(name)).await?;
        Ok(())
    }

    /// Keep the selected mailbox status and UID search on the same session.
    pub async fn fetch_uid_inventory(&self, mailbox: &str) -> Result<(ImapMailboxStatus, Vec<u32>)> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        let selected = with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, sess.select(mailbox)).await?;
        let uids = with_imap_timeout("UID SEARCH ALL", IMAP_COMMAND_TIMEOUT_SECS, sess.uid_search("ALL"))
            .await?.into_iter().collect();
        let epoch = match selected.uid_validity {
            Some(epoch) => Some(epoch),
            None => {
                let status = with_imap_timeout("STATUS UIDVALIDITY", IMAP_STATUS_PROBE_TIMEOUT_SECS,
                    sess.status(mailbox, "(MESSAGES UIDNEXT UIDVALIDITY)")).await?;
                if status.exists != selected.exists || matches!((status.uid_next, selected.uid_next), (Some(a), Some(b)) if a != b) {
                    return Err(PebbleError::Sync("IMAP inventory changed while reading UIDVALIDITY; retry next pass".into()));
                }
                status.uid_validity
            }
        };
        Ok((ImapMailboxStatus { uid_validity: epoch, uid_next: selected.uid_next,
            highest_modseq: selected.highest_modseq, exists: selected.exists }, uids))
    }

    /// Check if the server advertises the CONDSTORE capability (RFC 4551).
    pub async fn supports_condstore(&self) -> bool {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = match guard.as_mut() {
            Some(s) => s,
            None => return false,
        };

        match with_imap_timeout("CAPABILITY", IMAP_COMMAND_TIMEOUT_SECS, sess.capabilities()).await
        {
            Ok(caps) => caps.has_str("CONDSTORE"),
            Err(_) => false,
        }
    }

    /// SELECT a mailbox and return the HIGHESTMODSEQ value if the server supports CONDSTORE.
    /// Returns `Ok(Some(modseq))` if available, `Ok(None)` otherwise.
    pub async fn get_highest_modseq(&self, mailbox: &str) -> Result<Option<u64>> {
        Ok(self.get_mailbox_status(mailbox).await?.highest_modseq)
    }

    /// SELECT a mailbox and return the UIDVALIDITY/HIGHESTMODSEQ values advertised by the server.
    pub async fn get_mailbox_status(&self, mailbox: &str) -> Result<ImapMailboxStatus> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        macro_rules! do_select {
            ($s:expr) => {{
                let mailbox_info =
                    with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, $s.select(mailbox))
                        .await?;
                ImapMailboxStatus {
                    uid_validity: mailbox_info.uid_validity,
                    uid_next: mailbox_info.uid_next,
                    highest_modseq: mailbox_info.highest_modseq,
                    exists: mailbox_info.exists,
                }
            }};
        }

        let mut result = do_select!(sess);
        // Some servers omit the response code on repeated SELECT. Obtain a
        // fresh epoch from the same mailbox, never from an old local cursor.
        if result.uid_validity.is_none() {
            let status = with_imap_timeout(
                "STATUS UIDVALIDITY", IMAP_STATUS_PROBE_TIMEOUT_SECS,
                sess.status(mailbox, "(MESSAGES UIDNEXT UIDVALIDITY)"),
            ).await.map_err(|error| PebbleError::Network(format!(
                "IMAP UIDVALIDITY unavailable; local history unchanged: {error}"
            )))?;
            result.uid_validity = status.uid_validity;
            result.uid_next = result.uid_next.or(status.uid_next);
            if result.uid_validity.is_none() {
                return Err(PebbleError::Network(
                    "IMAP UIDVALIDITY unavailable after SELECT and STATUS; local history unchanged".into()
                ));
            }
        }
        Ok(result)
    }

    /// Probe a mailbox without selecting it. This is used for custom-folder
    /// new-mail checks so dozens of folders do not incur full SELECT/SEARCH
    /// work every few seconds.
    pub async fn probe_mailbox_status(&self, mailbox: &str) -> Result<ImapMailboxStatus> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;
        let info = with_imap_timeout(
            "STATUS",
            IMAP_STATUS_PROBE_TIMEOUT_SECS,
            sess.status(mailbox, "(MESSAGES UIDNEXT UIDVALIDITY)"),
        )
        .await?;
        Ok(ImapMailboxStatus {
            uid_validity: info.uid_validity,
            uid_next: info.uid_next,
            highest_modseq: None,
            exists: info.exists,
        })
    }

    /// Fetch flags for a set of UIDs along with per-message MODSEQ values.
    /// Returns `(flags_vec, highest_modseq)` where highest_modseq is the maximum
    /// MODSEQ seen across all fetched messages (or 0 if the server did not return any).
    pub async fn fetch_flags_with_modseq(
        &self,
        mailbox: &str,
        uids: &[u32],
    ) -> Result<(Vec<(u32, bool, bool)>, u64)> {
        if uids.is_empty() {
            return Ok((Vec::new(), 0));
        }

        let uid_set: String = uids
            .iter()
            .map(|u| u.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = guard
            .as_mut()
            .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?;

        macro_rules! do_flags_modseq {
            ($s:expr) => {{
                with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, $s.select(mailbox)).await?;

                let fetches = with_imap_timeout(
                    "UID FETCH FLAGS MODSEQ",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    $s.uid_fetch(&uid_set, "(FLAGS MODSEQ)"),
                )
                .await?;
                let fetches: Vec<async_imap::types::Fetch> = with_imap_timeout(
                    "FLAGS MODSEQ collect",
                    IMAP_COMMAND_TIMEOUT_SECS,
                    fetches.try_collect(),
                )
                .await?;

                let mut highest = 0u64;
                let results: Vec<(u32, bool, bool)> = fetches
                    .into_iter()
                    .filter_map(|fetch| {
                        let uid = fetch.uid.or_else(|| {
                            tracing::warn!(
                                "Skipping modseq flags for message without UID (seq={})",
                                fetch.message
                            );
                            None
                        })?;
                        if let Some(ms) = fetch.modseq {
                            if ms > highest {
                                highest = ms;
                            }
                        }
                        let (is_read, is_starred) = parse_flags(fetch.flags());
                        Some((uid, is_read, is_starred))
                    })
                    .collect();

                (results, highest)
            }};
        }

        let results = do_flags_modseq!(sess);

        Ok(results)
    }

    /// Check if the server advertises the IDLE capability (RFC 2177).
    pub async fn supports_idle(&self) -> bool {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        let sess = match guard.as_mut() {
            Some(s) => s,
            None => return false,
        };

        match with_imap_timeout("CAPABILITY", IMAP_COMMAND_TIMEOUT_SECS, sess.capabilities()).await
        {
            Ok(caps) => caps.has_str("IDLE"),
            Err(_) => false,
        }
    }

    /// Enter IMAP IDLE mode and wait for server notifications or timeout.
    ///
    /// The session is temporarily taken out of `self.session` while IDLE is
    /// active and restored when the command completes (or on error).
    /// Timeout should be <= 29 minutes per RFC 2177 recommendation.
    pub async fn idle_wait(
        &self,
        mailbox: &str,
        timeout_dur: std::time::Duration,
    ) -> Result<super::idle::IdleEvent> {
        // Take the session out so we can pass ownership to the idle handle.
        let sess = {
            let mut guard = self.session.lock().await;
            *self.last_selected.lock().await = None;
            guard
                .take()
                .ok_or_else(|| PebbleError::Network("Not connected".to_string()))?
        };

        // Select the mailbox first.
        let mut session = sess;
        if let Err(e) =
            with_imap_timeout("SELECT", IMAP_COMMAND_TIMEOUT_SECS, session.select(mailbox)).await
        {
            // Restore session before returning error.
            let mut guard = self.session.lock().await;
            *self.last_selected.lock().await = None;
            *guard = Some(session);
            return Err(e);
        }

        let mut idle_handle = session.idle();
        if let Err(e) =
            with_imap_timeout("IDLE init", IMAP_COMMAND_TIMEOUT_SECS, idle_handle.init()).await
        {
            // init() failed; the handle still owns the session.
            // Call done() to recover the session.
            match idle_handle.done().await {
                Ok(recovered) => {
                    let mut guard = self.session.lock().await;
                    *self.last_selected.lock().await = None;
                    *guard = Some(recovered);
                }
                Err(_) => {
                    // Session is lost; caller will need to reconnect.
                }
            }
            return Err(e);
        }

        let (wait_fut, _stop_source) = idle_handle.wait_with_timeout(timeout_dur);
        let idle_result = wait_fut.await;

        // Recover the session by sending DONE.
        let event = match idle_result {
            Ok(resp) => {
                use async_imap::extensions::idle::IdleResponse;
                match resp {
                    IdleResponse::NewData(_) => super::idle::IdleEvent::NewMail,
                    IdleResponse::Timeout => super::idle::IdleEvent::Timeout,
                    IdleResponse::ManualInterrupt => super::idle::IdleEvent::Timeout,
                }
            }
            Err(e) => super::idle::IdleEvent::Error(format!("IDLE wait error: {e}")),
        };

        match idle_handle.done().await {
            Ok(recovered) => {
                let mut guard = self.session.lock().await;
                *self.last_selected.lock().await = None;
                *guard = Some(recovered);
            }
            Err(_) => {
                // Session is lost; caller will need to reconnect.
                tracing::warn!("Failed to recover session after IDLE DONE");
            }
        }

        Ok(event)
    }

    /// Disconnect from the IMAP server.
    pub async fn disconnect(&self) -> Result<()> {
        let mut guard = self.session.lock().await;
        *self.last_selected.lock().await = None;
        if let Some(sess) = guard.as_mut() {
            let _ = sess.logout().await;
            *guard = None;
        }
        Ok(())
    }
}

/// Parse flags from an iterator of `Flag` values.
fn parse_flags<'a>(flags: impl Iterator<Item = async_imap::types::Flag<'a>>) -> (bool, bool) {
    let mut is_read = false;
    let mut is_starred = false;
    for flag in flags {
        match flag {
            async_imap::types::Flag::Seen => is_read = true,
            async_imap::types::Flag::Flagged => is_starred = true,
            _ => {}
        }
    }
    (is_read, is_starred)
}

fn should_sync_listed_mailbox(attributes: &[NameAttribute<'_>]) -> bool {
    !attributes
        .iter()
        .any(|attribute| matches!(attribute, NameAttribute::NoSelect))
}

fn detect_folder_role_from_attributes(attributes: &[NameAttribute<'_>]) -> Option<FolderRole> {
    attributes.iter().find_map(|attribute| match attribute {
        NameAttribute::Archive => Some(FolderRole::Archive),
        NameAttribute::Drafts => Some(FolderRole::Drafts),
        NameAttribute::Junk => Some(FolderRole::Spam),
        NameAttribute::Sent => Some(FolderRole::Sent),
        NameAttribute::Trash => Some(FolderRole::Trash),
        NameAttribute::Extension(value) if value.eq_ignore_ascii_case("\\Inbox") => {
            Some(FolderRole::Inbox)
        }
        _ => None,
    })
}

/// Detect a folder role based on its name.
pub fn detect_folder_role(name: &str) -> Option<FolderRole> {
    let lower = name.to_lowercase();
    // Check last component after hierarchy separator
    let leaf = lower.rsplit('/').next().unwrap_or(&lower);
    let leaf = leaf.rsplit('.').next().unwrap_or(leaf);

    if leaf == "inbox" || leaf == "收件箱" {
        Some(FolderRole::Inbox)
    } else if leaf.contains("sent") || leaf.contains("已发送") || leaf.contains("已发件") {
        Some(FolderRole::Sent)
    } else if leaf.contains("draft") || leaf.contains("草稿") {
        Some(FolderRole::Drafts)
    } else if leaf.contains("trash")
        || leaf.contains("deleted")
        || leaf.contains("已删除")
        || leaf.contains("废纸篓")
    {
        Some(FolderRole::Trash)
    } else if leaf.contains("archive") || leaf.contains("归档") || leaf.contains("存档") {
        Some(FolderRole::Archive)
    } else if leaf.contains("spam")
        || leaf.contains("junk")
        || leaf.contains("垃圾")
        || leaf.contains("病毒")
        || leaf.contains("广告")
    {
        Some(FolderRole::Spam)
    } else {
        None
    }
}

/// Sort order for folder roles.
pub fn folder_sort_order(role: &Option<FolderRole>) -> i32 {
    match role {
        Some(FolderRole::Inbox) => 0,
        Some(FolderRole::Drafts) => 1,
        Some(FolderRole::Sent) => 2,
        Some(FolderRole::Archive) => 3,
        Some(FolderRole::Spam) => 4,
        Some(FolderRole::Trash) => 5,
        None => 100,
    }
}

#[cfg(test)]
mod mailbox_session_regression_tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    async fn fixture(status_epoch: bool, omit_size: bool) -> (ImapProvider, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (read, mut write) = socket.into_split();
            write.write_all(b"* OK fixture ready\r\n").await.unwrap();
            let mut lines = BufReader::new(read).lines();
            let mut selected_a = false;
            while let Some(line) = lines.next_line().await.unwrap() {
                let (tag, cmd) = line.split_once(' ').unwrap();
                let cmd = cmd.to_ascii_uppercase();
                let data = if cmd.starts_with("LOGIN") { String::new() }
                else if cmd.starts_with("SELECT") {
                    selected_a = cmd.contains("FOLDER_A");
                    format!("* 1 EXISTS\r\n{}", if selected_a { "* OK [UIDVALIDITY 7] epoch\r\n" } else { "" })
                } else if cmd.starts_with("STATUS") {
                    format!("* STATUS FOLDER_B (MESSAGES 1 UIDNEXT 2{})\r\n", if status_epoch { " UIDVALIDITY 9" } else { "" })
                } else if cmd.starts_with("UID FETCH") {
                    let body = if selected_a { "abcdefghij" } else { "WRONG" };
                    if cmd.contains("BODY") {
                        format!("* 1 FETCH (UID 1 RFC822.SIZE {} BODY[] {{{}}}\r\n{})\r\n",body.len(),body.len(),body)
                    } else if omit_size {
                        "* 1 FETCH (UID 1)\r\n".into()
                    } else { "* 1 FETCH (UID 1 RFC822.SIZE 5)\r\n".into() }
                } else if cmd.starts_with("LOGOUT") { break }
                else { panic!("unexpected fixture command") };
                write.write_all(format!("{data}{tag} OK complete\r\n").as_bytes()).await.unwrap();
            }
        });
        let provider = ImapProvider::new(serde_json::from_value(serde_json::json!({
            "host":"127.0.0.1","port":port,"username":"fixture","password":"fixture","security":"plain"
        })).unwrap());
        provider.connect().await.unwrap();
        (provider, server)
    }

    #[tokio::test]
    async fn status_switch_cannot_redirect_cached_body_fetch() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (p, server) = fixture(true, false).await;
            assert_eq!(p.fetch_message_sizes_by_uids("FOLDER_A", &[1]).await.unwrap(), vec![(1,5)]);
            assert_eq!(p.get_mailbox_status("FOLDER_B").await.unwrap().uid_validity, Some(9));
            assert_eq!(p.fetch_messages_raw_by_uids("FOLDER_A", &[1]).await.unwrap(), vec![(1,b"abcdefghij".to_vec())]);
            server.abort();
        }).await.unwrap();
    }

    #[tokio::test]
    async fn absent_epoch_after_select_and_status_remains_retryable_error() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (p, server) = fixture(false, false).await;
            let error = p.get_mailbox_status("FOLDER_B").await.unwrap_err();
            assert!(matches!(error, PebbleError::Network(ref message) if message.contains("IMAP UIDVALIDITY unavailable")));
            server.abort();
        }).await.unwrap();
    }

    #[tokio::test]
    async fn batch_body_keeps_its_own_size_instead_of_the_old_estimate() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (p, server) = fixture(true, false).await;
            assert_eq!(p.fetch_message_sizes_by_uids("FOLDER_A", &[1]).await.unwrap(), vec![(1,5)]);
            let fetched = p.fetch_messages_raw_by_uids_with_sizes("FOLDER_A", &[1]).await.unwrap();
            assert_eq!(fetched, vec![(1,b"abcdefghij".to_vec(),Some(10))]);
            assert_eq!(fetched[0].1.len(), fetched[0].2.unwrap() as usize);
            server.abort();
        }).await.unwrap();
    }

    #[tokio::test]
    async fn existing_uid_without_size_is_not_reported_as_missing() {
        tokio::time::timeout(Duration::from_secs(5), async {
            let (p, server) = fixture(true, true).await;
            assert!(p.fetch_message_sizes_by_uids("FOLDER_A", &[1]).await.is_err());
            server.abort();
        }).await.unwrap();
    }
}

#[cfg(test)]
mod tls_config_tests {
    use super::{
        build_native_tls_connector, build_tls_connector, imap_timeout_error, ImapConfig, SmtpConfig,
    };

    #[test]
    fn build_tls_connector_returns_result() {
        assert!(build_tls_connector(false).is_ok());
        assert!(build_tls_connector(true).is_ok());
    }

    #[test]
    fn build_native_tls_connector_returns_result() {
        assert!(build_native_tls_connector(false).is_ok());
        assert!(build_native_tls_connector(true).is_ok());
    }

    #[test]
    fn imap_config_defaults_to_certificate_verification() {
        let config: ImapConfig = serde_json::from_value(serde_json::json!({
            "host": "mail.example.com",
            "port": 993,
            "username": "user",
            "password": "secret",
            "security": "tls"
        }))
        .unwrap();

        assert!(!config.accept_invalid_certs);
    }

    #[test]
    fn smtp_config_preserves_invalid_certificate_override() {
        let config: SmtpConfig = serde_json::from_value(serde_json::json!({
            "host": "mail.example.com",
            "port": 465,
            "username": "user",
            "password": "secret",
            "security": "tls",
            "accept_invalid_certs": true
        }))
        .unwrap();

        assert!(config.accept_invalid_certs);
    }

    #[test]
    fn imap_timeout_error_names_operation_and_seconds() {
        let error = imap_timeout_error("UID FETCH", 30);

        assert_eq!(
            error.to_string(),
            "Network error: UID FETCH timed out after 30s"
        );
    }
}

#[cfg(test)]
mod folder_list_tests {
    use async_imap::types::NameAttribute;
    use pebble_core::FolderRole;

    use super::{detect_folder_role_from_attributes, should_sync_listed_mailbox};

    #[test]
    fn special_use_attributes_detect_system_folder_roles() {
        assert_eq!(
            detect_folder_role_from_attributes(&[NameAttribute::Sent]),
            Some(FolderRole::Sent)
        );
        assert_eq!(
            detect_folder_role_from_attributes(&[NameAttribute::Trash]),
            Some(FolderRole::Trash)
        );
        assert_eq!(
            detect_folder_role_from_attributes(&[NameAttribute::Drafts]),
            Some(FolderRole::Drafts)
        );
        assert_eq!(
            detect_folder_role_from_attributes(&[NameAttribute::Archive]),
            Some(FolderRole::Archive)
        );
        assert_eq!(
            detect_folder_role_from_attributes(&[NameAttribute::Junk]),
            Some(FolderRole::Spam)
        );
    }

    #[test]
    fn extension_inbox_attribute_detects_inbox_role() {
        assert_eq!(
            detect_folder_role_from_attributes(&[NameAttribute::Extension("\\Inbox".into())]),
            Some(FolderRole::Inbox)
        );
    }

    #[test]
    fn noselect_mailboxes_are_not_synced_as_real_folders() {
        assert!(!should_sync_listed_mailbox(&[NameAttribute::NoSelect]));
        assert!(!should_sync_listed_mailbox(&[
            NameAttribute::NoSelect,
            NameAttribute::Extension("\\HasChildren".into()),
        ]));
        assert!(should_sync_listed_mailbox(&[NameAttribute::Sent]));
    }
}

#[cfg(test)]
mod incremental_uid_tests {
    use super::{incremental_fetch_uids, should_search_incremental_uids};

    #[test]
    fn incremental_fetch_skips_when_no_uid_is_newer_than_cursor() {
        let uids = incremental_fetch_uids(Some(3291), &[1, 42, 3291]);

        assert!(uids.is_empty());
    }

    #[test]
    fn incremental_fetch_returns_only_newer_uids_sorted_and_deduped() {
        let uids = incremental_fetch_uids(Some(42), &[45, 41, 43, 45, 42]);

        assert_eq!(uids, vec![43, 45]);
    }

    #[test]
    fn incremental_fetch_skips_search_when_uidnext_shows_no_new_mail() {
        assert!(!should_search_incremental_uids(3292, Some(3292)));
        assert!(!should_search_incremental_uids(3293, Some(3292)));
    }

    #[test]
    fn incremental_fetch_searches_when_uidnext_is_missing_or_newer() {
        assert!(should_search_incremental_uids(3292, None));
        assert!(should_search_incremental_uids(3292, Some(3293)));
    }
}
