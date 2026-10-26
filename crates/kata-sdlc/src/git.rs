//! Repository reads, done with libgit2 so that reading works on a machine without git installed.
//! A failed operation is a `GitError`: `args` names the git command the operation replaces and
//! `stderr` carries libgit2's message.
use git2::{ErrorCode, Index, ObjectType, Oid, StatusOptions, Tree};
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

impl LogEntry {
    /// What `%s` prints: the first paragraph of the message on one line.
    pub fn subject(&self) -> String {
        self.message
            .lines()
            .map(str::trim_end)
            .take_while(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// What `Repo::commit_only` made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitOutcome {
    /// The id of the new commit.
    pub sha: String,
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

    /// What `git add -- <rel>` followed by `git commit -m <message> --only -- <rel>` does, with the
    /// repository's commit hooks: commits the working file `rel` (or its removal) on top of `HEAD`
    /// and leaves every other staged entry alone.
    ///
    /// Nothing is written when the repository needs a program Kata cannot start, when a hook
    /// refuses, or when the real index is locked; the hook's output is the error. A failing
    /// `post-commit` hook is ignored, as git ignores it.
    pub fn commit_only(&self, rel: &str, message: &str) -> Result<CommitOutcome, GitError> {
        use kata_core::hooks::{needs_external, run_hook, Hook};
        const ACTION: &str = "commit --only";
        let repo = &self.inner;
        let fail = |stderr: String| GitError {
            args: ACTION.to_string(),
            stderr,
        };
        let git_fail = |e: git2::Error| GitError::from_git2(ACTION, e);

        if let Some(reason) = needs_external(repo, &[rel]) {
            return Err(fail(reason));
        }
        // Held from here to the end, as git holds it, so two writers take turns.
        let lock = IndexLock::acquire(&repo.path().join("index")).map_err(fail)?;
        let workdir = repo
            .workdir()
            .ok_or_else(|| fail("this repository has no working folder".to_string()))?;
        let head = repo.head().map_err(git_fail)?;
        let head_name = head.name().unwrap_or("HEAD").to_string();
        let parent = head.peel_to_commit().map_err(git_fail)?;
        let head_tree = parent.tree().map_err(git_fail)?;
        let in_head = match head_tree.get_path(Path::new(rel)) {
            Ok(entry) => Some(entry.filemode() as u32),
            Err(e) if e.code() == ErrorCode::NotFound => None,
            Err(e) => return Err(git_fail(e)),
        };

        // The entry the commit holds for `rel`: the working file after the clean filters, or none
        // when the file is gone.
        let file = workdir.join(rel);
        let new_entry = if file.is_file() {
            let blob = hash_into_odb(repo, rel).map_err(git_fail)?;
            Some((blob, in_head.unwrap_or_else(|| new_file_mode(&file))))
        } else if in_head.is_some() {
            None
        } else {
            return Err(fail(format!(
                "pathspec '{rel}' did not match any file(s) known to git"
            )));
        };

        // The index the hooks see and the commit is made from: `HEAD`'s tree with only `rel` replaced.
        let temp_path = repo
            .path()
            .join(format!("kata-next-index-{}", std::process::id()));
        let temp = TempIndex(temp_path);
        let mut next = Index::open(&temp.0).map_err(git_fail)?;
        next.read_tree(&head_tree).map_err(git_fail)?;
        set_entry(&mut next, rel, new_entry).map_err(git_fail)?;
        next.write().map_err(git_fail)?;
        let tree_id = next.write_tree_to(repo).map_err(git_fail)?;
        let env = [("GIT_INDEX_FILE", temp.0.as_os_str())];

        let hook_fail = |f: kata_core::hooks::HookFailure| fail(f.message);
        run_hook(repo, Hook::PreCommit, &[], None, &env).map_err(hook_fail)?;
        let message_file = repo.path().join("COMMIT_EDITMSG");
        let mut text = message.to_string();
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        std::fs::write(&message_file, text).map_err(|e| fail(e.to_string()))?;
        let arg = message_file.to_string_lossy().replace('\\', "/");
        run_hook(repo, Hook::PrepareCommitMsg, &[&arg, "message"], None, &env)
            .map_err(hook_fail)?;
        run_hook(repo, Hook::CommitMsg, &[&arg], None, &env).map_err(hook_fail)?;
        let edited = std::fs::read(&message_file).map_err(|e| fail(e.to_string()))?;
        let message = stripspace(&String::from_utf8_lossy(&edited));
        if message.is_empty() {
            return Err(fail(
                "Aborting commit due to empty commit message.".to_string(),
            ));
        }

        let signature = repo.signature().map_err(|_| fail(unknown_identity()))?;
        let tree = repo.find_tree(tree_id).map_err(git_fail)?;
        let commit_id = repo
            .commit(None, &signature, &signature, &message, &tree, &[&parent])
            .map_err(git_fail)?;

        // The new real index is written into the lock file first, then the branch moves, and only
        // then does the index replace the old one: a failure before that leaves both as they were.
        let mut real = Index::open(lock.path()).map_err(git_fail)?;
        set_entry(&mut real, rel, new_entry).map_err(git_fail)?;
        real.write().map_err(git_fail)?;
        let subject = message.lines().next().unwrap_or("");
        repo.reference_matching(
            &head_name,
            commit_id,
            true,
            parent.id(),
            &format!("commit: {subject}"),
        )
        .map_err(git_fail)?;
        lock.commit(&repo.path().join("index")).map_err(fail)?;

        // Git ignores a failing post-commit hook.
        let _ = run_hook(repo, Hook::PostCommit, &[], None, &[]);
        Ok(CommitOutcome {
            sha: commit_id.to_string(),
        })
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
    pub fn symbolic_target(&self, name: &str) -> Option<String> {
        self.inner
            .find_reference(name)
            .ok()?
            .symbolic_target_bytes()
            .map(|b| String::from_utf8_lossy(b).into_owned())
    }

    /// Whether `git rev-parse --verify --quiet <rev>` succeeds.
    pub fn rev_exists(&self, rev: &str) -> bool {
        self.inner.revparse_single(rev).is_ok()
    }

    /// What `git rev-parse <rev>` prints.
    pub fn resolve(&self, rev: &str) -> Result<String, GitError> {
        self.inner
            .revparse_single(rev)
            .map(|o| o.id().to_string())
            .map_err(|e| GitError::from_git2(&format!("rev-parse {rev}"), e))
    }

    fn commit_id(&self, rev: &str) -> Result<Oid, git2::Error> {
        self.inner
            .revparse_single(rev)
            .and_then(|o| o.peel_to_commit())
            .map(|c| c.id())
    }

    /// What `git merge-base <a> <b>` prints.
    pub fn merge_base(&self, a: &str, b: &str) -> Result<String, GitError> {
        let fail = |e| GitError::from_git2(&format!("merge-base {a} {b}"), e);
        let (x, y) = (
            self.commit_id(a).map_err(fail)?,
            self.commit_id(b).map_err(fail)?,
        );
        self.inner
            .merge_base(x, y)
            .map(|id| id.to_string())
            .map_err(fail)
    }

    /// What `git rev-list <base>..<head>` prints, newest first as git prints it.
    pub fn revs_between(&self, base: &str, head: &str) -> Result<Vec<String>, GitError> {
        self.rev_list(&[format!("{base}..{head}")])
    }

    /// The commits `git rev-list <revs>` lists, newest first, for revision arguments such as
    /// `tip`, `^x` and `a..b`.
    fn walk(&self, revs: &[String]) -> Result<Vec<Oid>, GitError> {
        let action = format!("rev-list {}", revs.join(" "));
        let fail = |e| GitError::from_git2(&action, e);
        let mut walk = self.inner.revwalk().map_err(fail)?;
        let mut tips: Vec<Oid> = Vec::new();
        for rev in revs {
            if let Some(hidden) = rev.strip_prefix('^') {
                walk.hide(self.commit_id(hidden).map_err(fail)?)
                    .map_err(fail)?;
            } else if let Some((from, to)) = rev.split_once("..") {
                let or_head = |r: &str| {
                    if r.is_empty() {
                        "HEAD".to_string()
                    } else {
                        r.to_string()
                    }
                };
                walk.hide(self.commit_id(&or_head(from)).map_err(fail)?)
                    .map_err(fail)?;
                let tip = self.commit_id(&or_head(to)).map_err(fail)?;
                tips.push(tip);
                walk.push(tip).map_err(fail)?;
            } else {
                let tip = self.commit_id(rev).map_err(fail)?;
                tips.push(tip);
                walk.push(tip).map_err(fail)?;
            }
        }
        let listed: HashSet<Oid> = walk.collect::<Result<_, _>>().map_err(fail)?;

        // The order git prints them in: the newest commit date first, taken from a queue that
        // starts at the tips and adds each parent as its child is printed; equal dates come out in
        // the order they went in.
        let mut queue: std::collections::BinaryHeap<(i64, std::cmp::Reverse<usize>, Oid)> =
            std::collections::BinaryHeap::new();
        let mut queued: HashSet<Oid> = HashSet::new();
        let mut counter = 0;
        let mut ordered = Vec::with_capacity(listed.len());
        let mut push =
            |queue: &mut std::collections::BinaryHeap<_>, id: Oid| -> Result<(), git2::Error> {
                if listed.contains(&id) && queued.insert(id) {
                    let time = self.inner.find_commit(id)?.time().seconds();
                    queue.push((time, std::cmp::Reverse(counter), id));
                    counter += 1;
                }
                Ok(())
            };
        for tip in tips {
            push(&mut queue, tip).map_err(fail)?;
        }
        while let Some((_, _, id)) = queue.pop() {
            ordered.push(id);
            for parent in self.inner.find_commit(id).map_err(fail)?.parent_ids() {
                push(&mut queue, parent).map_err(fail)?;
            }
        }
        Ok(ordered)
    }

    /// What `git rev-list <revs>` prints for revision arguments such as `tip`, `^x` and `a..b`.
    pub fn rev_list(&self, revs: &[String]) -> Result<Vec<String>, GitError> {
        Ok(self.walk(revs)?.iter().map(Oid::to_string).collect())
    }

    /// What `git log --format=%h%x1f%B <revs>` prints, one entry per commit, newest first.
    pub fn log_messages(&self, revs: &[String]) -> Result<Vec<LogEntry>, GitError> {
        let fail = |e| GitError::from_git2(&format!("log {}", revs.join(" ")), e);
        self.walk(revs)?
            .into_iter()
            .map(|id| {
                let commit = self.inner.find_commit(id)?;
                let short = commit.as_object().short_id()?;
                Ok(LogEntry {
                    short: short.as_str().unwrap_or_default().to_string(),
                    message: String::from_utf8_lossy(commit.message_bytes()).into_owned(),
                })
            })
            .collect::<Result<Vec<_>, git2::Error>>()
            .map_err(fail)
    }

    /// What `git remote get-url <name>` prints (the url with the `url.<base>.insteadOf` rewrites
    /// applied); `None` when the remote does not exist.
    pub fn remote_url(&self, name: &str) -> Option<String> {
        let remote = self.inner.find_remote(name).ok()?;
        let url = remote.url().ok()?.to_string();
        let config = self.inner.config().ok()?;
        let mut best: Option<(usize, String)> = None;
        let mut entries = config.entries(Some(r"^url\..*\.insteadof$")).ok()?;
        while let Some(Ok(entry)) = entries.next() {
            let (Some(key), Some(prefix)) = (entry.name().ok(), entry.value().ok()) else {
                continue;
            };
            let Some(base) = key
                .strip_prefix("url.")
                .and_then(|k| k.strip_suffix(".insteadof"))
            else {
                continue;
            };
            if !prefix.is_empty()
                && url.starts_with(prefix)
                && best.as_ref().is_none_or(|(len, _)| prefix.len() > *len)
            {
                best = Some((prefix.len(), format!("{base}{}", &url[prefix.len()..])));
            }
        }
        Some(best.map_or(url, |(_, rewritten)| rewritten))
    }

    /// What `git hash-object -- <rel>` prints: the blob id of the working tree file after the
    /// clean filters, written nowhere.
    pub fn hash_file(&self, rel: &str) -> Result<String, GitError> {
        extern "C" {
            fn git_repository_hashfile(
                out: *mut libgit2_sys::git_oid,
                repo: *mut libgit2_sys::git_repository,
                path: *const std::ffi::c_char,
                otype: libgit2_sys::git_object_t,
                as_path: *const std::ffi::c_char,
            ) -> std::ffi::c_int;
        }
        use git2::Binding;
        let action = format!("hash-object -- {rel}");
        let path = std::ffi::CString::new(rel).map_err(|_| GitError {
            args: action.clone(),
            stderr: "path contains a NUL byte".to_string(),
        })?;
        let mut oid: libgit2_sys::git_oid = unsafe { std::mem::zeroed() };
        // SAFETY: the repository pointer lives as long as `self`, the path is a NUL-terminated
        // string that outlives the call, and `oid` is a valid output location.
        let code = unsafe {
            git_repository_hashfile(
                &mut oid,
                self.inner.raw(),
                path.as_ptr(),
                libgit2_sys::GIT_OBJECT_BLOB,
                path.as_ptr(),
            )
        };
        if code < 0 {
            return Err(GitError::from_git2(&action, git2::Error::last_error(code)));
        }
        Oid::from_bytes(&oid.id)
            .map(|id| id.to_string())
            .map_err(|e| GitError::from_git2(&action, e))
    }

    /// The commits of `git log --reverse --no-renames --name-only <revs>`, oldest first, each with
    /// its sorted file list. A merge lists no files.
    pub fn commit_files(&self, revs: &[String]) -> Result<Vec<(String, Vec<String>)>, GitError> {
        let fail = |e| GitError::from_git2(&format!("log --name-only {}", revs.join(" ")), e);
        let mut ids = self.walk(revs)?;
        ids.reverse();
        let mut out = Vec::new();
        for id in ids {
            let commit = self.inner.find_commit(id).map_err(fail)?;
            let mut files = Vec::new();
            if commit.parent_count() <= 1 {
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
                    let file = delta
                        .new_file()
                        .path_bytes()
                        .or(delta.old_file().path_bytes());
                    if let Some(path) = file {
                        files.push(String::from_utf8_lossy(path).into_owned());
                    }
                }
            }
            files.sort();
            files.dedup();
            out.push((id.to_string(), files));
        }
        Ok(out)
    }

    /// The blob at `<rev>:<rel>` byte for byte; `None` when `rev` holds no file there.
    pub fn bytes_at(&self, rev: &str, rel: &str) -> Result<Option<Vec<u8>>, GitError> {
        let fail = |e| GitError::from_git2(&format!("show {rev}:{rel}"), e);
        let tree = self
            .inner
            .revparse_single(rev)
            .and_then(|o| o.peel_to_tree())
            .map_err(fail)?;
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

    /// What `git checkout -q <name> --` does: switches to the local branch `name`, refusing to
    /// overwrite a local edit, and runs the repository's `post-checkout` hook afterward.
    pub fn checkout_branch(&self, _name: &str) -> Result<(), GitError> {
        todo!("checkout_branch")
    }

    /// What `git checkout -q -b <name> <at>` does.
    pub fn create_branch(&self, _name: &str, _at: &str) -> Result<(), GitError> {
        todo!("create_branch")
    }

    /// What `git branch -m <old> <new>` does.
    pub fn rename_branch(&self, _old: &str, _new: &str) -> Result<(), GitError> {
        todo!("rename_branch")
    }

    /// What `git branch -D <name>` does.
    pub fn delete_branch(&self, _name: &str) -> Result<(), GitError> {
        todo!("delete_branch")
    }

    /// What `git restore --staged --worktree -- <paths>` does.
    pub fn restore_paths(&self, _paths: &[&str]) -> Result<(), GitError> {
        todo!("restore_paths")
    }

    /// What `git rm -f -q -- <paths>` does.
    pub fn remove_paths(&self, _paths: &[&str]) -> Result<(), GitError> {
        todo!("remove_paths")
    }

    /// The repository for code that reads it through libgit2 directly.
    pub(crate) fn raw(&self) -> &git2::Repository {
        &self.inner
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

/// The `index.lock` file git takes before it changes the index. It starts as a copy of the index, is
/// removed when dropped, and `commit` makes it the index.
struct IndexLock {
    path: std::path::PathBuf,
    live: bool,
}

impl IndexLock {
    fn acquire(index: &Path) -> Result<IndexLock, String> {
        use std::io::Write;
        let mut name = index.as_os_str().to_owned();
        name.push(".lock");
        let path = std::path::PathBuf::from(name);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    format!(
                        "Unable to create '{}': File exists.

Another git process seems to be running in this repository. Make sure all processes are terminated then try again. If it still fails, a git process may have crashed in this repository earlier: remove the file manually to continue.",
                        path.display()
                    )
                } else {
                    format!("Unable to create '{}': {e}", path.display())
                }
            })?;
        let lock = IndexLock { path, live: true };
        let current = std::fs::read(index).unwrap_or_default();
        file.write_all(&current).map_err(|e| e.to_string())?;
        Ok(lock)
    }

    fn path(&self) -> &Path {
        &self.path
    }

    /// Makes the lock file the index.
    fn commit(mut self, index: &Path) -> Result<(), String> {
        std::fs::rename(&self.path, index)
            .map_err(|e| format!("the commit was made, but the index could not be updated: {e}"))?;
        self.live = false;
        Ok(())
    }
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        if self.live {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// The temporary index a commit's hooks see; it is removed when dropped, whatever happened.
struct TempIndex(std::path::PathBuf);

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

/// Writes the working file `rel` into the object database through the clean filters
/// (`core.autocrlf`, `.gitattributes`), as `git add` does, and returns the blob id.
fn hash_into_odb(repo: &git2::Repository, rel: &str) -> Result<Oid, git2::Error> {
    use git2::Binding;
    let path = std::ffi::CString::new(rel)
        .map_err(|_| git2::Error::from_str("path contains a NUL byte"))?;
    let mut oid: libgit2_sys::git_oid = unsafe { std::mem::zeroed() };
    // SAFETY: the repository pointer lives as long as `repo`, the path is a NUL-terminated string
    // that outlives the call, and `oid` is a valid output location.
    let code =
        unsafe { libgit2_sys::git_blob_create_fromworkdir(&mut oid, repo.raw(), path.as_ptr()) };
    if code < 0 {
        return Err(git2::Error::last_error(code));
    }
    Oid::from_bytes(&oid.id)
}

/// The mode of a file `HEAD` does not have yet: executable only where the file system says so.
fn new_file_mode(file: &Path) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(file).is_ok_and(|m| m.permissions().mode() & 0o111 != 0) {
            return 0o100755;
        }
    }
    let _ = file;
    0o100644
}

/// Sets `rel`'s entry in `index` to the blob and mode given, or removes it. The stat fields stay
/// zero, so git compares the file's content the next time it looks.
fn set_entry(
    index: &mut git2::Index,
    rel: &str,
    entry: Option<(Oid, u32)>,
) -> Result<(), git2::Error> {
    match entry {
        Some((id, mode)) => index.add(&git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode,
            uid: 0,
            gid: 0,
            file_size: 0,
            id,
            flags: 0,
            flags_extended: 0,
            path: rel.as_bytes().to_vec(),
        }),
        None if index.get_path(Path::new(rel), 0).is_some() => index.remove_path(Path::new(rel)),
        None => Ok(()),
    }
}

/// git's `whitespace` cleanup of a commit message: trailing whitespace removed from every line,
/// leading and trailing blank lines removed, runs of blank lines collapsed to one, a final newline.
/// Comment lines are kept, as they are for `git commit -m`.
fn stripspace(message: &str) -> String {
    let mut out = String::new();
    let mut blank_pending = false;
    for line in message.split('\n') {
        let line = line.trim_end_matches([' ', '\t', '\r', '\n', '\x0b', '\x0c']);
        if line.is_empty() {
            blank_pending = !out.is_empty();
            continue;
        }
        if blank_pending {
            out.push('\n');
            blank_pending = false;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// What git says when it has no name or email for the author.
fn unknown_identity() -> String {
    "Author identity unknown\n\n*** Please tell me who you are.\n\nRun\n\n  git config --global user.email \"you@example.com\"\n  git config --global user.name \"Your Name\"\n\nto set your account's default identity.\nOmit --global to set the identity only in this repository.\n\nfatal: unable to auto-detect email address".to_string()
}

/// The git command line, kept for the writes that have not moved to libgit2 yet and for the
/// comparisons that still run it. Nothing new is added here.
pub(crate) mod legacy_cli {
    use super::GitError;
    use std::path::Path;

    fn exec(dir: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
        let fail = |stderr: String| GitError {
            args: args.join(" "),
            stderr,
        };
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(dir).args(args);
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
        exec(dir, args).map(|out| super::trimmed_text(&out))
    }

    /// Run `git -C <dir> <args>` and return stdout untouched, byte for byte.
    #[cfg(test)]
    pub fn run_bytes(dir: &Path, args: &[&str]) -> Result<Vec<u8>, GitError> {
        exec(dir, args)
    }
}

/// Test fixtures build repositories with the command line.
#[cfg(test)]
pub use legacy_cli::{run, run_bytes};

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
