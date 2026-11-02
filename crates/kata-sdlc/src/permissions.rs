//! The permission rules of a run of a change: what each kind of run may edit, in claude's rule shape.
//!
//! Only `Edit(path)` rules are checked by claude's file permissions (they cover `Write` and every other
//! editing tool). On Windows claude matches only the colon-less, lowercase-drive form, so `D:\ws` is
//! `//d/ws`; the proofs in `crates/kata-core/tests/run_it.rs` take their rule strings from [`rule_path`].

use crate::ai_sdlc::state::ChangeState;
use std::path::{Path, PathBuf};

/// What a run is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunKind {
    /// Setup, context, intent, spec or plan: follows the app's permission setting.
    Document,
    Triage,
    Fix,
    /// The build of one repository.
    Build {
        repo: String,
    },
    Review,
}

/// What a run is and where it runs.
#[derive(Clone, Debug)]
pub struct RunPlace {
    pub kind: RunKind,
    /// The system the change belongs to.
    pub system: String,
    /// Where the change stands: its master (a copy or the engineer's checkout) and its documents' folder.
    pub state: ChangeState,
    /// The folder that holds the master repository and the product repositories.
    pub workspace: PathBuf,
    /// The engineer's own checkout of the master repository.
    pub checkout: PathBuf,
    /// The masters of every other change of the workspace that lives in a copy.
    pub other_copies: Vec<PathBuf>,
    /// Folder names of the system's repositories, inside the workspace.
    pub system_repos: Vec<String>,
    /// Kata's workbench folder; no run may edit the parse cache in it.
    pub workbench_dir: PathBuf,
}

/// The deny and allow lists of a run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Rules {
    pub deny: Vec<String>,
    pub allow: Vec<String>,
}

const BUILD_DENY: [&str; 3] = ["Bash(git push:*)", "Bash(gh:*)", "Bash(git remote:*)"];

/// The path with forward slashes and no trailing slash.
pub(crate) fn slashes(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// A path in claude's absolute-path rule form: `//` then the path with forward slashes. On Windows
/// claude matches only the colon-less, lowercase-drive form (`D:\ws` becomes `//d/ws`).
pub fn rule_path(path: &Path) -> String {
    let s = slashes(path);
    let b = s.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'/')
    {
        let rest = if b.len() == 2 { "" } else { &s[3..] };
        return format!("//{}/{}", s[..1].to_lowercase(), rest);
    }
    format!("//{}", s.trim_start_matches('/'))
}

impl RunPlace {
    /// The folder the change's documents are read and written in: its copy, or the engineer's checkout.
    pub fn master_path(&self) -> PathBuf {
        PathBuf::from(&self.state.master)
    }

