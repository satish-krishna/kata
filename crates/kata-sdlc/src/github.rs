//! GitHub through its REST API with the engineer's existing sign-in. Owns "Which GitHub
//! credential a host gets" and "How a GitHub API request is made". Kata keeps no credential: it
//! is looked up fresh for each use, held in memory for that call, and never written, logged or
//! put in an error.

use std::fmt;

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
    fn env(&self, _name: &str) -> Option<String> {
        None
    }
    fn stored(&self, _target: &str) -> Option<String> {
        None
    }
    fn hosts_file_token(&self, _host: &str) -> Option<String> {
        None
    }
}

/// The credential a host gets, first match wins.
pub fn credential_for(_host: &str, _source: &dyn CredentialSource) -> Option<Credential> {
    None
}

/// The `oauth_token` of `host` in the text of a GitHub CLI `hosts.yml`.
pub fn parse_hosts_yml(_text: &str, _host: &str) -> Option<String> {
    None
}

/// The owner and repository name in a remote URL (HTTPS, `ssh://` or scp-style).
pub fn parse_repo_path(_url: &str) -> Option<(String, String)> {
    None
}

/// Why a GitHub request failed. The text holds the status and GitHub's `message` only.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ApiError {
    #[error("GitHub answered {status}: {message}")]
    Status { status: u16, message: String },
    #[error("GitHub could not be reached: {0}")]
    Unreachable(String),
}

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
}

/// The real API client for one host.
#[derive(Debug)]
pub struct Api;

impl Api {
    pub fn new(_host: &str, _credential: Credential) -> Api {
        Api
    }
    #[cfg(test)]
    pub(crate) fn with_root(_root: &str, _credential: Credential) -> Api {
        Api
    }
}

impl GitHub for Api {
    fn user(&self) -> Result<String, ApiError> {
        todo!()
    }
    fn repo(&self, _o: &str, _n: &str) -> Result<(), ApiError> {
        todo!()
    }
    fn open_pull_for_branch(&self, _o: &str, _n: &str, _b: &str) -> Result<Option<Pull>, ApiError> {
        todo!()
    }
    fn create_pull(
        &self,
        _o: &str,
        _n: &str,
        _base: &str,
        _head: &str,
        _t: &str,
        _b: &str,
    ) -> Result<Pull, ApiError> {
        todo!()
    }
    fn edit_pull_body(&self, _o: &str, _n: &str, _num: u64, _b: &str) -> Result<(), ApiError> {
        todo!()
    }
    fn pull_state(&self, _o: &str, _n: &str, _num: u64) -> Result<PullState, ApiError> {
        todo!()
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
    fn github(&self, _host: &str) -> Option<Box<dyn GitHub>> {
        None
    }
}

#[cfg(test)]
mod fake;
#[cfg(test)]
pub(crate) use fake::FakeGitHub;
#[cfg(test)]
mod tests;
