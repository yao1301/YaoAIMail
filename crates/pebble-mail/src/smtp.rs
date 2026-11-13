use crate::imap::{ConnectionSecurity, ProxyConfig};
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Body, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{AsyncSmtpConnection, AsyncTokioStream, Tls, TlsParameters};
use lettre::transport::smtp::extension::ClientId;
use lettre::{AsyncSmtpTransport, AsyncTransport};
use pebble_core::{PebbleError, Result};
use std::fmt;
use std::net::SocketAddr;
use std::path::Path;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_native_tls as async_native_tls;

pub struct SmtpSender {
    host: String,
    port: u16,
    credentials: Credentials,
    security: ConnectionSecurity,
    accept_invalid_certs: bool,
    proxy: Option<ProxyConfig>,
}

/// One inline image extracted from an HTML body: a `data:image/…;base64,…`
/// URI that was replaced by a `cid:` reference on the wire. The caller stores
/// these as local attachment records so the local "Sent" copy renders the
/// same images recipients see.
#[derive(Debug, Clone)]
pub struct InlineImageData {
    pub content_id: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// The HTML body as it actually went over the wire: the final HTML (with
/// `data:` URIs rewritten to `cid:`) plus the inline image parts backing
/// those references.
#[derive(Debug, Clone)]
pub struct SentBody {
    pub html: Option<String>,
    pub inline_images: Vec<InlineImageData>,
}

impl SmtpSender {
    pub fn new(
        host: String,
        port: u16,
        username: String,
        password: String,
        security: ConnectionSecurity,
        accept_invalid_certs: bool,
        proxy: Option<ProxyConfig>,
    ) -> Self {
        Self {
            host,
            port,
            credentials: Credentials::new(username, password),
            security,
            accept_invalid_certs,
            proxy,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send(
        &self,
        from: &str,
        to: &[String],
        cc: &[String],
        bcc: &[String],
        subject: &str,
        body_text: &str,
        body_html: Option<&str>,
        in_reply_to: Option<&str>,
        attachment_paths: &[String],
        message_id: Option<&str>,
    ) -> Result<SentBody> {
        if to.is_empty() {
            return Err(PebbleError::Internal("No recipients".to_string()));
        }

        let from_mailbox: Mailbox = from
            .parse()
            .map_err(|e| PebbleError::Internal(format!("Invalid from address: {e}")))?;

        let mut builder = lettre::Message::builder()
            .from(from_mailbox)
            .subject(subject);

        // 使用调用方指定的 Message-ID（与本地"已发送"副本一致），
        // 覆盖 lettre 自动生成的随机 Message-ID，保证同步去重可匹配。
        if let Some(mid) = message_id {
            builder = builder.message_id(Some(mid.to_string()));
        }

        for addr in to {
            let mailbox: Mailbox = addr
                .parse()
                .map_err(|e| PebbleError::Internal(format!("Invalid to address '{addr}': {e}")))?;
            builder = builder.to(mailbox);
        }

        for addr in cc {
            let mailbox: Mailbox = addr
                .parse()
                .map_err(|e| PebbleError::Internal(format!("Invalid cc address '{addr}': {e}")))?;
            builder = builder.cc(mailbox);
        }

        for addr in bcc {
            let mailbox: Mailbox = addr
                .parse()
                .map_err(|e| PebbleError::Internal(format!("Invalid bcc address '{addr}': {e}")))?;
            builder = builder.bcc(mailbox);
        }

        if let Some(reply_to) = in_reply_to {
            builder = builder.in_reply_to(reply_to.to_string());
        }

        // Inline `data:` images (pasted screenshots, hydrated reply/forward
        // quotes) become proper multipart/related attachments with `cid:`
        // references so recipients' clients (Outlook, Gmail, …) render them.
        let (body_html_final, inline_images) = match body_html {
            Some(html) => {
                let (html, images) = extract_inline_images(html);
                (Some(html), images)
            }
            None => (None, Vec::new()),
        };
        let inline_parts = inline_images
            .iter()
            .map(|image| inline_image_part(image))
            .collect::<Vec<_>>();

        let email = if attachment_paths.is_empty() {
            build_body_only_message(builder, body_text, body_html_final.as_deref(), inline_parts)?
        } else {
            let mut mixed = match body_html_final.as_deref() {
                Some(html) => {
                    MultiPart::mixed().multipart(alternative_body(body_text, html, inline_parts))
                }
                None => MultiPart::mixed().singlepart(plain_text_body(body_text)),
            };

            for path_str in attachment_paths {
                let path = Path::new(path_str);
                let filename = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("attachment")
                    .to_string();

                let file_bytes = std::fs::read(path).map_err(|e| {
                    PebbleError::Internal(format!("Failed to read attachment '{}': {e}", path_str))
                })?;

                let content_type = mime_type_from_extension(
                    path.extension().and_then(|e| e.to_str()).unwrap_or(""),
                );

                let attachment =
                    Attachment::new(filename).body(Body::new(file_bytes), content_type);

                mixed = mixed.singlepart(attachment);
            }

            builder
                .multipart(mixed)
                .map_err(|e| PebbleError::Internal(format!("Failed to build email: {e}")))?
        };

        if let Some(ref proxy) = self.proxy {
            self.send_via_proxy(&email, proxy).await?;
        } else {
            self.send_direct(&email).await?;
        }

        Ok(SentBody {
            html: body_html_final,
            inline_images,
        })
    }

    fn direct_transport(&self) -> Result<AsyncSmtpTransport<lettre::Tokio1Executor>> {
        let tls_parameters = || smtp_tls_parameters(&self.host, self.accept_invalid_certs);
        let transport = match self.security {
            ConnectionSecurity::Tls => {
                AsyncSmtpTransport::<lettre::Tokio1Executor>::builder_dangerous(&self.host)
                    .tls(Tls::Wrapper(tls_parameters()?))
                    .port(self.port)
                    .credentials(self.credentials.clone())
                    .build()
            }
            ConnectionSecurity::StartTls => {
                AsyncSmtpTransport::<lettre::Tokio1Executor>::builder_dangerous(&self.host)
                    .tls(Tls::Required(tls_parameters()?))
                    .port(self.port)
                    .credentials(self.credentials.clone())
                    .build()
            }
            ConnectionSecurity::Plain => {
                AsyncSmtpTransport::<lettre::Tokio1Executor>::builder_dangerous(&self.host)
                    .tls(Tls::None)
                    .port(self.port)
                    .credentials(self.credentials.clone())
                    .build()
            }
        };

        Ok(transport)
    }

    /// Authentication/connectivity only: never creates an envelope or sends DATA.
    pub async fn test_connection(&self) -> Result<String> {
        tokio::time::timeout(std::time::Duration::from_secs(25), async {
            if let Some(proxy) = &self.proxy {
                let mut conn = self.connect_via_proxy(proxy).await?;
                conn.auth(&[Mechanism::Plain, Mechanism::Login], &self.credentials)
                    .await.map_err(|e| PebbleError::Network(format!("SMTP authentication failed: {e}")))?;
                let _ = conn.quit().await;
            } else {
                let ok = self.direct_transport()?.test_connection().await
                    .map_err(|e| PebbleError::Network(format!("SMTP connection/authentication failed: {e}")))?;
                if !ok { return Err(PebbleError::Network("SMTP server did not pass the connection test".into())); }
            }
            Ok("SMTP 连接与身份认证通过（未发送测试邮件，不代表实际投递成功）".into())
        }).await.map_err(|_| PebbleError::Network("SMTP 连接测试超时（25 秒）；请检查发件服务器及邮件代理".into()))?
    }

    /// Send without a proxy using the same settings as the connection test.
    async fn send_direct(&self, email: &lettre::Message) -> Result<()> {
        self.direct_transport()?
            .send(email.clone())
            .await
            .map_err(|e| PebbleError::Network(format!("SMTP send failed: {e}")))?;

        Ok(())
    }

    /// Send via a SOCKS5 proxy using a manually managed AsyncSmtpConnection.
    async fn send_via_proxy(&self, email: &lettre::Message, proxy: &ProxyConfig) -> Result<()> {
        let conn = self.connect_via_proxy(proxy).await?;
        authenticate_and_send(conn, &self.credentials, email).await
    }

    async fn connect_via_proxy(&self, proxy: &ProxyConfig) -> Result<AsyncSmtpConnection> {
        let proxy_addr = format!("{}:{}", proxy.host, proxy.port);
        let target = format!("{}:{}", self.host, self.port);

        // For TLS (implicit), connect through SOCKS5, then wrap in TLS before the SMTP handshake.
        // For STARTTLS / Plain, connect through SOCKS5 plain, then upgrade as needed.
        let hello_name = ClientId::default();

        match self.security {
            ConnectionSecurity::Tls => {
                // Connect through SOCKS5 to the SMTP host:port
                let socks_stream =
                    tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), target.as_str())
                        .await
                        .map_err(|e| PebbleError::Network(format!("SOCKS5 connect failed: {e}")))?;

                // Try rustls first, fall back to native-tls if handshake fails
                let rustls_config = build_rustls_client_config(self.accept_invalid_certs)?;
                let connector = tokio_rustls::TlsConnector::from(rustls_config);
                let domain = rustls::pki_types::ServerName::try_from(self.host.clone())
                    .map_err(|e| PebbleError::Network(format!("Invalid TLS server name: {e}")))?
                    .to_owned();

                match connector.connect(domain, socks_stream.into_inner()).await {
                    Ok(tls_stream) => {
                        let conn = AsyncSmtpConnection::connect_with_transport(
                            Box::new(DebugStream(tls_stream)),
                            &hello_name,
                        )
                        .await
                        .map_err(|e| PebbleError::Network(format!("SMTP handshake failed: {e}")))?;
                        Ok(conn)
                    }
                    Err(rustls_err) => {
                        tracing::debug!(
                            "SMTP rustls handshake failed ({}), retrying with native-tls",
                            rustls_err
                        );
                        // Reconnect SOCKS5 and try native-tls
                        let socks_stream = tokio_socks::tcp::Socks5Stream::connect(
                            proxy_addr.as_str(),
                            target.as_str(),
                        )
                        .await
                        .map_err(|e| {
                            PebbleError::Network(format!("SOCKS5 reconnect failed: {e}"))
                        })?;
                        let native_connector =
                            build_native_tls_connector(self.accept_invalid_certs)?;
                        let tls_stream = native_connector
                            .connect(&self.host, socks_stream.into_inner())
                            .await
                            .map_err(|e| {
                                PebbleError::Network(format!(
                                    "TLS failed with both backends — rustls: {rustls_err}, native-tls: {e}"
                                ))
                            })?;
                        let conn = AsyncSmtpConnection::connect_with_transport(
                            Box::new(DebugStream(tls_stream)),
                            &hello_name,
                        )
                        .await
                        .map_err(|e| PebbleError::Network(format!("SMTP handshake failed: {e}")))?;
                        Ok(conn)
                    }
                }
            }
            ConnectionSecurity::StartTls => {
                let socks_stream =
                    tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), target.as_str())
                        .await
                        .map_err(|e| PebbleError::Network(format!("SOCKS5 connect failed: {e}")))?;

                let mut conn = AsyncSmtpConnection::connect_with_transport(
                    Box::new(Socks5TokioStream(socks_stream)),
                    &hello_name,
                )
                .await
                .map_err(|e| PebbleError::Network(format!("SMTP handshake failed: {e}")))?;

                if !conn.can_starttls() {
                    return Err(PebbleError::Network(
                        "STARTTLS required but server does not support it — refusing to send in plaintext".to_string(),
                    ));
                }
                let tls_params = smtp_tls_parameters(&self.host, self.accept_invalid_certs)?;
                conn.starttls(tls_params, &hello_name)
                    .await
                    .map_err(|e| PebbleError::Network(format!("STARTTLS failed: {e}")))?;

                Ok(conn)
            }
            ConnectionSecurity::Plain => {
                let socks_stream =
                    tokio_socks::tcp::Socks5Stream::connect(proxy_addr.as_str(), target.as_str())
                        .await
                        .map_err(|e| PebbleError::Network(format!("SOCKS5 connect failed: {e}")))?;

                let conn = AsyncSmtpConnection::connect_with_transport(
                    Box::new(Socks5TokioStream(socks_stream)),
                    &hello_name,
                )
                .await
                .map_err(|e| PebbleError::Network(format!("SMTP handshake failed: {e}")))?;

                Ok(conn)
            }
        }
    }
}

