//! Holds on product repositories: which change is building or reviewing in a repository. A change
//! takes every repository it needs at once or none, so two builds that need the same repository
//! are told apart at the moment they start. The table lives behind one `Mutex` in the backend.
use crate::ai_sdlc::state::ChangeState;
use crate::format::ParsedPlan;
use serde::Serialize;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// One change of one system in one workspace.
#[derive(Serialize, Clone, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ChangeKey {
    pub workspace: RepoKey,
    pub system: String,
    pub change: String,
}

/// A repository by its normalized path. The display name (the folder's name) rides along for
/// messages; it takes no part in equality or hashing.
#[derive(Serialize, Clone, Debug)]
pub struct RepoKey {
    key: String,
    name: String,
}

impl PartialEq for RepoKey {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}
impl Eq for RepoKey {}
impl Hash for RepoKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.key.hash(state)
    }
}

impl RepoKey {
    /// A lexical key for a repository folder: separators unified, `.` and repeated or trailing
    /// separators dropped, and case folded on Windows. Nothing here touches the filesystem.
    pub fn of(path: &Path) -> RepoKey {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        RepoKey {
            key: String::new(),
            name,
        }
    }

    /// The same normalization as `of`, as a bare string.
    pub(crate) fn normalize(path: &str, fold_case: bool) -> String {
        let _ = (path, fold_case);
        String::new()
    }

    /// The repository's folder name, for messages.
    pub fn name(&self) -> &str {
        &self.name
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Purpose {
    Build,
    Review,
}

/// A take that found repositories held by other changes: every one of them, in request order,
/// with its display name and holder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub held: Vec<(String, ChangeKey)>,
}

#[derive(Default, Debug)]
pub struct HoldTable {
    holds: HashMap<RepoKey, Hold>,
}

#[derive(Debug)]
struct Hold {
    change: ChangeKey,
    build: bool,
    review: bool,
}

impl HoldTable {
    pub fn take(
        &mut self,
        change: &ChangeKey,
        purpose: Purpose,
        repos: &[RepoKey],
    ) -> Result<(), Held> {
        let _ = (change, purpose, repos);
        Ok(())
    }

    pub fn release(&mut self, change: &ChangeKey, purpose: Purpose) {
        let _ = (change, purpose);
    }

    pub fn holder(&self, repo: &RepoKey) -> Option<&ChangeKey> {
        let _ = repo;
        None
    }
}

/// The product repositories a build needs: the plan's repositories in plan order that have an unlogged task in
/// the change or are named in a round, then round repositories the plan does not name. Never the master.
pub fn needed_repos(
    plan: &ParsedPlan,
    change: &ChangeState,
    rounds: &[String],
    master_name: &str,
) -> Vec<String> {
    let _ = (plan, change, rounds, master_name);
    todo!()
}

/// Every product repository the change has tasks in, other than the master.
pub fn review_repos(change: &ChangeState, master_name: &str) -> Vec<String> {
    let _ = (change, master_name);
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex};
    use crate::ai_sdlc::state::RepoTasks;
    use crate::format::ParsedTask;
    use crate::permissions::fixtures::change_state;
    use std::collections::BTreeMap;

    fn task(id: &str, repo: &str) -> ParsedTask {
        ParsedTask {
            id: id.into(),
            name: id.into(),
            repo: repo.into(),
            depends_on: Vec::new(),
            uses: Vec::new(),
            files: Vec::new(),
            covers: Vec::new(),
            supports: Vec::new(),
            sections: Vec::new(),
            text: String::new(),
            line: 1,
        }
    }

    fn plan(repos: &[&str]) -> ParsedPlan {
        ParsedPlan {
            tasks: repos
                .iter()
                .enumerate()
                .map(|(i, r)| task(&format!("T{}", i + 1), r))
                .collect(),
            shared_decisions: Vec::new(),
        }
    }