    /// The folder name of the master repository's checkout.
    pub fn master_name(&self) -> String {
        self.checkout
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    /// The system's repositories and the master, once each, in order.
    fn all_repos(&self) -> Vec<String> {
        let mut seen: Vec<String> = Vec::new();
        for r in self
            .system_repos
            .iter()
            .cloned()
            .chain(std::iter::once(self.master_name()))
        {
            if !seen.contains(&r) {
                seen.push(r);
            }
        }
        seen
    }
}

fn edit_tree(path: &Path) -> String {
    format!("Edit({}/**)", rule_path(path))
}

/// The rules of a run.
pub fn rules(place: &RunPlace) -> Rules {
    let mut deny: Vec<String> = Vec::new();
    let mut allow: Vec<String> = Vec::new();
    if place.kind != RunKind::Document {
        let root = slashes(&place.workspace);
        deny.extend(BUILD_DENY.iter().map(|s| s.to_string()));
        let master_name = place.master_name();
        // Every product repository: a system repository other than the master.
        let mut product: Vec<(&str, String)> = Vec::new();
        for repo in &place.system_repos {
            if *repo != master_name && !product.iter().any(|(r, _)| r == repo) {
                product.push((repo, edit_tree(&Path::new(&root).join(repo))));
            }
        }
        allow.push(format!("Read({}/**)", rule_path(Path::new(&root))));
        // An agent that edited a parse cache entry would change what the page shows.
        let parse_cache = edit_tree(&place.workbench_dir.join("parse-cache"));
        let change_dir = slashes(Path::new(&place.state.folder));
        let doc = |name: &str| {
            format!(
                "Edit({})",
                rule_path(Path::new(&format!("{change_dir}/{name}.md")))
            )
        };
        let log = |name: &str| doc(&format!("build/{name}"));
        match &place.kind {
            RunKind::Review => {
                // The review records its findings in the change's review document and edits nothing else.
                // Deny beats allow in claude, so the workspace cannot be denied as a whole: every product
                // repository and every other document of the change is denied by name instead.
                deny.extend(product.into_iter().map(|(_, rule)| rule));
                deny.push(parse_cache);
                for other in place.all_repos() {
                    deny.push(log(&other));
                }
                for name in ["intent", "spec", "plan"] {
                    deny.push(doc(name));
                }
                allow.push(log("review"));
            }
            RunKind::Build { repo } => {
                // The shared rules deny every product repository; this run's own is the one it works in.
                deny.extend(
                    product
                        .into_iter()
                        .filter(|(r, _)| *r != repo)
                        .map(|(_, rule)| rule),
                );
                deny.push(parse_cache);
                // Deny beats allow in claude, so a `build/**` deny would block this run's own log.
                for other in place.all_repos() {
                    if other != *repo {
                        deny.push(log(&other));
                    }
                }
                // Earlier reviews are the review run's record; a build run does not rewrite them.
                deny.push(log("review"));
                allow.push(log(repo));
            }
            _ => {
                deny.extend(product.into_iter().map(|(_, rule)| rule));
                deny.push(parse_cache);
            }
        }
    }
    // No run of a change edits the engineer's own checkout or another change's copy (R19.1). When the
    // change is not in a copy its master is the checkout, and the checkout is not denied.
    let own = rule_path(&place.master_path());
    if place.state.in_copy {
        deny.push(edit_tree(&place.checkout));
    }
    for copy in &place.other_copies {
        let rule = edit_tree(copy);
        if rule_path(copy) != own && !deny.contains(&rule) {
            deny.push(rule);
        }
    }
    Rules { deny, allow }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use crate::ai_sdlc::state::*;
    use std::collections::BTreeMap;

    fn doc() -> StateDocument {
        StateDocument {
            exists: true,
            in_head: true,
            head_status: Some("accepted".into()),
            working_status: Some("accepted".into()),
            uncommitted: false,
            pin: None,
        }
    }

    fn gate() -> ReadyGate {
        ReadyGate {
            candidate: false,
            stop: None,
            accept: Vec::new(),
        }
    }

    /// A change that stands at `master`, with its documents in `<master>/intent/commerce/<change>`.
    pub fn change_state(change: &str, master: &str, in_copy: bool) -> ChangeState {
        ChangeState {
            change: change.into(),
            master: master.into(),
            folder: format!("{master}/intent/commerce/{change}"),
            in_copy,
            title: None,
            track: ChangeTrack::Full,
            documents: StateDocuments {
                intent: doc(),
                spec: doc(),
                plan: doc(),
            },
            scenarios: None,
            tasks: None,
            build_logs: BTreeMap::new(),
            review: ReviewState {
                committed: 0,
                draft: ReviewDraft::None,
            },
            fix: None,
            ready: Ready {
                spec: gate(),
                plan: gate(),
                build: gate(),
                review: gate(),
                done: gate(),
                reject: gate(),
            },
        }
    }

    pub const CHANGE: &str = "2026-10-12-photos";

    fn strs(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// A change with no copy: its master is the engineer's checkout.
    pub fn place(kind: RunKind) -> RunPlace {
        RunPlace {
            kind,
            system: "commerce".into(),
            state: change_state(CHANGE, "/home/u/ws/master", false),
            workspace: PathBuf::from("/home/u/ws"),
            checkout: PathBuf::from("/home/u/ws/master"),
            other_copies: Vec::new(),
            system_repos: strs(&["master", "app", "api"]),
            workbench_dir: PathBuf::from("/home/u/.kata/workbench"),
        }
    }

    pub const COPY_A: &str = "/home/u/ws/.ai-sdlc/copies/2026-10-12-photos";
    pub const COPY_B: &str = "/home/u/ws/.ai-sdlc/copies/2026-10-13-other";

    /// Change "A" in its own copy, with change "B" in another.
    pub fn place_in_copies(kind: RunKind) -> RunPlace {
        let mut p = place(kind);
        p.state = change_state(CHANGE, COPY_A, true);
        p.other_copies = vec![PathBuf::from(COPY_B)];
        p
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    const D: &str = "//home/u/ws/master/intent/commerce/2026-10-12-photos";

    fn sorted(mut v: Vec<String>) -> Vec<String> {
        v.sort();
        v
    }

    const BASE: [&str; 4] = [
        "Bash(git push:*)",
        "Bash(gh:*)",
        "Bash(git remote:*)",
        "Edit(//home/u/.kata/workbench/parse-cache/**)",
    ];

    #[test]
    fn rule_path_drops_the_colon_and_lowercases_the_drive() {
        assert_eq!(rule_path(Path::new(r"D:\ws")), "//d/ws");
        assert_eq!(rule_path(Path::new("D:/ws/")), "//d/ws");
        assert_eq!(rule_path(Path::new("C:/Users/u")), "//c/Users/u");
        assert_eq!(rule_path(Path::new("/home/u/ws")), "//home/u/ws");
        assert_eq!(rule_path(Path::new("D:")), "//d/");
    }

    #[test]
    fn rules_match_today_for_a_change_without_copies() {
        let repo = rules(&place(RunKind::Build { repo: "app".into() }));
        let mut want: Vec<String> = BASE.iter().map(|s| s.to_string()).collect();
        want.extend([
            "Edit(//home/u/ws/api/**)".to_string(),
            format!("Edit({D}/build/master.md)"),
            format!("Edit({D}/build/api.md)"),
            format!("Edit({D}/build/review.md)"),
        ]);
        assert_eq!(sorted(repo.deny), sorted(want));
        assert_eq!(
            repo.allow,
            vec![
                "Read(//home/u/ws/**)".to_string(),
                format!("Edit({D}/build/app.md)")
            ]
        );

        let review = rules(&place(RunKind::Review));
        let mut want: Vec<String> = BASE.iter().map(|s| s.to_string()).collect();
        want.extend([
            "Edit(//home/u/ws/app/**)".to_string(),
            "Edit(//home/u/ws/api/**)".to_string(),
            format!("Edit({D}/build/master.md)"),
            format!("Edit({D}/build/app.md)"),
            format!("Edit({D}/build/api.md)"),
            format!("Edit({D}/intent.md)"),
            format!("Edit({D}/spec.md)"),
            format!("Edit({D}/plan.md)"),
        ]);
        assert_eq!(sorted(review.deny), sorted(want));
        assert_eq!(
            review.allow,
            vec![
                "Read(//home/u/ws/**)".to_string(),
                format!("Edit({D}/build/review.md)")
            ]
        );

        for kind in [RunKind::Triage, RunKind::Fix] {
            let r = rules(&place(kind));
            let mut want: Vec<String> = BASE.iter().map(|s| s.to_string()).collect();
            want.extend([
                "Edit(//home/u/ws/app/**)".to_string(),
                "Edit(//home/u/ws/api/**)".to_string(),
            ]);
            assert_eq!(sorted(r.deny), sorted(want));
            assert_eq!(r.allow, vec!["Read(//home/u/ws/**)".to_string()]);
        }

        // A document run has no rules, and a change with no copy has no checkout to protect.
        let doc = rules(&place(RunKind::Document));
        assert!(doc.deny.is_empty() && doc.allow.is_empty());
    }

    #[test]
    fn a_runs_edits_stay_in_its_own_change() {
        let checkout = "Edit(//home/u/ws/master/**)";
        let b_copy = "Edit(//home/u/ws/.ai-sdlc/copies/2026-10-13-other/**)";
        let own_copy = "Edit(//home/u/ws/.ai-sdlc/copies/2026-10-12-photos/**)";
        let build = || RunKind::Build { repo: "app".into() };
        // (run, rule that must be in its deny list), one per Examples row of R19.1.
        let rows: Vec<(&str, RunKind, &str)> = vec![
            ("spec run, engineer's checkout", RunKind::Document, checkout),
            ("spec run, change B's copy", RunKind::Document, b_copy),
            ("build run, change B's copy", build(), b_copy),
            (
                "build run, another product repository",
                build(),
                "Edit(//home/u/ws/api/**)",
            ),
            (
                "review, a product repository",
                RunKind::Review,
                "Edit(//home/u/ws/app/**)",
            ),
            (
                "review, another product repository",
                RunKind::Review,
                "Edit(//home/u/ws/api/**)",
            ),
        ];
        for (label, kind, rule) in rows {
            let r = rules(&place_in_copies(kind));
            assert!(
                r.deny.iter().any(|d| d == rule),
                "{label}: {rule} is not denied in {:?}",
                r.deny
            );
        }
        // Every kind of run of the change denies the checkout and the other copy, never its own copy.
        for kind in [
            build(),
            RunKind::Review,
            RunKind::Triage,
            RunKind::Fix,
            RunKind::Document,
        ] {
            let r = rules(&place_in_copies(kind.clone()));
            assert!(r.deny.contains(&checkout.to_string()), "{kind:?}");
            assert!(r.deny.contains(&b_copy.to_string()), "{kind:?}");
            assert!(!r.deny.contains(&own_copy.to_string()), "{kind:?}");
        }
        // A build run's own log, in its own copy, is allowed.
        let log = "Edit(//home/u/ws/.ai-sdlc/copies/2026-10-12-photos/intent/commerce/2026-10-12-photos/build/app.md)";
        assert!(rules(&place_in_copies(build()))
            .allow
            .contains(&log.to_string()));
        // A document run has no other rules than these two.
        let doc = rules(&place_in_copies(RunKind::Document));
        assert_eq!(doc.deny, vec![checkout.to_string(), b_copy.to_string()]);
        assert!(doc.allow.is_empty());
    }
}