fn plain_text_body(body_text: &str) -> SinglePart {
    SinglePart::builder()
        .content_type(ContentType::TEXT_PLAIN)
        .body(body_text.to_string())
}

fn alternative_body(body_text: &str, body_html: &str, inline: Vec<SinglePart>) -> MultiPart {
    let html_part = SinglePart::builder()
        .content_type(ContentType::TEXT_HTML)
        .body(body_html.to_string());
    let text_and_html = MultiPart::alternative()
        .singlepart(plain_text_body(body_text))
        .singlepart(html_part);
    if inline.is_empty() {
        return text_and_html;
    }
    let mut related = MultiPart::related().singlepart(
        SinglePart::builder()
            .content_type(ContentType::TEXT_HTML)
            .body(body_html.to_string()),
    );
    for part in inline {
        related = related.singlepart(part);
    }
    MultiPart::alternative()
        .singlepart(plain_text_body(body_text))
        .multipart(related)
}

fn build_body_only_message(
    builder: lettre::message::MessageBuilder,
    body_text: &str,
    body_html: Option<&str>,
    inline: Vec<SinglePart>,
) -> Result<lettre::Message> {
    match body_html {
        Some(html) => builder.multipart(alternative_body(body_text, html, inline)),
        None => builder.singlepart(plain_text_body(body_text)),
    }
    .map_err(|e| PebbleError::Internal(format!("Failed to build email: {e}")))
}