    fn state(repos: &[(&str, &[&str])]) -> ChangeState {
        let mut s = change_state("c", "/ws/master", false);
        s.tasks = Some(
            repos
                .iter()
                .map(|(r, u)| {
                    let ids: Vec<String> = u.iter().map(|s| s.to_string()).collect();
                    (
                        r.to_string(),
                        RepoTasks {
                            all: ids.clone(),
                            logged: Vec::new(),
                            unlogged: ids,
                            commits: None,
                            untasked: None,
                            uncommitted: None,
                        },
                    )
                })
                .collect::<BTreeMap<_, _>>(),
        );
        s
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn needed_repos_reads_unlogged_tasks_from_state() {
        // Plan order is web, kata, master, bob, api; the BTreeMap would give api, bob, kata, master, web.
        let p = plan(&["web", "kata", "master", "bob", "api"]);
        let s = state(&[
            ("api", &["T5"]),
            ("bob", &[]),
            ("kata", &["T2"]),
            ("master", &["T3"]),
            ("web", &["T1"]),
        ]);
        // A round repository the plan names keeps its plan place; one the plan does not name comes last.
        let rounds = names(&["bob", "extra", "master"]);
        assert_eq!(
            needed_repos(&p, &s, &rounds, "master"),
            names(&["web", "kata", "bob", "api", "extra"])
        );
        assert_eq!(
            needed_repos(&p, &s, &[], "master"),
            names(&["web", "kata", "api"])
        );
    }

    #[test]
    fn review_repos_leaves_out_the_master() {
        let s = state(&[("master", &[]), ("kata", &[]), ("app", &[])]);
        assert_eq!(review_repos(&s, "master"), names(&["app", "kata"]));
    }


    fn key(change: &str) -> ChangeKey {
        ChangeKey {
            workspace: RepoKey::of(Path::new("/ws")),
            system: "s".into(),
            change: change.into(),
        }
    }

    fn repo(name: &str) -> RepoKey {
        RepoKey::of(&Path::new("/ws").join(name))
    }

    #[test]
    fn two_takes_for_one_repository_give_it_to_exactly_one() {
        for _ in 0..50 {
            let table = Arc::new(Mutex::new(HoldTable::default()));
            let barrier = Arc::new(Barrier::new(2));
            let handles: Vec<_> = ["B", "C"]
                .into_iter()
                .map(|c| {
                    let (table, barrier) = (table.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        barrier.wait();
                        let r =
                            table
                                .lock()
                                .unwrap()
                                .take(&key(c), Purpose::Build, &[repo("kata")]);
                        (c, r)
                    })
                })
                .collect();
            let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
            let winners: Vec<_> = results.iter().filter(|(_, r)| r.is_ok()).collect();
            assert_eq!(winners.len(), 1, "{results:?}");
            let winner = winners[0].0;
            let (_, loser) = results.iter().find(|(_, r)| r.is_err()).unwrap();
            assert_eq!(
                loser.as_ref().unwrap_err().held,
                [("kata".to_string(), key(winner))]
            );
        }
    }

    #[test]
    fn take_rows() {
        let mut t = HoldTable::default();
        t.take(&key("A"), Purpose::Build, &[repo("kata")]).unwrap();

        // Row 1: one held by another change; every such repository is listed in request order.
        t.take(&key("D"), Purpose::Build, &[repo("web")]).unwrap();
        let err = t
            .take(
                &key("B"),
                Purpose::Build,
                &[repo("web"), repo("bob"), repo("kata")],
            )
            .unwrap_err();
        assert_eq!(
            err.held,
            [
                ("web".to_string(), key("D")),
                ("kata".to_string(), key("A"))
            ]
        );
        assert_eq!(t.holder(&repo("bob")), None);

        // Row 2: free or held by this change; a hold for the other purpose is kept.
        t.take(&key("A"), Purpose::Review, &[repo("kata"), repo("bob")])
            .unwrap();
        assert_eq!(t.holder(&repo("kata")), Some(&key("A")));
        assert_eq!(t.holder(&repo("bob")), Some(&key("A")));
        t.release(&key("A"), Purpose::Build);
        assert_eq!(t.holder(&repo("kata")), Some(&key("A")));
        t.release(&key("A"), Purpose::Review);
        assert_eq!(t.holder(&repo("kata")), None);

        // Row 3: nothing requested, nothing taken.
        t.take(&key("B"), Purpose::Build, &[]).unwrap();
        assert_eq!(t.holder(&repo("kata")), None);
    }

    #[test]
    fn a_failed_take_takes_nothing() {
        let mut t = HoldTable::default();
        t.take(&key("A"), Purpose::Build, &[repo("kata")]).unwrap();
        assert!(t
            .take(&key("B"), Purpose::Build, &[repo("bob"), repo("kata")])
            .is_err());
        assert_eq!(t.holder(&repo("bob")), None);
        assert_eq!(t.holder(&repo("kata")), Some(&key("A")));
    }

    #[test]
    fn release_keeps_the_other_purpose() {
        let mut t = HoldTable::default();
        t.take(&key("A"), Purpose::Build, &[repo("kata")]).unwrap();
        t.take(&key("A"), Purpose::Review, &[repo("kata")]).unwrap();
        t.release(&key("A"), Purpose::Build);
        assert_eq!(t.holder(&repo("kata")), Some(&key("A")));
        assert!(t.take(&key("B"), Purpose::Build, &[repo("kata")]).is_err());
        t.release(&key("A"), Purpose::Review);
        assert_eq!(t.holder(&repo("kata")), None);
        t.take(&key("B"), Purpose::Build, &[repo("kata")]).unwrap();
    }

    #[test]
    fn repo_key_folds_case_on_windows_only() {
        // Separators, `.` and trailing separators never matter.
        assert_eq!(
            RepoKey::normalize("D:\\ws\\.\\kata\\", true),
            RepoKey::normalize("d:/ws//kata", true)
        );
        assert_eq!(
            RepoKey::normalize("D:\\ws\\Kata", true),
            RepoKey::normalize("d:/ws/kata", true)
        );
        assert_ne!(
            RepoKey::normalize("/ws/Kata", false),
            RepoKey::normalize("/ws/kata", false)
        );
        assert_eq!(RepoKey::normalize("/ws/kata/", false), "/ws/kata");
        // `of` follows the platform.
        assert_eq!(
            RepoKey::of(Path::new("/ws/Kata")) == RepoKey::of(Path::new("/ws/kata")),
            cfg!(windows)
        );
    }
}
