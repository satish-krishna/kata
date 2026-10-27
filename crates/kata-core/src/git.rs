//! The two libgit2 jobs that Kata's engine and the AI-SDLC backend both need, kept in one place:
//! the per-file line counts of a diff, and the settling of racily clean index entries after an
//! index write.

use git2::{Delta, Diff, Oid, Patch, Repository};

/// What one file of a diff adds and removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FileCounts {
    pub added: u32,
    pub removed: u32,
    /// libgit2 treats the file as binary (a NUL byte, a binary attribute, or a high share of
    /// control characters). A binary file has no line counts.
    pub binary: bool,
}

/// The line counts of the file at `index` in `diff`, the way `git diff --numstat` gives them, with
/// binary detection from libgit2's patch flags.
///
/// A renamed file has its lines counted unless `renames_count_lines` is false, in which case it
/// reports zero added and removed lines (and no patch is built for it). A file that has no patch
/// reports zero lines and the binary flag of its delta.
pub fn file_counts(
    diff: &Diff<'_>,
    index: usize,
    renames_count_lines: bool,
) -> Result<FileCounts, git2::Error> {
    if !renames_count_lines {
        if let Some(delta) = diff.get_delta(index) {
            if delta.status() == Delta::Renamed {
                return Ok(FileCounts::default());
            }
        }
    }
    Ok(match Patch::from_diff(diff, index)? {
        Some(patch) => {
            let (_, added, removed) = patch.line_stats()?;
            let binary = patch.delta().flags().is_binary();
            counts(added, removed, binary)
        }
        None => {
            let binary = diff.get_delta(index).is_some_and(|d| d.flags().is_binary());
            counts(0, 0, binary)
        }
    })
}

fn counts(added: usize, removed: usize, binary: bool) -> FileCounts {
    FileCounts {
        added: if binary { 0 } else { added as u32 },
        removed: if binary { 0 } else { removed as u32 },
        binary,
    }
}

/// When the index file of `repo` was last written, in whole seconds; take it before an operation
/// rewrites the index and hand it to [`smudge_racy_entries`] afterward. `None` when the index
/// file does not exist or its time cannot be read.
pub fn index_stamp(repo: &Repository) -> Option<i64> {
    let modified = std::fs::metadata(repo.path().join("index"))
        .and_then(|m| m.modified())
        .ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_secs()).ok()
}

/// What git does whenever it writes the index: an entry whose file was modified no earlier than
/// the old index was written ("racily clean") cannot be told apart from an unchanged file by its
/// size and time alone, so when its content differs from the staged content its size is zeroed
/// and the next status looks at the content. libgit2 does not do this, and without it an edit
/// made in the same second as the previous write would show as no change at all.
///
/// `stamp` is [`index_stamp`] taken before the index was rewritten; `None` does nothing. Call this
/// after every operation that writes the index through libgit2.
pub fn smudge_racy_entries(repo: &Repository, stamp: Option<i64>) {
    let Some(stamp) = stamp else { return };
    let Ok(mut index) = repo.index() else {
        return;
    };
    if index.read(true).is_err() {
        return;
    }
    let racy: Vec<git2::IndexEntry> = index
        .iter()
        .filter(|e| {
            (e.flags & 0x3000) == 0
                && e.file_size != 0
                && e.mode & 0o170000 == 0o100000
                && i64::from(e.mtime.seconds()) >= stamp
        })
        .collect();
    let mut changed = false;
    for mut entry in racy {
        let path = String::from_utf8_lossy(&entry.path).into_owned();
        let same = hash_file(repo, &path).is_ok_and(|h| h == entry.id);
        if !same {
            entry.file_size = 0;
            changed |= index.add(&entry).is_ok();
        }
    }
    if changed {
        let _ = index.write();
    }
}

/// What `git hash-object -- <rel>` prints: the blob id of the working tree file after the clean
/// filters, written nowhere.
pub fn hash_file(repo: &Repository, rel: &str) -> Result<Oid, git2::Error> {
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
    let path = std::ffi::CString::new(rel)
        .map_err(|_| git2::Error::from_str("path contains a NUL byte"))?;
    let mut oid: libgit2_sys::git_oid = unsafe { std::mem::zeroed() };
    // SAFETY: the repository pointer lives as long as `repo`, the path is a NUL-terminated string
    // that outlives the call, and `oid` is a valid output location.
    let code = unsafe {
        git_repository_hashfile(
            &mut oid,
            repo.raw(),
            path.as_ptr(),
            libgit2_sys::GIT_OBJECT_BLOB,
            path.as_ptr(),
        )
    };
    if code < 0 {
        return Err(git2::Error::last_error(code));
    }
    Oid::from_bytes(&oid.id)
}
