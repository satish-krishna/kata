//! Repository reads, done with libgit2 so that reading works on a machine without git installed.
//! A failed operation is a `GitError`: `args` names the git command the operation replaces and
//! `stderr` carries libgit2's message.
use git2::{ErrorCode, ObjectType, Oid, StatusOptions, Tree};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// A failed repository operation: the git command it replaces and the reason.
#[derive(Debug, thiserror::Error)]
#[error("git {args}: {stderr}")]
pub struct GitError {
    pub args: String,
    pub stderr: String,
}

impl GitError {
    /// A libgit2 failure reported the way a failed git command was: `action` names the command the
    /// operation replaces and `stderr` is libgit2's message. A lock error always names `index.lock`,
    /// which is what callers that wait for a lock to clear look for.
    pub fn from_git2(action: &str, e: git2::Error) -> GitError {
        let mut stderr = e.message().to_string();
        if e.code() == ErrorCode::Locked && !stderr.contains("index.lock") {
            stderr = format!("{stderr}: index.lock");
        }
        GitError {
            args: action.to_string(),
            stderr,
        }
    }
}

/// One line of `git status --porcelain=v1`: the path, the index and work tree codes, and the
/// source of a rename.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub path: String,
    pub index: char,
    pub worktree: char,
    pub from: Option<String>,
}

/// One commit of `Repo::log_messages`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    /// The abbreviated id, as `%h` prints it.
    pub short: String,
    /// The whole message, as `%B` prints it.
    pub message: String,
}

/// A repository opened for reading.
pub struct Repo {
    inner: git2::Repository,
}

