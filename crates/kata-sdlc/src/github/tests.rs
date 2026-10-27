use super::*;
use crate::publish::{self, NotReady, PrOutcome, PublishRepo};
use crate::testutil::{repo, run};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub(crate) const TOKEN: &str = "ghp_faketoken0123456789";

#[derive(Default)]
pub(crate) struct FakeSource {
    env: HashMap<String, String>,
    stored: HashMap<String, String>,
    hosts: HashMap<String, String>,
    calls: Mutex<Vec<String>>,
}

impl FakeSource {
    pub(crate) fn env(mut self, k: &str, v: &str) -> Self {
        self.env.insert(k.into(), v.into());
        self
    }
    pub(crate) fn stored(mut self, k: &str, v: &str) -> Self {
        self.stored.insert(k.into(), v.into());
        self
    }
    pub(crate) fn hosts_file(mut self, k: &str, v: &str) -> Self {
        self.hosts.insert(k.into(), v.into());
        self
    }
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl CredentialSource for FakeSource {
    fn env(&self, name: &str) -> Option<String> {
        self.calls.lock().unwrap().push(format!("env:{name}"));
        self.env.get(name).cloned()
    }
    fn stored(&self, target: &str) -> Option<String> {
        self.calls.lock().unwrap().push(format!("stored:{target}"));
        self.stored.get(target).cloned()
    }
    fn hosts_file_token(&self, host: &str) -> Option<String> {
        self.calls.lock().unwrap().push(format!("hosts:{host}"));
        self.hosts.get(host).cloned()
    }
}

pub(crate) struct Req {
    pub(crate) method: String,
    pub(crate) path: String,
    headers: Vec<(String, String)>,
    pub(crate) body: String,
}

impl Req {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

pub(crate) struct Resp {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: String,
}

pub(crate) fn resp(status: u16, body: &str) -> Resp {
    Resp {
        status,
        headers: Vec::new(),
        body: body.to_string(),
    }
}

pub(crate) struct Server {
    pub(crate) port: u16,
    pub(crate) seen: Arc<Mutex<Vec<Req>>>,
}

impl Server {
    pub(crate) fn root(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub(crate) fn count(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
    fn first_header(&self, name: &str) -> Option<String> {
        self.seen
            .lock()
            .unwrap()
            .first()?
            .header(name)
            .map(String::from)
    }
}

fn read_request(stream: &std::net::TcpStream) -> Option<Req> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = Vec::new();
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).ok()?;
        let h = h.trim_end();
        if h.is_empty() {
            break;
        }
        let (k, v) = h.split_once(':')?;
        headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
    }
    let len = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).ok()?;
    Some(Req {
        method,
        path,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

/// A local HTTP server answering every request from `handler`, closing each connection.
pub(crate) fn serve(handler: impl Fn(&Req) -> Resp + Send + 'static) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let Some(req) = read_request(&stream) else {
                continue;
            };
            let r = handler(&req);
            log.lock().unwrap().push(req);
            let mut out = format!("HTTP/1.1 {} X\r\n", r.status);
            for (k, v) in &r.headers {
                out.push_str(&format!("{k}: {v}\r\n"));
            }
            out.push_str(&format!(
                "Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                r.body.len(),
                r.body
            ));
            let _ = stream.write_all(out.as_bytes());
        }
    });
    Server { port, seen }
}

pub(crate) fn refused_root() -> String {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    format!("http://127.0.0.1:{port}")
}

pub(crate) fn hosts<'a>(source: &'a FakeSource, root: &str) -> RealHosts<'a> {
    let mut h = RealHosts::new(source);
    h.root_override = Some(root.to_string());
    h
}

fn app_repo(dir: &Path, url: &str) -> PublishRepo {
    let path = repo(dir, "app");
    run(&path, &["remote", "add", "origin", url]).unwrap();
    PublishRepo {
        repo: "app".into(),
        path: path.to_string_lossy().into_owned(),
        base: "main".into(),
    }
}

