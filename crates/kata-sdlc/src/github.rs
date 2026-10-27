//! GitHub through its REST API with the engineer's existing sign-in. Owns "Which GitHub
//! credential a host gets" and "How a GitHub API request is made". Kata keeps no credential: it
//! is looked up fresh for each use, held in memory for that call, and never written, logged or
//! put in an error.

use serde_json::{json, Value};
use std::fmt;
use std::time::Duration;

/// A GitHub token and the host it belongs to. No `Serialize`, and `Debug` hides the token.
#[derive(Clone, PartialEq)]
pub struct Credential {
    host: String,
    token: String,
}

impl Credential {
    pub fn new(host: &str, token: &str) -> Self {
        Credential {
            host: host.to_string(),
            token: token.to_string(),
        }
    }
    pub fn host(&self) -> &str {
        &self.host
    }
    pub fn token(&self) -> &str {
        &self.token
    }
}

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credential")
            .field("host", &self.host)
            .field("token", &"<redacted>")
            .finish()
    }
}

/// Where a sign-in can be read from. Every method only reads; nothing here can open a window or
/// ask the engineer anything.
pub trait CredentialSource {
    /// An environment variable.
    fn env(&self, name: &str) -> Option<String>;
    /// A generic credential in Windows Credential Manager, by target name.
    fn stored(&self, target: &str) -> Option<String>;
    /// The `oauth_token` of `host` in the GitHub CLI's `hosts.yml`.
    fn hosts_file_token(&self, host: &str) -> Option<String>;
}

/// The real places: the environment, Credential Manager and `hosts.yml`.
pub struct SystemSource;

impl CredentialSource for SystemSource {
    fn env(&self, name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    fn stored(&self, target: &str) -> Option<String> {
        read_stored(target)
    }

    fn hosts_file_token(&self, host: &str) -> Option<String> {
        let text = std::fs::read_to_string(hosts_file_path()?).ok()?;
        parse_hosts_yml(&text, host)
    }
}

/// Where the GitHub CLI keeps `hosts.yml`: `GH_CONFIG_DIR`, then `%APPDATA%\GitHub CLI`.
fn hosts_file_path() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    let var = |n: &str| {
        std::env::var_os(n)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let dir = var("GH_CONFIG_DIR").or_else(|| var("APPDATA").map(|d| d.join("GitHub CLI")))?;
    Some(dir.join("hosts.yml"))
}

/// A generic credential from Windows Credential Manager. Only reads; `CredReadW` has no window.
#[cfg(windows)]
fn read_stored(target: &str) -> Option<String> {
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };
    let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let mut found: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: `wide` is NUL-terminated; on success `found` points to a credential that stays
    // valid until `CredFree`, and the blob is copied before that.
    let blob = unsafe {
        if CredReadW(wide.as_ptr(), CRED_TYPE_GENERIC, 0, &mut found) == 0 || found.is_null() {
            return None;
        }
        let c = &*found;
        let blob = if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
        };
        CredFree(found as *const _);
        blob
    };
    decode_blob(&blob)
}

#[cfg(not(windows))]
fn read_stored(_target: &str) -> Option<String> {
    None
}

