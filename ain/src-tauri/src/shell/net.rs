//! What every outgoing connection shares: which servers' certificates are trusted, and where
//! models are downloaded from.
//!
//! Certificates are checked against the system's trust store, so a company CA installed on the
//! machine (`update-ca-trust` on Fedora) is trusted as the browser trusts it. "Accept any
//! certificate" (`general.acceptAnyCertificate`, or `AIN_INSECURE_TLS=1`) turns the check off, for
//! self-signed servers on a closed network: anyone on the way could then read and change the traffic.
//!
//! The models source (`general.modelsSource`, or `AIN_MODELS_SOURCE`) is a folder or an URL laid
//! out like AiN's models folder: machines without internet get their models from it (see
//! `features::download`).

use std::{
    env,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

use rustls::{
    ClientConfig, DigitallySignedStruct, SignatureScheme,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use rustls_platform_verifier::BuilderVerifierExt;
use serde_json::Value;
use ureq::{
    config::ConfigBuilder,
    tls::{RootCerts, TlsConfig},
    typestate::AgentScope,
};

/// Turns certificate checks off when set to 1, true, yes or on, whatever the settings say.
pub const INSECURE_ENV: &str = "AIN_INSECURE_TLS";
/// A models source that wins over the settings' one.
pub const SOURCE_ENV: &str = "AIN_MODELS_SOURCE";

static INSECURE: AtomicBool = AtomicBool::new(false);
static SOURCE: RwLock<Option<String>> = RwLock::new(None);

fn truthy(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

fn filled(value: &str) -> Option<String> {
    Some(value.trim()).filter(|v| !v.is_empty()).map(str::to_string)
}

/// Takes the network settings up from the saved settings; called at start and on every save.
pub fn follow(settings: &Value) {
    let general = |key| settings.get("general").and_then(|g| g.get(key));
    INSECURE.store(general("acceptAnyCertificate").and_then(Value::as_bool).unwrap_or(false), Ordering::SeqCst);
    *SOURCE.write().unwrap_or_else(|e| e.into_inner()) = general("modelsSource").and_then(Value::as_str).and_then(filled);
}

/// Whether certificates go unchecked.
pub fn insecure() -> bool {
    env::var(INSECURE_ENV).is_ok_and(|v| truthy(&v)) || INSECURE.load(Ordering::SeqCst)
}

/// The folder or URL models come from instead of the internet, if any.
pub fn models_source() -> Option<String> {
    env::var(SOURCE_ENV).ok().as_deref().and_then(filled).or_else(|| SOURCE.read().unwrap_or_else(|e| e.into_inner()).clone())
}

/// An HTTP client's configuration, with the certificate policy; callers add their own limits.
pub fn config() -> ConfigBuilder<AgentScope> {
    let tls = TlsConfig::builder().root_certs(RootCerts::PlatformVerifier).disable_verification(insecure()).build();
    ureq::Agent::config_builder().tls_config(tls)
}

/// An HTTP client with the certificate policy and ureq's defaults.
pub fn agent() -> ureq::Agent {
    config().build().into()
}

/// The TLS configuration for connections ureq doesn't make (PersonaPlex's WebSocket).
pub fn tls_client() -> Result<Arc<ClientConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder =
        ClientConfig::builder_with_provider(Arc::clone(&provider)).with_safe_default_protocol_versions().map_err(|e| e.to_string())?;
    let config = if insecure() {
        builder.dangerous().with_custom_certificate_verifier(Arc::new(AnyCertificate(provider))).with_no_client_auth()
    } else {
        builder.with_platform_verifier().map_err(|e| e.to_string())?.with_no_client_auth()
    };
    Ok(Arc::new(config))
}

/// Takes any certificate, still checking that the server holds its key.
#[derive(Debug)]
struct AnyCertificate(Arc<CryptoProvider>);

impl ServerCertVerifier for AnyCertificate {
    fn verify_server_cert(
        &self,
        _: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_truthy_values() {
        assert!(["1", "true", "YES", " on "].iter().all(|v| truthy(v)));
        assert!(!["", "0", "false", "off", "nope"].iter().any(|v| truthy(v)));
    }

    #[test]
    fn follows_the_settings() {
        follow(&serde_json::json!({ "general": { "acceptAnyCertificate": true, "modelsSource": "  /srv/models " } }));
        assert!(INSECURE.load(Ordering::SeqCst));
        assert_eq!(SOURCE.read().unwrap().as_deref(), Some("/srv/models"));
        // The TLS settings build either way.
        assert!(tls_client().is_ok());
        follow(&serde_json::json!({ "general": { "modelsSource": " " } }));
        assert!(!INSECURE.load(Ordering::SeqCst));
        assert_eq!(*SOURCE.read().unwrap(), None);
        follow(&Value::Null);
        assert!(tls_client().is_ok());
        let _ = agent();
    }
}