#[test]
fn credential_precedence() {
    let full = |host: &str| {
        FakeSource::default()
            .env("GH_TOKEN", "env-gh")
            .env("GITHUB_TOKEN", "env-github")
            .env("GH_ENTERPRISE_TOKEN", "env-gh-ent")
            .env("GITHUB_ENTERPRISE_TOKEN", "env-github-ent")
            .stored(&format!("gh:{host}:"), "gh-store")
            .hosts_file(host, "hosts-file")
            .stored(&format!("git:https://{host}"), "git-store")
    };
    let token = |s: &FakeSource, host: &str| credential_for(host, s).map(|c| c.token().to_string());
    let s = full("github.com");
    assert_eq!(token(&s, "github.com").as_deref(), Some("env-gh"));
    let mut s = full("github.com");
    s.env.remove("GH_TOKEN");
    assert_eq!(token(&s, "github.com").as_deref(), Some("env-github"));
    s.env.remove("GITHUB_TOKEN");
    assert_eq!(token(&s, "github.com").as_deref(), Some("gh-store"));
    s.stored.remove("gh:github.com:");
    assert_eq!(token(&s, "github.com").as_deref(), Some("hosts-file"));
    s.hosts.clear();
    assert_eq!(token(&s, "github.com").as_deref(), Some("git-store"));
    s.stored.clear();
    assert_eq!(token(&s, "github.com"), None);

    let host = "ghe.example.com";
    let mut s = full(host);
    assert_eq!(token(&s, host).as_deref(), Some("env-gh-ent"));
    s.env.remove("GH_ENTERPRISE_TOKEN");
    assert_eq!(token(&s, host).as_deref(), Some("env-github-ent"));
    s.env.remove("GITHUB_ENTERPRISE_TOKEN");
    assert_eq!(token(&s, host).as_deref(), Some("gh-store"));
    s.stored.remove(&format!("gh:{host}:"));
    assert_eq!(token(&s, host).as_deref(), Some("hosts-file"));
    s.hosts.clear();
    assert_eq!(token(&s, host).as_deref(), Some("git-store"));

    // The github.com tokens never go to another host, nor the enterprise tokens to github.com.
    let s = FakeSource::default()
        .env("GH_TOKEN", "a")
        .env("GITHUB_TOKEN", "b");
    assert_eq!(token(&s, host), None);
    let s = FakeSource::default()
        .env("GH_ENTERPRISE_TOKEN", "a")
        .env("GITHUB_ENTERPRISE_TOKEN", "b");
    assert_eq!(token(&s, "github.com"), None);
    // An empty variable is no sign-in; the credential names its host.
    let s = FakeSource::default()
        .env("GH_TOKEN", " ")
        .env("GITHUB_TOKEN", "b");
    let c = credential_for("github.com", &s).unwrap();
    assert_eq!((c.host(), c.token()), ("github.com", "b"));
}

#[test]
fn hosts_file_and_repo_urls() {
    let yml = "# comment\ngithub.com:\n    git_protocol: https\n    users:\n        octo:\n            oauth_token: gho_nested\n    user: octo\nghe.example.com:\n    user: me\n    oauth_token: \"gho_ghe\"\nplain.example.com:\n    user: x\n";
    assert_eq!(
        parse_hosts_yml(yml, "github.com").as_deref(),
        Some("gho_nested")
    );
    assert_eq!(
        parse_hosts_yml(yml, "ghe.example.com").as_deref(),
        Some("gho_ghe")
    );
    assert_eq!(parse_hosts_yml(yml, "plain.example.com"), None);
    assert_eq!(parse_hosts_yml(yml, "other.example.com"), None);

    let want = Some(("acme".to_string(), "app".to_string()));
    for u in [
        "https://github.com/acme/app.git",
        "https://github.com/acme/app",
        "https://bot:s3cret@ghe.example.com:8443/acme/app.git/",
        "git@ghe.example.com:acme/app.git",
        "ssh://git@github.com:22/acme/app.git",
    ] {
        assert_eq!(parse_repo_path(u), want, "{u}");
    }
    for u in [
        "/srv/git/app.git",
        "file:///srv/git/app.git",
        "C:\\repos\\app.git",
        "https://github.com/acme",
        "https://github.com/a/b/c",
        "",
    ] {
        assert_eq!(parse_repo_path(u), None, "{u}");
    }
}

