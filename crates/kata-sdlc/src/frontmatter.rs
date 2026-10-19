/// Read `key` from the front matter block (between the first two `---` lines).
/// Only simple `key: value` lines are understood; the value is trimmed.
pub fn field(text: &str, key: &str) -> Option<String> {
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    for line in lines {
        if line.trim_end() == "---" {
            return None;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim() == key {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_trimmed_value() {
        let t = "---\nrepo: svc\nsource_commit:  abc123 \n---\nbody\nother: x\n";
        assert_eq!(field(t, "source_commit").as_deref(), Some("abc123"));
        assert_eq!(field(t, "repo").as_deref(), Some("svc"));
    }

    #[test]
    fn ignores_body_and_missing_block() {
        assert_eq!(field("---\na: 1\n---\nother: x\n", "other"), None);
        assert_eq!(field("no front matter\nkey: v\n", "key"), None);
        assert_eq!(field("---\na: 1\n", "b"), None);
    }
}