/// The secret in a credential blob: UTF-16 as the GitHub CLI's keyring stores it, or UTF-8 as
/// Git Credential Manager does.
#[cfg_attr(not(windows), allow(dead_code))]
fn decode_blob(blob: &[u8]) -> Option<String> {
    let utf16 = blob.len() >= 2
        && blob.len().is_multiple_of(2)
        && blob.chunks(2).all(|c| c[1] == 0 && c[0] != 0);
    let text = if utf16 {
        let units: Vec<u16> = blob
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&units).ok()?
    } else {
        String::from_utf8(blob.to_vec()).ok()?
    };
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// The credential a host gets, first match wins: the environment variables the GitHub CLI
/// reads, its stored sign-in, its `hosts.yml`, then Git Credential Manager's entry.
pub fn credential_for(host: &str, source: &dyn CredentialSource) -> Option<Credential> {
    let env_names: &[&str] = if host == "github.com" {
        &["GH_TOKEN", "GITHUB_TOKEN"]
    } else {
        &["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
    };
    // A blank value is no sign-in, so the next source gets its turn.
    let usable = |t: &String| !t.trim().is_empty();
    let token = env_names
        .iter()
        .find_map(|n| source.env(n).filter(usable))
        .or_else(|| source.stored(&format!("gh:{host}:")).filter(usable))
        .or_else(|| source.hosts_file_token(host).filter(usable))
        .or_else(|| source.stored(&format!("git:https://{host}")).filter(usable))?;
    Some(Credential::new(host, token.trim()))
}

/// The `oauth_token` of `host` in the text of a GitHub CLI `hosts.yml`: the first one inside the
/// host's block, wherever it is nested.
pub fn parse_hosts_yml(text: &str, host: &str) -> Option<String> {
    let mut inside = false;
    for line in text.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if !line.starts_with(char::is_whitespace) {
            let key = line.trim_end().trim_end_matches(':').trim_matches('"');
            inside = line.trim_end().ends_with(':') && key == host;
            continue;
        }
        if inside {
            if let Some(v) = line.trim_start().strip_prefix("oauth_token:") {
                let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
                return (!v.is_empty()).then(|| v.to_string());
            }
        }
    }
    None
}

/// The owner and repository name in a remote URL (HTTPS, `ssh://` or scp-style), or `None` for
/// a local path or a path that is not exactly `owner/name`.
pub fn parse_repo_path(url: &str) -> Option<(String, String)> {
    let raw = url.trim();
    let path = if let Some((scheme, rest)) = raw.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        rest.split_once('/')?.1
    } else if crate::publish::is_scp_like(raw) {
        raw.split_once(':')?.1
    } else {
        return None;
    };
    let path = path
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    if parts.next().is_some() || owner.is_empty() || name.is_empty() {
        return None;
    }
    Some((owner.to_string(), name.to_string()))
}

/// Why a GitHub request failed. The text holds the status and GitHub's `message` only.
#[derive(Debug, Clone, PartialEq)]
pub enum ApiError {
    Status { status: u16, message: String },
    Unreachable(String),
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Status { status, message } if message.is_empty() => {
                write!(f, "GitHub answered {status}")
            }
            ApiError::Status { status, message } => {
                write!(f, "GitHub answered {status}: {message}")
            }
            ApiError::Unreachable(why) => write!(f, "GitHub could not be reached: {why}"),
        }
    }
}

impl std::error::Error for ApiError {}

#[derive(Debug, Clone, PartialEq)]
pub struct Pull {
    pub number: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PullState {
    pub state: String,
    pub merged: bool,
}

/// The GitHub requests Kata makes.
pub trait GitHub {
    /// The login of the account the credential belongs to.
    fn user(&self) -> Result<String, ApiError>;
    fn repo(&self, owner: &str, name: &str) -> Result<(), ApiError>;
    fn open_pull_for_branch(
        &self,
        owner: &str,
        name: &str,
        branch: &str,
    ) -> Result<Option<Pull>, ApiError>;
    fn create_pull(
        &self,
        owner: &str,
        name: &str,
        base: &str,
        head: &str,
        title: &str,
        body: &str,
    ) -> Result<Pull, ApiError>;
    fn edit_pull_body(
        &self,
        owner: &str,
        name: &str,
        number: u64,
        body: &str,
    ) -> Result<(), ApiError>;
    fn pull_state(&self, owner: &str, name: &str, number: u64) -> Result<PullState, ApiError>;
}

/// A client for each host, or none where there is no sign-in.
pub trait GitHubHosts {
    fn github(&self, host: &str) -> Option<Box<dyn GitHub>>;
    /// The credential a push to `host` may carry, if the engineer is signed in to it.
    fn credential(&self, host: &str) -> Option<Credential>;
}

/// The real API client for one host.
pub struct Api {
    root: String,
    credential: Option<Credential>,
    agent: ureq::Agent,
}

impl fmt::Debug for Api {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Api")
            .field("root", &self.root)
            .field("credential", &self.credential)
            .finish()
    }
}

