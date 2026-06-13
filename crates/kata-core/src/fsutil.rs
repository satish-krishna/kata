use std::path::Path;

/// Recursively copy a directory tree from `src` into `dst` (created if absent).
pub fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_nested_tree() {
        let src = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(src.path().join("a")).unwrap();
        std::fs::write(src.path().join("a").join("f.txt"), "hi").unwrap();
        let dst = tempfile::tempdir().unwrap();
        let target = dst.path().join("out");
        copy_dir(src.path(), &target).unwrap();
        assert_eq!(std::fs::read_to_string(target.join("a").join("f.txt")).unwrap(), "hi");
    }
}