/// Scan an HTML body for `data:image/…;base64,…` URIs, replace each with a
/// `cid:` reference, and return the rewritten HTML plus the decoded inline
/// images backing those references. Malformed or undecodable URIs are left
/// untouched so the send path can never fail because of one bad image.
pub fn extract_inline_images(body_html: &str) -> (String, Vec<InlineImageData>) {
    use base64::Engine as _;
    use std::time::{SystemTime, UNIX_EPOCH};

    const MARKER: &str = "data:image/";
    const BASE64_SEGMENT: &str = ";base64,";
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let mut out = String::with_capacity(body_html.len());
    let mut images: Vec<InlineImageData> = Vec::new();
    let mut rest = body_html;
    let mut index = 0usize;

    while let Some(pos) = rest.find(MARKER) {
        let after_marker = &rest[pos + MARKER.len()..];
        let Some(seg) = after_marker.find(BASE64_SEGMENT) else {
            out.push_str(&rest[..pos + MARKER.len()]);
            rest = after_marker;
            continue;
        };
        let mime = &after_marker[..seg];
        let mime_ok =
            !mime.is_empty() && mime.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'+' || b == b'-');
        let data_start = pos + MARKER.len() + seg + BASE64_SEGMENT.len();
        let tail = &rest[data_start..];
        let data_end = tail
            .bytes()
            .position(|b| !(b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='))
            .unwrap_or(tail.len());
        let encoded = &tail[..data_end];

        let decoded = if mime_ok && encoded.len() >= 8 {
            base64::engine::general_purpose::STANDARD.decode(encoded).ok()
        } else {
            None
        };

        match decoded {
            Some(bytes) if !bytes.is_empty() => {
                index += 1;
                let cid = format!("inline.{nanos}.{index}@yaomail");
                images.push(InlineImageData {
                    content_id: cid,
                    mime_type: format!("image/{mime}"),
                    bytes,
                });
                out.push_str(&rest[..pos]);
                out.push_str("cid:");
                out.push_str(&images.last().unwrap().content_id);
            }
            _ => {
                // Not a decodable image — keep the original URI as-is.
                out.push_str(&rest[..data_start + data_end]);
            }
        }
        rest = &tail[data_end..];
    }
    out.push_str(rest);
    (out, images)
}

/// Build the lettre MIME part for one inline image. `Attachment::new_inline`
/// emits `Content-ID: <cid>` and `Content-Disposition: inline`, which is what
/// the `cid:` references in the HTML body point at.
fn inline_image_part(image: &InlineImageData) -> SinglePart {
    let content_type = ContentType::parse(&image.mime_type)
        .unwrap_or_else(|_| ContentType::parse("image/png").unwrap());
    Attachment::new_inline(image.content_id.clone())
        .body(Body::new(image.bytes.clone()), content_type)
}

fn smtp_tls_parameters(host: &str, accept_invalid_certs: bool) -> Result<TlsParameters> {
    TlsParameters::builder(host.to_string())
        .dangerous_accept_invalid_certs(accept_invalid_certs)
        .dangerous_accept_invalid_hostnames(accept_invalid_certs)
        .build()
        .map_err(|e| PebbleError::Network(format!("TLS parameters error: {e}")))
}

/// Authenticate on an open `AsyncSmtpConnection` and send one message.
async fn authenticate_and_send(
    mut conn: AsyncSmtpConnection,
    credentials: &Credentials,
    email: &lettre::Message,
) -> Result<()> {
    let mechanisms = &[Mechanism::Plain, Mechanism::Login];
    conn.auth(mechanisms, credentials)
        .await
        .map_err(|e| PebbleError::Network(format!("SMTP auth failed: {e}")))?;

    let envelope = email.envelope().clone();
    let raw = email.formatted();
    conn.send(&envelope, &raw)
        .await
        .map_err(|e| PebbleError::Network(format!("SMTP send failed: {e}")))?;

    // DATA has its final success response. A slow/missing QUIT response is
    // connection cleanup, not a failed send. Never let the caller's submission
    // timeout turn this accepted message into an "unknown" resend candidate.
    tokio::spawn(async move {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), conn.quit()).await;
    });
    Ok(())
}

