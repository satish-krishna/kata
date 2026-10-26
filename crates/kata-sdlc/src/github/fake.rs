//! The test double for the GitHub requests. Clones share one state, so a test keeps a handle
//! while the code under test holds a boxed clone.
use super::*;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub(crate) struct FakeGitHub(Arc<Mutex<FakeState>>);

#[derive(Default)]
struct FakeState {
    login: Option<Result<String, ApiError>>,
    repo_answer: Option<ApiError>,
    list_error: Option<ApiError>,
    open: HashMap<String, u64>,
    create_errors: HashMap<String, ApiError>,
    no_credential: Vec<String>,
    calls: Vec<String>,
    bodies: Vec<(String, String)>,
    next: u64,
}

impl FakeGitHub {
    pub(crate) fn signed_out_of(self, host: &str) -> Self {
        self.0.lock().unwrap().no_credential.push(host.to_string());
        self
    }
    pub(crate) fn user_answers(self, answer: Result<&str, ApiError>) -> Self {
        self.0.lock().unwrap().login = Some(answer.map(String::from));
        self
    }
    pub(crate) fn repo_answers(self, error: ApiError) -> Self {
        self.0.lock().unwrap().repo_answer = Some(error);
        self
    }
    pub(crate) fn list_fails(self, error: ApiError) -> Self {
        self.0.lock().unwrap().list_error = Some(error);
        self
    }
    /// The repository already has this open pull request for the change branch.
    pub(crate) fn open_pull(self, repo: &str, number: u64) -> Self {
        self.0.lock().unwrap().open.insert(repo.to_string(), number);
        self
    }
    pub(crate) fn create_fails(self, repo: &str, error: ApiError) -> Self {
        self.0
            .lock()
            .unwrap()
            .create_errors
            .insert(repo.to_string(), error);
        self
    }
    pub(crate) fn calls(&self) -> Vec<String> {
        self.0.lock().unwrap().calls.clone()
    }
    /// The repositories a pull request was created in, in order.
    pub(crate) fn creates(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter_map(|c| c.strip_prefix("create_pull ").map(String::from))
            .map(|c| c.split(' ').next().unwrap().to_string())
            .collect()
    }
    /// The last body created or edited for this repository.
    pub(crate) fn body(&self, repo: &str) -> String {
        self.0
            .lock()
            .unwrap()
            .bodies
            .iter()
            .rfind(|(r, _)| r == repo)
            .map(|(_, b)| b.clone())
            .unwrap_or_default()
    }
}

impl GitHub for FakeGitHub {
    fn user(&self) -> Result<String, ApiError> {
        let mut s = self.0.lock().unwrap();
        s.calls.push("user".into());
        s.login.clone().unwrap_or_else(|| Ok("octo".into()))
    }
    fn repo(&self, owner: &str, name: &str) -> Result<(), ApiError> {
        let mut s = self.0.lock().unwrap();
        s.calls.push(format!("repo {owner}/{name}"));
        s.repo_answer.clone().map_or(Ok(()), Err)
    }
    fn open_pull_for_branch(
        &self,
        owner: &str,
        name: &str,
        branch: &str,
    ) -> Result<Option<Pull>, ApiError> {
        let mut s = self.0.lock().unwrap();
        s.calls
            .push(format!("open_pull_for_branch {name} {branch}"));
        if let Some(e) = s.list_error.clone() {
            return Err(e);
        }
        Ok(s.open.get(name).map(|n| Pull {
            number: *n,
            url: format!("https://github.com/{owner}/{name}/pull/{n}"),
        }))
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
        let mut s = self.0.lock().unwrap();
        s.calls.push(format!(
            "create_pull {name} base={base} head={head} title={title}"
        ));
        s.bodies.push((name.to_string(), body.to_string()));
        if let Some(e) = s.create_errors.get(name) {
            return Err(e.clone());
        }
        s.next += 1;
        let number = s.next;
        Ok(Pull {
            number,
            url: format!("https://github.com/{owner}/{name}/pull/{number}"),
        })
    }
    fn edit_pull_body(
        &self,
        _owner: &str,
        name: &str,
        number: u64,
        body: &str,
    ) -> Result<(), ApiError> {
        let mut s = self.0.lock().unwrap();
        s.calls.push(format!("edit_pull_body {name} {number}"));
        s.bodies.push((name.to_string(), body.to_string()));
        Ok(())
    }
    fn pull_state(&self, _o: &str, name: &str, number: u64) -> Result<PullState, ApiError> {
        let mut s = self.0.lock().unwrap();
        s.calls.push(format!("pull_state {name} {number}"));
        Ok(PullState {
            state: "open".into(),
            merged: false,
        })
    }
}

impl GitHubHosts for FakeGitHub {
    fn github(&self, host: &str) -> Option<Box<dyn GitHub>> {
        if self
            .0
            .lock()
            .unwrap()
            .no_credential
            .iter()
            .any(|h| h == host)
        {
            return None;
        }
        Some(Box::new(self.clone()))
    }
    fn credential(&self, _host: &str) -> Option<Credential> {
        None
    }
}