impl Api {
    /// The API of `host` with `credential`. A credential found for another host is not used.
    pub fn new(host: &str, credential: Credential) -> Api {
        let root = if host == "github.com" {
            "https://api.github.com".to_string()
        } else {
            format!("https://{host}/api/v3")
        };
        Api::at(root, host, credential)
    }

    /// An API served from `root`, for tests against a local server.
    #[cfg(test)]
    pub(crate) fn with_root(root: &str, credential: Credential) -> Api {
        let host = credential.host().to_string();
        Api::at(root.trim_end_matches('/').to_string(), &host, credential)
    }

    fn at(root: String, host: &str, credential: Credential) -> Api {
        let tls = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::NativeTls)
            .build();
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .max_redirects(0)
            .max_redirects_will_error(false)
            .tls_config(tls)
            .build()
            .into();
        Api {
            root,
            credential: (credential.host() == host).then_some(credential),
            agent,
        }
    }

    /// One request; a redirect is followed only inside the same scheme, host and port.
    fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, Value), ApiError> {
        let payload = body.map(|b| b.to_string());
        let mut url = format!("{}{path}", self.root);
        for _ in 0..5 {
            let mut req = ureq::http::Request::builder()
                .method(method)
                .uri(&url)
                .header("Accept", "application/vnd.github+json")
                .header("User-Agent", "kata-workbench");
            if let Some(c) = &self.credential {
                req = req.header("Authorization", format!("Bearer {}", c.token()));
            }
            let sent = match &payload {
                Some(p) => self.agent.run(
                    req.header("Content-Type", "application/json")
                        .body(p.clone())
                        .map_err(|e| self.unreachable(&e.to_string()))?,
                ),
                None => self
                    .agent
                    .run(req.body(()).map_err(|e| self.unreachable(&e.to_string()))?),
            };
            let mut response = sent.map_err(|e| self.unreachable(&e.to_string()))?;
            let status = response.status().as_u16();
            if (300..400).contains(&status) {
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_string();
                url = same_origin_target(&url, &location).ok_or_else(|| {
                    ApiError::Unreachable(
                        "the request was redirected to another host and refused".to_string(),
                    )
                })?;
                continue;
            }
            let text = response
                .body_mut()
                .read_to_string()
                .map_err(|e| self.unreachable(&e.to_string()))?;
            let value: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if status >= 400 {
                let message = value["message"].as_str().unwrap_or_default();
                return Err(ApiError::Status {
                    status,
                    message: self.scrub(message),
                });
            }
            return Ok((status, value));
        }
        Err(ApiError::Unreachable("too many redirects".to_string()))
    }

    fn unreachable(&self, text: &str) -> ApiError {
        ApiError::Unreachable(self.scrub(text))
    }

    /// Text for a person: the token never appears in it, and it stays short.
    fn scrub(&self, text: &str) -> String {
        let mut out = text.to_string();
        if let Some(c) = &self.credential {
            if !c.token().is_empty() {
                out = out.replace(c.token(), "<redacted>");
            }
        }
        out.chars().take(300).collect()
    }
}

/// `location` resolved against `current`, if it stays on the same scheme, host and port.
fn same_origin_target(current: &str, location: &str) -> Option<String> {
    let (scheme, rest) = current.split_once("://")?;
    let authority = rest.split('/').next()?;
    if location.starts_with('/') && !location.starts_with("//") {
        return Some(format!("{scheme}://{authority}{location}"));
    }
    let (l_scheme, l_rest) = location.split_once("://")?;
    let l_authority = l_rest.split('/').next()?;
    (l_scheme.eq_ignore_ascii_case(scheme) && l_authority.eq_ignore_ascii_case(authority))
        .then(|| location.to_string())
}