/// Build a rustls ClientConfig that trusts the system/webpki roots.
fn build_rustls_client_config(
    accept_invalid_certs: bool,
) -> Result<std::sync::Arc<rustls::ClientConfig>> {
    let provider = std::sync::Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| PebbleError::Network(format!("TLS protocol versions: {e}")))?;
    let config = if accept_invalid_certs {
        builder
            .dangerous()
            .with_custom_certificate_verifier(std::sync::Arc::new(
                crate::imap::AcceptInvalidCertsVerifier::new(root_store),
            ))
            .with_no_client_auth()
    } else {
        builder
            .with_root_certificates(root_store)
            .with_no_client_auth()
    };
    Ok(std::sync::Arc::new(config))
}

#[cfg(test)]
mod connection_tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    async fn check(proxy: bool, reject_auth: bool, starttls: bool) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let commands = Arc::new(Mutex::new(Vec::new()));
        let captured = commands.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            if proxy {
                let mut greeting = [0; 3]; stream.read_exact(&mut greeting).await.unwrap();
                assert_eq!(greeting, [5, 1, 0]); stream.write_all(&[5, 0]).await.unwrap();
                let mut head = [0; 4]; stream.read_exact(&mut head).await.unwrap();
                let len = match head[3] { 1 => 4, 3 => stream.read_u8().await.unwrap() as usize, 4 => 16, _ => panic!("invalid SOCKS address") };
                let mut target = vec![0; len + 2]; stream.read_exact(&mut target).await.unwrap();
                stream.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 25]).await.unwrap();
            }
            stream.write_all(b"220 test.example ESMTP\r\n").await.unwrap();
            let (read, mut write) = stream.into_split();
            let mut read = BufReader::new(read);
            loop {
                let mut line = String::new();
                if read.read_line(&mut line).await.unwrap_or(0) == 0 { break; }
                let command = line.split_whitespace().next().unwrap_or("").to_ascii_uppercase();
                captured.lock().unwrap().push(command.clone());
                let response: &[u8] = match command.as_str() {
                    "EHLO" => b"250-test.example\r\n250 AUTH PLAIN LOGIN\r\n",
                    "AUTH" if reject_auth => b"535 5.7.8 invalid credentials\r\n",
                    "AUTH" => b"235 2.7.0 authenticated\r\n",
                    "NOOP" => b"250 OK\r\n",
                    "QUIT" => b"221 bye\r\n",
                    // No recipient, envelope or message submission is allowed.
                    _ => panic!("Unexpected SMTP command in connection-only test"),
                };
                if write.write_all(response).await.is_err() || command == "QUIT" { break; }
            }
        });
        let sender = SmtpSender::new("127.0.0.1".into(), port, "test-user".into(), "test-password".into(),
            if starttls { ConnectionSecurity::StartTls } else { ConnectionSecurity::Plain }, false,
            if proxy { Some(ProxyConfig { host: "127.0.0.1".into(), port }) } else { None });
        let result = sender.test_connection().await;
        if reject_auth || starttls { assert!(result.is_err()); } else { assert!(result.is_ok(), "connection/authentication should succeed"); }
        let commands = commands.lock().unwrap().clone();
        assert!(commands.iter().any(|c| c == "EHLO"));
        assert_eq!(commands.iter().any(|c| c == "AUTH"), !starttls);
        assert!(!commands.iter().any(|c| matches!(c.as_str(), "MAIL" | "RCPT" | "DATA")));
        server.abort();
    }

    #[tokio::test] async fn direct_test_authenticates_without_sending_mail() { check(false, false, false).await; }
    #[tokio::test] async fn direct_test_rejects_bad_credentials() { check(false, true, false).await; }
    #[tokio::test] async fn proxy_test_authenticates_without_sending_mail() { check(true, false, false).await; }
    #[tokio::test] async fn proxy_starttls_test_does_not_downgrade_to_plaintext() { check(true, false, true).await; }

    #[tokio::test]
    async fn accepted_data_does_not_wait_for_a_stalled_quit_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split(); let mut read = BufReader::new(read);
            write.write_all(b"220 example.test ESMTP\r\n").await.unwrap();
            let mut data = false; let mut accepted = Some(accepted_tx);
            loop {
                let mut line = String::new(); if read.read_line(&mut line).await.unwrap() == 0 { break; }
                if data {
                    if line == ".\r\n" { data = false; write.write_all(b"250 queued\r\n").await.unwrap(); accepted.take().unwrap().send(()).unwrap(); }
                    continue;
                }
                let response: &[u8] = match line.split_whitespace().next().unwrap_or("") {
                    "EHLO" => b"250-example.test\r\n250 AUTH PLAIN LOGIN\r\n",
                    "AUTH" => b"235 authenticated\r\n", "MAIL" | "RCPT" => b"250 OK\r\n",
                    "DATA" => { data = true; b"354 send content\r\n" },
                    "QUIT" => { std::future::pending::<()>().await; unreachable!() },
                    _ => panic!("Unexpected fixture SMTP command"),
                }; write.write_all(response).await.unwrap();
            }
        });
        let stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let conn = AsyncSmtpConnection::connect_with_transport(Box::new(DebugStream(stream)), &ClientId::default()).await.unwrap();
        let email = lettre::Message::builder().from("from@example.test".parse().unwrap()).to("to@example.test".parse().unwrap()).subject("Fixture").body("Hello".to_string()).unwrap();
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), authenticate_and_send(conn, &Credentials::new("fixture".into(),"fixture".into()), &email)).await;
        assert!(result.is_ok() && result.unwrap().is_ok());
        accepted_rx.await.unwrap(); server.abort();
    }
}

