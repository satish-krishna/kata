//! The grammar of the engine's stdin control lines that carry free text.
//!
//! Only `say` lives here: its text is arbitrary, so it travels as one JSON
//! string and never as raw text spliced into a line.

use crate::run::Message;

/// Build a `say <id> <json-string>\n` control line.
pub fn say_line(id: &str, text: &str) -> Option<String> {
    // serde_json escapes line breaks, quotes and control characters, so the
    // line always ends at the one trailing newline.
    let json = serde_json::to_string(text).expect("a string always serializes");
    Some(format!("say {id} {json}\n"))
}

/// Parse the part of a `say` line after `say `. `None` when it does not follow
/// the grammar; a line that does not parse is ignored, never half-applied.
pub fn parse_say(rest: &str) -> Option<Message> {
    let (id, json) = rest.split_once(' ')?;
    if id.is_empty() || id.contains(char::is_whitespace) {
        return None;
    }
    // `from_str` rejects anything after the one value except whitespace.
    let text: String = serde_json::from_str(json).ok()?;
    Some(Message {
        id: id.to_string(),
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn say_line_round_trips_through_parse_say() {
        let text = "line one\nsays \"hi\" \\ back\ttab \u{1}ctl é 日本 🙂";
        let line = say_line("m1", text).expect("a good id");
        assert!(line.starts_with("say m1 "));
        assert!(line.ends_with('\n'));
        assert_eq!(
            line.matches('\n').count(),
            1,
            "one newline, at the end: {line:?}"
        );
        let rest = line.strip_prefix("say ").unwrap().trim_end_matches('\n');
        let m = parse_say(rest).expect("parses");
        assert_eq!(
            m,
            Message {
                id: "m1".into(),
                text: text.into()
            }
        );
    }

    #[test]
    fn say_line_rejects_an_id_that_would_split_or_blur_the_line() {
        for bad in [
            "",
            "a b",
            "a\tb",
            "a\nb",
            "a\rb",
            " a",
            "a ",
            "a \"x\"\ndecide p1 allow\nsay b",
        ] {
            assert!(say_line(bad, "hi").is_none(), "should reject {bad:?}");
        }
    }

    #[test]
    fn parse_say_rejects_malformed_lines() {
        // `parse_say` takes the part after `say `, so the full-line cases `say`
        // and `say m1` reach it as the empty string and `m1`.
        for bad in [
            "",
            "m1",
            "m1 not-json",
            "m1 \"a\" trailing",
            " \"a\"",
            "m1 [\"a\"]",
            "m1\t\"a\"",
        ] {
            assert!(parse_say(bad).is_none(), "should reject {bad:?}");
        }
    }

    #[test]
    fn parse_say_accepts_blank_text_and_trailing_whitespace() {
        assert_eq!(parse_say("m1 \"\"").unwrap().text, "");
        assert_eq!(parse_say("m1 \"  \"  ").unwrap().text, "  ");
    }
}
