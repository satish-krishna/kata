/// Read `key` from the front matter block (between the first two `---` lines).
/// Only simple `key: value` lines are understood; the value is trimmed and one pair of
/// matching surrounding quotes (`"…"` or `'…'`) is removed.
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
                return Some(unquote(v.trim()).to_string());
            }
        }
    }
    None
}

fn unquote(v: &str) -> &str {
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return &v[1..v.len() - 1];
        }
    }
    v
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
    fn strips_one_pair_of_matching_quotes() {
        let t = "---
status: \"accepted\"
repo: 'svc'
odd: \"x'
nested: \"\"y\"\"
one: \"
---
";
        assert_eq!(field(t, "status").as_deref(), Some("accepted"));
        assert_eq!(field(t, "repo").as_deref(), Some("svc"));
        assert_eq!(field(t, "odd").as_deref(), Some("\"x'"));
        assert_eq!(field(t, "nested").as_deref(), Some("\"y\""));
        assert_eq!(field(t, "one").as_deref(), Some("\""));
    }

    #[test]
    fn ignores_body_and_missing_block() {
        assert_eq!(field("---\na: 1\n---\nother: x\n", "other"), None);
        assert_eq!(field("no front matter\nkey: v\n", "key"), None);
        assert_eq!(field("---\na: 1\n", "b"), None);
    }
}