/// Percent-encodes everything but the unreserved characters.
fn encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn pull_of(value: &Value) -> Option<Pull> {
    Some(Pull {
        number: value["number"].as_u64()?,
        url: value["html_url"].as_str()?.to_string(),
    })
}

impl GitHub for Api {
    fn user(&self) -> Result<String, ApiError> {
        let (_, v) = self.send("GET", "/user", None)?;
        Ok(v["login"].as_str().unwrap_or_default().to_string())
    }

    fn repo(&self, owner: &str, name: &str) -> Result<(), ApiError> {
        self.send(
            "GET",
            &format!("/repos/{}/{}", encode(owner), encode(name)),
            None,
        )
        .map(|_| ())
    }

    fn open_pull_for_branch(
        &self,
        owner: &str,
        name: &str,
        branch: &str,
    ) -> Result<Option<Pull>, ApiError> {
        let head = encode(&format!("{owner}:{branch}"));
        let path = format!(
            "/repos/{}/{}/pulls?head={head}&state=open",
            encode(owner),
            encode(name)
        );
        let (_, v) = self.send("GET", &path, None)?;
        Ok(v.as_array().and_then(|a| a.first()).and_then(pull_of))
    }

    fn create_pull(
        &self,
        owner: &str,
        name: &str,
        base: &str,
        head: &str,
        title: &str,
        body: &str,
    ) -> Result<Pull, ApiError> {
        let path = format!("/repos/{}/{}/pulls", encode(owner), encode(name));
        let payload = json!({"title": title, "head": head, "base": base, "body": body});
        let (_, v) = self.send("POST", &path, Some(payload))?;
        pull_of(&v).ok_or_else(|| ApiError::Unreachable("GitHub sent no pull request".into()))
    }

    fn edit_pull_body(
        &self,
        owner: &str,
        name: &str,
        number: u64,
        body: &str,
    ) -> Result<(), ApiError> {
        let path = format!("/repos/{}/{}/pulls/{number}", encode(owner), encode(name));
        self.send("PATCH", &path, Some(json!({"body": body})))
            .map(|_| ())
    }

    fn pull_state(&self, owner: &str, name: &str, number: u64) -> Result<PullState, ApiError> {
        let path = format!("/repos/{}/{}/pulls/{number}", encode(owner), encode(name));
        let (_, v) = self.send("GET", &path, None)?;
        Ok(PullState {
            state: v["state"].as_str().unwrap_or_default().to_string(),
            merged: !v["merged_at"].is_null(),
        })
    }
}

/// The real clients: a credential from `source`, an `Api` for it.
pub struct RealHosts<'a> {
    pub source: &'a dyn CredentialSource,
    #[cfg(test)]
    pub(crate) root_override: Option<String>,
}

impl<'a> RealHosts<'a> {
    pub fn new(source: &'a dyn CredentialSource) -> Self {
        RealHosts {
            source,
            #[cfg(test)]
            root_override: None,
        }
    }
}

impl GitHubHosts for RealHosts<'_> {
    fn github(&self, host: &str) -> Option<Box<dyn GitHub>> {
        let credential = credential_for(host, self.source)?;
        #[cfg(test)]
        if let Some(root) = &self.root_override {
            return Some(Box::new(Api::with_root(root, credential)));
        }
        Some(Box::new(Api::new(host, credential)))
    }
    fn credential(&self, host: &str) -> Option<Credential> {
        credential_for(host, self.source)
    }
}

#[cfg(test)]
mod fake;
#[cfg(test)]
pub(crate) use fake::FakeGitHub;
#[cfg(test)]
pub(crate) mod tests;