fn utf8(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

impl Repo {
    pub fn open(path: &Path) -> Result<Repo, GitError> {
        git2::Repository::open(path)
            .map(|inner| Repo { inner })
            .map_err(|e| GitError::from_git2("rev-parse --git-dir", e))
    }

    fn head_tree(&self) -> Result<Tree<'_>, GitError> {
        self.inner
            .head()
            .and_then(|h| h.peel_to_tree())
            .map_err(|e| GitError::from_git2("rev-parse --verify HEAD", e))
    }

    /// The id of the commit `HEAD` points at.
    pub fn head_sha(&self) -> Result<String, GitError> {
        self.inner
            .head()
            .and_then(|h| h.peel_to_commit())
            .map(|c| c.id().to_string())
            .map_err(|e| GitError::from_git2("rev-parse HEAD", e))
    }

    /// The blob at `HEAD:<rel>` byte for byte; `None` when `HEAD` holds no file there.
    pub fn committed_bytes(&self, rel: &str) -> Result<Option<Vec<u8>>, GitError> {
        let fail = |e| GitError::from_git2(&format!("show HEAD:{rel}"), e);
        let tree = self.head_tree()?;
        let entry = match tree.get_path(Path::new(rel)) {
            Ok(entry) => entry,
            Err(e) if e.code() == ErrorCode::NotFound => return Ok(None),
            Err(e) => return Err(fail(e)),
        };
        if entry.kind() != Some(ObjectType::Blob) {
            return Ok(None);
        }
        let blob = self.inner.find_blob(entry.id()).map_err(fail)?;
        Ok(Some(blob.content().to_vec()))
    }

    /// What `git ls-tree -z --name-only HEAD -- <dir>` lists: for a `dir` ending in `/`, the paths
    /// directly under it; otherwise the path itself when `HEAD` holds it.
    pub fn tree_names(&self, dir: &str) -> Result<Vec<String>, GitError> {
        let fail = |e| GitError::from_git2(&format!("ls-tree -z --name-only HEAD -- {dir}"), e);
        let root = self.head_tree()?;
        let Some(prefix) = dir.strip_suffix('/') else {
            return Ok(match root.get_path(Path::new(dir)) {
                Ok(_) => vec![dir.to_string()],
                Err(_) => Vec::new(),
            });
        };
        let tree = if prefix.is_empty() {
            root
        } else {
            let entry = match root.get_path(Path::new(prefix)) {
                Ok(entry) if entry.kind() == Some(ObjectType::Tree) => entry,
                Ok(_) => return Ok(Vec::new()),
                Err(e) if e.code() == ErrorCode::NotFound => return Ok(Vec::new()),
                Err(e) => return Err(fail(e)),
            };
            self.inner.find_tree(entry.id()).map_err(fail)?
        };
        Ok(tree
            .iter()
            .map(|e| String::from_utf8_lossy(e.name_bytes()).into_owned())
            .map(|name| {
                if prefix.is_empty() {
                    name
                } else {
                    format!("{prefix}/{name}")
                }
            })
            .collect())
    }

    /// "Committed": in the index and unchanged in both the index and the working tree. The answer of
    /// `ls-files --error-unmatch -- <rel>` together with an empty `status --porcelain -- <rel>`.
    pub fn is_committed(&self, rel: &str) -> bool {
        let Ok(index) = self.inner.index() else {
            return false;
        };
        let under = format!("{}/", rel.trim_end_matches('/'));
        let tracked = index.get_path(Path::new(rel), 0).is_some()
            || index
                .iter()
                .any(|e| String::from_utf8_lossy(&e.path).starts_with(&under));
        tracked && self.status(rel).is_ok_and(|entries| entries.is_empty())
    }

    /// What `git status --porcelain=v1 -uall -- <under>` lists (all of it for an empty `under`):
    /// changes first, then untracked files, each in path order. Reads only: the index is not
    /// refreshed on disk.
    pub fn status(&self, under: &str) -> Result<Vec<StatusEntry>, GitError> {
        let fail = |e| GitError::from_git2(&format!("status --porcelain=v1 -uall -- {under}"), e);
        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(false)
            .renames_head_to_index(true)
            .renames_index_to_workdir(false);
        if !under.is_empty() {
            opts.pathspec(under);
        }
        let list = self.inner.statuses(Some(&mut opts)).map_err(fail)?;
        let mut tracked = Vec::new();
        let mut untracked = Vec::new();
        for entry in list.iter() {
            let flags = entry.status();
            if flags.is_empty() || flags.is_ignored() {
                continue;
            }
            if flags.is_wt_new() && !flags.is_index_new() {
                {
                    untracked.push(StatusEntry {
                        path: String::from_utf8_lossy(entry.path_bytes()).into_owned(),
                        index: '?',
                        worktree: '?',
                        from: None,
                    });
                }
                continue;
            }
            let (index, worktree) = if flags.is_conflicted() {
                ('U', 'U')
            } else {
                (index_code(flags), worktree_code(flags))
            };
            let renamed = entry
                .head_to_index()
                .filter(|d| d.status() == git2::Delta::Renamed);
            let (path, from) = match renamed {
                Some(d) => (d.new_file().path().map(utf8), d.old_file().path().map(utf8)),
                None => (
                    Some(String::from_utf8_lossy(entry.path_bytes()).into_owned()),
                    None,
                ),
            };
            if let Some(path) = path {
                tracked.push(StatusEntry {
                    path,
                    index,
                    worktree,
                    from,
                });
            }
        }
        tracked.sort_by(|a, b| a.path.cmp(&b.path));
        untracked.sort_by(|a, b| a.path.cmp(&b.path));
        tracked.extend(untracked);
        Ok(tracked)
    }

    /// The id (a blob or a tree) of `<rev>:<rel>`; `None` when `rev` holds nothing there.
    pub fn blob_id_at(&self, rev: &str, rel: &str) -> Result<Option<String>, GitError> {
        Ok(self.entry_at(rev, rel)?.map(|(id, _)| id.to_string()))
    }

    /// The id and file mode of `<rev>:<rel>`.
    pub(crate) fn entry_at(&self, rev: &str, rel: &str) -> Result<Option<(Oid, i32)>, GitError> {
        let fail = |e| GitError::from_git2(&format!("rev-parse {rev}:{rel}"), e);
        let tree = self
            .inner
            .revparse_single(rev)
            .and_then(|o| o.peel_to_tree())
            .map_err(fail)?;
        match tree.get_path(Path::new(rel)) {
            Ok(entry) => Ok(Some((entry.id(), entry.filemode()))),
            Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
            Err(e) => Err(fail(e)),
        }
    }

    /// Whether `rev` names a commit.
    pub(crate) fn resolves_to_commit(&self, rev: &str) -> bool {
        self.inner
            .revparse_single(rev)
            .and_then(|o| o.peel_to_commit())
            .is_ok()
    }

    /// The commits reachable from `HEAD` but not from `rev` that change `pathspec`, newest first,
    /// with git's default history simplification.
    pub fn commits_since(&self, rev: &str, pathspec: &str) -> Result<Vec<String>, GitError> {
        self.simplified_since(rev, &[pathspec], &[])
            .map(|ids| ids.iter().map(Oid::to_string).collect())
    }

    /// How many commits `rev-list --count <rev>..HEAD -- <include> <:(exclude) each of exclude>` counts.
    pub fn count_since(
        &self,
        rev: &str,
        include: &[&str],
        exclude: &[&str],
    ) -> Result<u32, GitError> {
        self.simplified_since(rev, include, exclude)
            .map(|ids| ids.len() as u32)
    }

    fn simplified_since(
        &self,
        rev: &str,
        include: &[&str],
        exclude: &[&str],
    ) -> Result<Vec<Oid>, GitError> {
        let fail = |e| GitError::from_git2(&format!("rev-list {rev}..HEAD"), e);
        let tip = self
            .inner
            .revparse_single(rev)
            .and_then(|o| o.peel_to_commit())
            .map_err(fail)?
            .id();
        let head = self
            .inner
            .head()
            .and_then(|h| h.peel_to_commit())
            .map_err(fail)?
            .id();

        let keep = |path: &str| {
            let under = |p: &&str| {
                *p == "." || *p == path || path.strip_prefix(*p).is_some_and(|r| r.starts_with('/'))
            };
            (include.is_empty() || include.iter().any(under)) && !exclude.iter().any(under)
        };
        let changes = |old: Option<Oid>, new: Oid| -> Result<bool, GitError> {
            let old = old
                .map(|id| self.inner.find_tree(id))
                .transpose()
                .map_err(fail)?;
            let new = self.inner.find_tree(new).map_err(fail)?;
            let diff = self
                .inner
                .diff_tree_to_tree(old.as_ref(), Some(&new), None)
                .map_err(fail)?;
            Ok(diff.deltas().any(|d| {
                [d.old_file().path(), d.new_file().path()]
                    .into_iter()
                    .flatten()
                    .any(|p| keep(&utf8(p)))
            }))
        };
        let mut meta: HashMap<Oid, (i64, Vec<Oid>, Oid)> = HashMap::new();
        let mut load = |id: Oid| -> Result<(i64, Vec<Oid>, Oid), GitError> {
            if let Some(found) = meta.get(&id) {
                return Ok(found.clone());
            }
            let c = self.inner.find_commit(id).map_err(fail)?;
            let found = (
                c.time().seconds(),
                c.parent_ids().collect::<Vec<_>>(),
                c.tree_id(),
            );
            meta.insert(id, found.clone());
            Ok(found)
        };

        // This follows git's own walk for a range with paths (`limit_list` and
        // `try_to_simplify_commit`), including the order commits come off the queue: which parents
        // count as outside the range when a commit is looked at depends on how far the hiding of
        // the range's ancestors has spread by then.
        let mut queue: Vec<(i64, Oid)> = Vec::new();
        let mut hidden: HashSet<Oid> = HashSet::new();
        let mut seen: HashSet<Oid> = HashSet::new();
        let mut parsed: HashSet<Oid> = HashSet::new();
        let insert = |queue: &mut Vec<(i64, Oid)>, time: i64, id: Oid| {
            let at = queue
                .iter()
                .position(|(t, _)| *t < time)
                .unwrap_or(queue.len());
            queue.insert(at, (time, id));
        };
        // `mark_parents_uninteresting`: hide the parents, and go on through those already parsed.
        fn hide_parents(
            of: Oid,
            hidden: &mut HashSet<Oid>,
            parsed: &HashSet<Oid>,
            load: &mut dyn FnMut(Oid) -> Result<(i64, Vec<Oid>, Oid), GitError>,
        ) -> Result<(), GitError> {
            let mut todo: Vec<Oid> = load(of)?.1;
            while let Some(mut id) = todo.pop() {
                loop {
                    if hidden.contains(&id) {
                        break;
                    }
                    hidden.insert(id);
                    if !parsed.contains(&id) {
                        break;
                    }
                    let parents = load(id)?.1;
                    let Some((first, rest)) = parents.split_first() else {
                        break;
                    };
                    todo.extend(rest.iter().copied());
                    id = *first;
                }
            }
            Ok(())
        }

        for id in [head, tip] {
            parsed.insert(id);
            seen.insert(id);
            let time = load(id)?.0;
            insert(&mut queue, time, id);
        }
        hidden.insert(tip);
        hide_parents(tip, &mut hidden, &parsed, &mut load)?;

        let mut date = i64::MAX;
        let mut slop = 5;
        let mut listed: Vec<Oid> = Vec::new();
        let mut treesame: HashSet<Oid> = HashSet::new();
        while !queue.is_empty() {
            let (_, id) = queue.remove(0);
            let (time, parents, tree) = load(id)?;
            if hidden.contains(&id) {
                for p in &parents {
                    hidden.insert(*p);
                    parsed.insert(*p);
                    if !load(*p)?.1.is_empty() {
                        hide_parents(*p, &mut hidden, &parsed, &mut load)?;
                    }
                    if seen.insert(*p) {
                        let t = load(*p)?.0;
                        insert(&mut queue, t, *p);
                    }
                }
                hide_parents(id, &mut hidden, &parsed, &mut load)?;
                slop = match queue.first() {
                    None => 0,
                    Some((t, _)) if date <= *t => 5,
                    Some(_) if queue.iter().any(|(_, q)| !hidden.contains(q)) => 5,
                    Some(_) => slop - 1,
                };
                if slop > 0 {
                    continue;
                }
                break;
            }
            // `try_to_simplify_commit`
            let mut follow = parents.clone();
            let same;
            if parents.is_empty() {
                same = !changes(None, tree)?;
            } else {
                let mut relevant_parents = 0;
                let mut relevant_change = false;
                let mut irrelevant_change = false;
                let mut early = None;
                for p in &parents {
                    // The commit named by `rev` counts as inside the range here, as git decides it:
                    // pinned by the parity runs against merges whose tree equals a parent's.
                    let relevant = !hidden.contains(p) || *p == tip;
                    if relevant {
                        relevant_parents += 1;
                    }
                    let differs = changes(Some(load(*p)?.2), tree)?;
                    if !differs {
                        if relevant {
                            early = Some(*p);
                            break;
                        }
                    } else if relevant {
                        relevant_change = true;
                    } else {
                        irrelevant_change = true;
                    }
                }
                match early {
                    Some(p) => {
                        follow = vec![p];
                        same = true;
                    }
                    None => {
                        same = !(if relevant_parents > 0 {
                            relevant_change
                        } else {
                            irrelevant_change
                        });
                    }
                }
            }
            for p in follow {
                parsed.insert(p);
                if seen.insert(p) {
                    let t = load(p)?.0;
                    insert(&mut queue, t, p);
                }
            }
            date = time;
            listed.push(id);
            if same {
                treesame.insert(id);
            }
        }
        Ok(listed
            .into_iter()
            .filter(|id| !hidden.contains(id) && !treesame.contains(id))
            .collect())
    }

    /// What `git symbolic-ref --quiet <name>` prints; `None` when `name` is not a symbolic ref.
    #[allow(unused_variables)]
    pub fn symbolic_target(&self, name: &str) -> Option<String> {
        unimplemented!("symbolic_target")
    }

    /// Whether `git rev-parse --verify --quiet <rev>` succeeds.
    #[allow(unused_variables)]
    pub fn rev_exists(&self, rev: &str) -> bool {
        unimplemented!("rev_exists")
    }

    /// What `git rev-parse <rev>` prints.
    #[allow(unused_variables)]
    pub fn resolve(&self, rev: &str) -> Result<String, GitError> {
        unimplemented!("resolve")
    }

    /// What `git merge-base <a> <b>` prints.
    #[allow(unused_variables)]
    pub fn merge_base(&self, a: &str, b: &str) -> Result<String, GitError> {
        unimplemented!("merge_base")
    }

    /// What `git rev-list <base>..<head>` prints, newest first as git prints it.
    #[allow(unused_variables)]
    pub fn revs_between(&self, base: &str, head: &str) -> Result<Vec<String>, GitError> {
        unimplemented!("revs_between")
    }

    /// What `git rev-list <revs>` prints for revision arguments such as `tip`, `^x` and `a..b`.
    #[allow(unused_variables)]
    pub fn rev_list(&self, revs: &[String]) -> Result<Vec<String>, GitError> {
        unimplemented!("rev_list")
    }

    /// What `git log --format=%h%x1f%B <revs>` prints, one entry per commit, newest first.
    #[allow(unused_variables)]
    pub fn log_messages(&self, revs: &[String]) -> Result<Vec<LogEntry>, GitError> {
        unimplemented!("log_messages")
    }

    /// What `git remote get-url <name>` prints; `None` when the remote does not exist.
    #[allow(unused_variables)]
    pub fn remote_url(&self, name: &str) -> Option<String> {
        unimplemented!("remote_url")
    }

    /// What `git hash-object -- <rel>` prints: the blob id of the working tree file after the
    /// clean filters.
    #[allow(unused_variables)]
    pub fn hash_file(&self, rel: &str) -> Result<String, GitError> {
        unimplemented!("hash_file")
    }

    /// The commits of `git log --reverse --no-renames --name-only <revs>`, oldest first, each with
    /// its sorted file list. A merge lists no files.
    #[allow(unused_variables)]
    pub fn commit_files(&self, revs: &[String]) -> Result<Vec<(String, Vec<String>)>, GitError> {
        unimplemented!("commit_files")
    }

    /// The blob at `<rev>:<rel>` byte for byte; `None` when `rev` holds no file there.
    #[allow(unused_variables)]
    pub fn bytes_at(&self, rev: &str, rel: &str) -> Result<Option<Vec<u8>>, GitError> {
        unimplemented!("bytes_at")
    }

    /// The checked-out branch; `None` on a detached or unborn `HEAD`.
    pub(crate) fn current_branch(&self) -> Option<String> {
        self.inner.head().ok()?.peel_to_commit().ok()?;
        let head = self.inner.find_reference("HEAD").ok()?;
        let name = String::from_utf8_lossy(head.symbolic_target_bytes()?).into_owned();
        name.strip_prefix("refs/heads/")
            .filter(|b| !b.is_empty())
            .map(str::to_string)
    }

    /// Whether the local branch `name` exists.
    pub(crate) fn branch_exists(&self, name: &str) -> bool {
        self.inner
            .refname_to_id(&format!("refs/heads/{name}"))
            .is_ok()
    }

    /// The local branches, sorted.
    pub(crate) fn local_branches(&self) -> Vec<String> {
        let Ok(branches) = self.inner.branches(Some(git2::BranchType::Local)) else {
            return Vec::new();
        };
        let mut names: Vec<String> = branches
            .flatten()
            .filter_map(|(b, _)| b.name().ok().flatten().map(str::to_string))
            .collect();
        names.sort();
        names
    }

    /// The files the commits in `since..HEAD` changed, without renames, merges left out as
    /// `git log --name-only` leaves them out.
    pub(crate) fn files_changed_since(&self, since: &str) -> Result<Vec<String>, GitError> {
        let fail = |e| GitError::from_git2(&format!("log --name-only {since}..HEAD"), e);
        let hidden = self
            .inner
            .revparse_single(since)
            .and_then(|o| o.peel_to_commit())
            .map_err(fail)?;
        let mut walk = self.inner.revwalk().map_err(fail)?;
        walk.push_head().map_err(fail)?;
        walk.hide(hidden.id()).map_err(fail)?;
        let mut files = Vec::new();
        for id in walk {
            let commit = self.inner.find_commit(id.map_err(fail)?).map_err(fail)?;
            if commit.parent_count() > 1 {
                continue;
            }
            let parent = commit.parents().next().map(|p| p.tree()).transpose();
            let diff = self
                .inner
                .diff_tree_to_tree(
                    parent.map_err(fail)?.as_ref(),
                    Some(&commit.tree().map_err(fail)?),
                    None,
                )
                .map_err(fail)?;
            for delta in diff.deltas() {
                if let Some(path) = delta.new_file().path().or(delta.old_file().path()) {
                    files.push(utf8(path));
                }
            }
        }
        Ok(files)
    }
}