/// Build a native-tls connector (OS TLS backend: SChannel/SecureTransport/OpenSSL).
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

// ---------------------------------------------------------------------------
// Stream wrappers that implement AsyncTokioStream for lettre
// ---------------------------------------------------------------------------

/// Wraps `tokio_socks::tcp::Socks5Stream<tokio::net::TcpStream>` so it can be
/// passed to `AsyncSmtpConnection::connect_with_transport`.
struct Socks5TokioStream(tokio_socks::tcp::Socks5Stream<tokio::net::TcpStream>);

impl fmt::Debug for Socks5TokioStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Socks5TokioStream").finish_non_exhaustive()
    }
}

impl AsyncTokioStream for Socks5TokioStream {
    fn peer_addr(&self) -> std::io::Result<SocketAddr> {
        // Deref to the inner TcpStream via the Deref impl on Socks5Stream.
        use std::ops::Deref;
        self.0.deref().peer_addr()
    }
}

impl AsyncRead for Socks5TokioStream {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl AsyncWrite for Socks5TokioStream {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

// Socks5TokioStream wraps a TcpStream (which is Unpin) and the socks stream is also Unpin.
impl Unpin for Socks5TokioStream {}

// ---------------------------------------------------------------------------
// DebugStream: generic wrapper that adds Debug + peer_addr for any stream
// that implements AsyncRead + AsyncWrite + Unpin + Send + Sync but lacks
// a native peer_addr (e.g. TLS-wrapped streams).
// ---------------------------------------------------------------------------

struct DebugStream<S>(S);

impl<S: fmt::Debug> fmt::Debug for DebugStream<S> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

impl<S> AsyncTokioStream for DebugStream<S>
where
    S: AsyncRead + AsyncWrite + Send + Sync + Unpin + fmt::Debug + 'static,
{
    fn peer_addr(&self) -> std::io::Result<SocketAddr> {
        // For TLS-over-proxy streams we don't have a meaningful peer_addr; return a dummy.
        Ok("0.0.0.0:0".parse().unwrap())
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for DebugStream<S> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for DebugStream<S> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

impl<S: Unpin> Unpin for DebugStream<S> {}

/// Map common file extensions to MIME content types.
fn mime_type_from_extension(ext: &str) -> ContentType {
    match ext.to_ascii_lowercase().as_str() {
        "pdf" => ContentType::parse("application/pdf").unwrap(),
        "zip" => ContentType::parse("application/zip").unwrap(),
        "gz" | "gzip" => ContentType::parse("application/gzip").unwrap(),
        "doc" => ContentType::parse("application/msword").unwrap(),
        "docx" => ContentType::parse(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
        .unwrap(),
        "xls" => ContentType::parse("application/vnd.ms-excel").unwrap(),
        "xlsx" => {
            ContentType::parse("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                .unwrap()
        }
        "ppt" => ContentType::parse("application/vnd.ms-powerpoint").unwrap(),
        "pptx" => ContentType::parse(
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        )
        .unwrap(),
        "png" => ContentType::parse("image/png").unwrap(),
        "jpg" | "jpeg" => ContentType::parse("image/jpeg").unwrap(),
        "gif" => ContentType::parse("image/gif").unwrap(),
        "svg" => ContentType::parse("image/svg+xml").unwrap(),
        "webp" => ContentType::parse("image/webp").unwrap(),
        "mp3" => ContentType::parse("audio/mpeg").unwrap(),
        "mp4" => ContentType::parse("video/mp4").unwrap(),
        "txt" => ContentType::TEXT_PLAIN,
        "html" | "htm" => ContentType::TEXT_HTML,
        "csv" => ContentType::parse("text/csv").unwrap(),
        "json" => ContentType::parse("application/json").unwrap(),
        "xml" => ContentType::parse("application/xml").unwrap(),
        "eml" => ContentType::parse("message/rfc822").unwrap(),
        _ => ContentType::parse("application/octet-stream").unwrap(),
    }
}

#[cfg(test)]
mod tls_config_tests {
    use super::{
        build_body_only_message, build_native_tls_connector, build_rustls_client_config,
        extract_inline_images, inline_image_part, InlineImageData,
    };

    #[test]
    fn plain_text_message_does_not_add_a_fake_html_alternative() {
        let message = build_body_only_message(
            lettre::Message::builder()
                .from("sender@example.com".parse().unwrap())
                .to("recipient@example.com".parse().unwrap())
                .subject("Formatting"),
            "First paragraph.\n\nSecond paragraph.\n\nBest regards,\nAlex",
            None,
            Vec::new(),
        )
        .unwrap();
        let formatted = String::from_utf8(message.formatted()).unwrap();

        assert!(formatted.contains("Content-Type: text/plain"));
        assert!(!formatted.contains("Content-Type: text/html"));
        assert!(formatted.contains("First paragraph.\r\n\r\nSecond paragraph."));
        assert!(formatted.contains("Best regards,\r\nAlex"));
    }

    #[test]
    fn build_rustls_client_config_returns_result() {
        assert!(build_rustls_client_config(false).is_ok());
        assert!(build_rustls_client_config(true).is_ok());
    }

    #[test]
    fn build_native_tls_connector_returns_result() {
        assert!(build_native_tls_connector(false).is_ok());
        assert!(build_native_tls_connector(true).is_ok());
    }

    #[test]
    fn data_uri_images_become_cid_inline_parts() {
        // A valid base64 payload (PNG header bytes) and a malformed one.
        let valid = "iVBORw0KGgoAAAANSUhEUg==";
        let html = format!(
            "<p>hi</p><img src=\"data:image/png;base64,{valid}\"><img src=\"data:image/png;base64,@@not-base64@@\"><img src=\"https://example.com/logo.png\">"
        );
        let (rewritten, images) = extract_inline_images(&html);

        assert_eq!(images.len(), 1, "only the decodable image becomes a part");
        assert!(!rewritten.contains("data:image/png;base64,iVBOR"), "valid data URI must be replaced");
        assert!(rewritten.contains("cid:inline."), "valid data URI becomes a cid reference");
        assert!(rewritten.contains("data:image/png;base64,@@not-base64@@"), "malformed URI stays untouched");
        assert!(rewritten.contains("https://example.com/logo.png"), "remote URIs stay untouched");

        // The decoded payload must survive the round trip.
        use base64::Engine as _;
        assert_eq!(images[0].mime_type, "image/png");
        assert_eq!(images[0].bytes, base64::engine::general_purpose::STANDARD.decode(valid).unwrap());
        let part_bytes = inline_image_part(&images[0]).formatted();
        assert!(String::from_utf8_lossy(&part_bytes).contains("Content-ID: <inline."));
        assert!(String::from_utf8_lossy(&part_bytes).contains("Content-Type: image/png"));
        let _: Vec<InlineImageData> = images;
    }

    #[test]
    fn html_message_with_data_uri_uses_multipart_related() {
        use super::build_body_only_message;
        let html = "<p>sig</p><img src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==\">";
        let (rewritten, images) = extract_inline_images(html);
        let parts = images.iter().map(inline_image_part).collect::<Vec<_>>();
        let message = build_body_only_message(
            lettre::Message::builder()
                .from("sender@example.com".parse().unwrap())
                .to("recipient@example.com".parse().unwrap())
                .subject("Inline images"),
            "plain fallback",
            Some(&rewritten),
            parts,
        )
        .unwrap();
        let formatted = String::from_utf8(message.formatted()).unwrap();

        assert!(formatted.contains("multipart/related"), "html with inline images needs a related part");
        assert!(formatted.contains("Content-ID: <inline."));
        assert!(!formatted.contains("data:image/png;base64,iVBOR"), "outgoing html must not carry data URIs");
    }

    #[test]
    fn html_without_data_uris_keeps_plain_alternative() {
        use super::build_body_only_message;
        let message = build_body_only_message(
            lettre::Message::builder()
                .from("sender@example.com".parse().unwrap())
                .to("recipient@example.com".parse().unwrap())
                .subject("No images"),
            "plain fallback",
            Some("<p>hello</p>"),
            Vec::new(),
        )
        .unwrap();
        let formatted = String::from_utf8(message.formatted()).unwrap();
        assert!(!formatted.contains("multipart/related"));
        assert!(formatted.contains("Content-Type: text/html"));
    }
}
