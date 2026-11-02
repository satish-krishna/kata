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

/// Return `text` with the front matter `status` line set to `value`. A missing line is added before the
/// closing `---`; a file with no front matter gets a new block. Existing line endings are kept.
pub fn set_status(text: &str, value: &str) -> String {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let eol_of = |line: &str| -> &'static str {
        if line.ends_with("\r\n") {
            "\r\n"
        } else if line.ends_with('\n') {
            "\n"
        } else {
            ""
        }
    };
    let opens = lines.first().is_some_and(|l| l.trim_end() == "---");
    if !opens {
        return format!("---\nstatus: {value}\n---\n{text}");
    }
    let default_eol = match eol_of(lines[0]) {
        "" => "\n",
        e => e,
    };
    let mut out = String::with_capacity(text.len() + 24);
    out.push_str(lines[0]);
    let mut done = false;
    let mut closed = false;
    for line in &lines[1..] {
        if closed {
            out.push_str(line);
        } else if line.trim_end() == "---" {
            closed = true;
            if !done {
                out.push_str(&format!("status: {value}{default_eol}"));
                done = true;
            }
            out.push_str(line);
        } else if !done
            && line
                .split_once(':')
                .is_some_and(|(k, _)| k.trim() == "status")
        {
            done = true;
            out.push_str(&format!("status: {value}{}", eol_of(line)));
        } else {
            out.push_str(line);
        }
    }
    out
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
    #[test]
    fn set_status_replaces_adds_and_keeps_line_endings() {
        assert_eq!(
            set_status("---\nstatus: draft\nscope: x\n---\nbody\n", "accepted"),
            "---\nstatus: accepted\nscope: x\n---\nbody\n"
        );
        assert_eq!(
            set_status("---\nscope: x\n---\nbody\n", "rejected"),
            "---\nscope: x\nstatus: rejected\n---\nbody\n"
        );
        assert_eq!(
            set_status("---\r\nstatus: draft\r\n---\r\nbody\r\n", "accepted"),
            "---\r\nstatus: accepted\r\n---\r\nbody\r\n"
        );
        assert_eq!(
            set_status("body\n", "accepted"),
            "---\nstatus: accepted\n---\nbody\n"
        );
    }
}