fn index_code(flags: git2::Status) -> char {
    if flags.is_index_new() {
        'A'
    } else if flags.is_index_modified() {
        'M'
    } else if flags.is_index_deleted() {
        'D'
    } else if flags.is_index_renamed() {
        'R'
    } else if flags.is_index_typechange() {
        'T'
    } else {
        ' '
    }
}

fn worktree_code(flags: git2::Status) -> char {
    if flags.is_wt_modified() {
        'M'
    } else if flags.is_wt_deleted() {
        'D'
    } else if flags.is_wt_renamed() {
        'R'
    } else if flags.is_wt_typechange() {
        'T'
    } else {
        ' '
    }
}

/// The text of git's output the way `git::run` returned it: lossy UTF-8 without one trailing
/// newline (and the carriage return before it).
pub(crate) fn trimmed_text(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.strip_suffix('\n').unwrap_or(&text);
    text.strip_suffix('\r').unwrap_or(text).to_string()
}

/// The git command line, kept for the writes that have not moved to libgit2 yet and for the
/// comparisons that still run it. Nothing new is added here.
pub(crate) mod legacy_cli {
    use super::GitError;
    use std::ffi::OsStr;
    use std::path::Path;

    fn exec(dir: &Path, args: &[&str], env: &[(&str, &OsStr)]) -> Result<Vec<u8>, GitError> {
        let fail = |stderr: String| GitError {
            args: args.join(" "),
            stderr,
        };
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(dir).args(args);
        for (key, value) in env {
            cmd.env(key, value);
        }
        let out = cmd.output().map_err(|e| fail(e.to_string()))?;
        if !out.status.success() {
            return Err(fail(
                String::from_utf8_lossy(&out.stderr).trim().to_string(),
            ));
        }
        Ok(out.stdout)
    }