#[test]
fn signed_in_table() {
    let tmp = tempfile::tempdir().unwrap();
    let repos = [app_repo(tmp.path(), "https://github.com/o/app.git")];
    let not_signed_in = NotReady::NotSignedIn("github.com".into());

    // 1. No credential: GitHub is not asked.
    let server = serve(|_| resp(200, r#"{"login":"octo"}"#));
    let src = FakeSource::default();
    let got = publish::signed_in(&hosts(&src, &server.root()), &repos).unwrap_err();
    assert_eq!(got, not_signed_in);
    assert_eq!(server.count(), 0);

    // 2. 200: the account line, with the credential and the agent name on the request.
    let src = FakeSource::default().env("GH_TOKEN", TOKEN);
    let got = publish::signed_in(&hosts(&src, &server.root()), &repos).unwrap();
    assert_eq!(got, "Logged in to github.com as octo");
    assert_eq!(
        server.first_header("authorization").unwrap(),
        format!("Bearer {TOKEN}")
    );
    assert_eq!(server.first_header("user-agent").unwrap(), "kata-workbench");

    // 3. 401 and 403.
    for status in [401, 403] {
        let server = serve(move |_| resp(status, r#"{"message":"Bad credentials"}"#));
        let got = publish::signed_in(&hosts(&src, &server.root()), &repos).unwrap_err();
        assert_eq!(got, not_signed_in, "{status}");
    }

    // 4. 5xx.
    let server = serve(|_| resp(503, r#"{"message":"unavailable"}"#));
    let got = publish::signed_in(&hosts(&src, &server.root()), &repos).unwrap_err();
    assert_eq!(got, NotReady::Unreachable);

    // 5. No answer.
    let got = publish::signed_in(&hosts(&src, &refused_root()), &repos).unwrap_err();
    assert_eq!(got, NotReady::Unreachable);
}

#[test]
fn origins_table() {
    let tmp = tempfile::tempdir().unwrap();
    let src = FakeSource::default().env("GH_TOKEN", TOKEN);
    let good = [app_repo(tmp.path(), "https://github.com/o/app.git")];
    let server = serve(|r| {
        if r.path == "/repos/o/app" {
            resp(200, "{}")
        } else {
            resp(404, r#"{"message":"Not Found"}"#)
        }
    });
    assert!(publish::origins(&hosts(&src, &server.root()), &good).is_ok());

    let tmp2 = tempfile::tempdir().unwrap();
    let missing = [app_repo(tmp2.path(), "https://github.com/o/gone.git")];
    let err = publish::origins(&hosts(&src, &server.root()), &missing).unwrap_err();
    assert_eq!(err, NotReady::NoRemote("app".into()));
    for status in [401, 403] {
        let s = serve(move |_| resp(status, "{}"));
        let err = publish::origins(&hosts(&src, &s.root()), &good).unwrap_err();
        assert_eq!(err, NotReady::NoRemote("app".into()), "{status}");
    }
    let tmp3 = tempfile::tempdir().unwrap();
    let local = [app_repo(tmp3.path(), "/srv/git/app.git")];
    let err = publish::origins(&hosts(&src, &server.root()), &local).unwrap_err();
    assert_eq!(err, NotReady::NoRemote("app".into()));
    let s = serve(|_| resp(500, "{}"));
    let err = publish::origins(&hosts(&src, &s.root()), &good).unwrap_err();
    assert_eq!(err, NotReady::Unreachable);
    let err = publish::origins(&hosts(&src, &refused_root()), &good).unwrap_err();
    assert_eq!(err, NotReady::Unreachable);
}

#[test]
fn requests_follow_the_rest_table() {
    let server = serve(|r| match (r.method.as_str(), r.path.as_str()) {
        ("GET", "/repos/o/n") => resp(200, "{}"),
        ("GET", "/repos/o/n/pulls?head=o%3Achange%2Fx&state=open") => resp(
            200,
            r#"[{"number":7,"html_url":"https://github.com/o/n/pull/7"}]"#,
        ),
        ("GET", "/repos/o/n/pulls?head=o%3Aother&state=open") => resp(200, "[]"),
        ("POST", "/repos/o/n/pulls") => resp(
            201,
            r#"{"number":8,"html_url":"https://github.com/o/n/pull/8"}"#,
        ),
        ("PATCH", "/repos/o/n/pulls/8") => resp(200, "{}"),
        ("GET", "/repos/o/n/pulls/8") => resp(
            200,
            r#"{"state":"closed","merged_at":"2026-01-01T00:00:00Z"}"#,
        ),
        ("GET", "/repos/o/n/pulls/9") => resp(200, r#"{"state":"open","merged_at":null}"#),
        _ => resp(404, r#"{"message":"Not Found"}"#),
    });
    let api = Api::with_root(&server.root(), Credential::new("github.com", TOKEN));
    api.repo("o", "n").unwrap();
    let pull = api
        .open_pull_for_branch("o", "n", "change/x")
        .unwrap()
        .unwrap();
    assert_eq!(
        pull,
        Pull {
            number: 7,
            url: "https://github.com/o/n/pull/7".into()
        }
    );
    assert_eq!(api.open_pull_for_branch("o", "n", "other").unwrap(), None);
    let made = api
        .create_pull("o", "n", "main", "change/x", "A title", "A \"body\"\nline")
        .unwrap();
    assert_eq!(made.number, 8);
    api.edit_pull_body("o", "n", 8, "new body").unwrap();
    assert_eq!(
        api.pull_state("o", "n", 8).unwrap(),
        PullState {
            state: "closed".into(),
            merged: true
        }
    );
    assert!(!api.pull_state("o", "n", 9).unwrap().merged);
    let seen = server.seen.lock().unwrap();
    let post: serde_json::Value = serde_json::from_str(&seen[3].body).unwrap();
    assert_eq!(
        post,
        serde_json::json!({"title":"A title","head":"change/x","base":"main","body":"A \"body\"\nline"})
    );
    let patch: serde_json::Value = serde_json::from_str(&seen[4].body).unwrap();
    assert_eq!(patch, serde_json::json!({"body":"new body"}));
}

#[test]
fn credential_goes_only_to_its_host() {
    // R10.3, API half: a redirect to another host or port is refused.
    let other = serve(|_| resp(200, r#"{"login":"intruder"}"#));
    for target in [
        format!("http://localhost:{}/user", other.port),
        format!("http://127.0.0.1:{}/user", other.port),
    ] {
        let first = serve(move |_| Resp {
            status: 302,
            headers: vec![("Location".into(), target.clone())],
            body: String::new(),
        });
        let api = Api::with_root(&first.root(), Credential::new("github.com", TOKEN));
        let err = api.user().unwrap_err();
        assert!(matches!(err, ApiError::Unreachable(_)), "{err:?}");
        assert_eq!(first.count(), 1);
        assert_eq!(other.count(), 0, "the other host saw a request");
    }
    // A redirect inside the host is followed, with the credential.
    let same = serve(|r| {
        if r.path == "/user" {
            Resp {
                status: 302,
                headers: vec![("Location".into(), "/user2".into())],
                body: String::new(),
            }
        } else {
            resp(200, r#"{"login":"octo"}"#)
        }
    });
    let api = Api::with_root(&same.root(), Credential::new("github.com", TOKEN));
    assert_eq!(api.user().unwrap(), "octo");
    let seen = same.seen.lock().unwrap();
    assert_eq!(
        seen[1].header("authorization").unwrap(),
        format!("Bearer {TOKEN}")
    );
}

#[test]
fn no_credential_in_errors_logs_or_record() {
    // R10.2: even a server that echoes the token back leaves it out of every text.
    let cred = Credential::new("github.com", TOKEN);
    assert!(!format!("{cred:?}").contains(TOKEN));
    for status in [401, 500] {
        let body = format!(r#"{{"message":"rejected {TOKEN} for you"}}"#);
        let server = serve(move |_| resp(status, &body));
        let api = Api::with_root(&server.root(), cred.clone());
        let err = api.user().unwrap_err();
        assert!(matches!(err, ApiError::Status { .. }), "{err:?}");
        assert!(!err.to_string().contains(TOKEN), "{err}");
        assert!(!format!("{err:?}").contains(TOKEN), "{err:?}");
        assert!(!format!("{:?}", api.repo("o", "n")).contains(TOKEN));
        assert!(!format!("{:?}", Api::with_root(&server.root(), cred.clone())).contains(TOKEN));
    }
    let down = Api::with_root(&refused_root(), cred.clone())
        .user()
        .unwrap_err();
    assert!(!down.to_string().contains(TOKEN));

    let tmp = tempfile::tempdir().unwrap();
    let repos = [app_repo(tmp.path(), "https://github.com/o/app.git")];
    let src = FakeSource::default().env("GH_TOKEN", TOKEN);
    let body = format!(r#"{{"message":"server error {TOKEN}"}}"#);
    let server = serve(move |_| resp(500, &body));
    let h = hosts(&src, &server.root());
    let results = publish::publish(
        &h,
        "app",
        "s",
        "2026-10-19-c",
        &repos,
        &mut publish::Recorder::unsaved(),
        &mut |_| {},
    );
    assert!(
        matches!(results[0].outcome, PrOutcome::Failed { .. }),
        "{results:?}"
    );
    let json = serde_json::to_string(&results).unwrap();
    assert!(!json.contains(TOKEN), "{json}");
    let err = publish::signed_in(&h, &repos).unwrap_err();
    assert!(!err.to_string().contains(TOKEN));
    assert!(!format!("{err:?}").contains(TOKEN));
}

#[test]
fn expired_sign_in_gives_the_plain_message_and_no_prompt() {
    // R10.4
    let tmp = tempfile::tempdir().unwrap();
    let repos = [app_repo(tmp.path(), "https://github.com/o/app.git")];
    let server = serve(|_| resp(401, r#"{"message":"Bad credentials"}"#));
    let src = FakeSource::default().env("GH_TOKEN", TOKEN);
    let err = publish::signed_in(&hosts(&src, &server.root()), &repos).unwrap_err();
    assert_eq!(
        err.to_string(),
        "Not signed in to github.com. Sign in with gh auth login or Git Credential Manager, then declare done again."
    );
    // The source only reads: its trait has no prompt, and it was asked for nothing else.
    for call in src.calls() {
        assert!(
            ["env:", "stored:", "hosts:"]
                .iter()
                .any(|p| call.starts_with(p)),
            "{call}"
        );
    }
}

#[test]
fn credential_blobs_decode_as_utf16_or_utf8() {
    let utf16: Vec<u8> = "gho_abc"
        .encode_utf16()
        .flat_map(|u| u.to_le_bytes())
        .collect();
    assert_eq!(decode_blob(&utf16).as_deref(), Some("gho_abc"));
    assert_eq!(decode_blob(b"gho_abc\n").as_deref(), Some("gho_abc"));
    assert_eq!(decode_blob(b""), None);
}