    /// Run `git -C <dir> <args>` and return stdout without its trailing newline.
    pub fn run(dir: &Path, args: &[&str]) -> Result<String, GitError> {
        exec(dir, args, &[]).map(|out| super::trimmed_text(&out))
    }

    /// Run `git -C <dir> <args>` and return stdout untouched, byte for byte.
    pub fn run_bytes(dir: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
        exec(dir, args, &[])
    }

    /// Like `run_bytes`, with extra environment variables for the child, such as `GIT_INDEX_FILE`.
    pub fn run_env(dir: &Path, args: &[&str], env: &[(&str, &OsStr)]) -> Result<Vec<u8>, GitError> {
        exec(dir, args, env)
    }
}

/// Test fixtures build repositories with the command line.
#[cfg(test)]
pub use legacy_cli::{run, run_bytes, run_env};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_reports_stderr() {
        let tmp = tempfile::tempdir().unwrap();
        let err = run(tmp.path(), &["rev-parse", "HEAD"]).unwrap_err();
        assert!(
            err.to_string().starts_with("git rev-parse HEAD:"),
            "got: {err}"
        );
    }

    #[test]
    fn a_lock_error_names_index_lock() {
        let e = git2::Error::new(
            ErrorCode::Locked,
            git2::ErrorClass::Index,
            "failed to lock file",
        );
        assert!(GitError::from_git2("commit", e)
            .stderr
            .contains("index.lock"));
    }
}
