//! The ask bridge: how a paused interactive run carries a question from claude
//! (via the `kata _mcp-ask` MCP server it spawns) to the engine and an answer
//! back. One JSON object per line over a localhost TCP connection; one
//! question-batch in flight at a time (claude blocks on the tool result).

use crate::event::Question;
use crate::run::CancelToken;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::Sender;
use std::thread;

/// A question-batch handed to the run loop. Reply with one inner Vec per
/// question (chosen option labels, or [typed text], or [] when optional/blank).
pub struct AskRequest {
    pub questions: Vec<Question>,
    pub reply: std::sync::mpsc::Sender<Vec<Vec<String>>>,
}

#[derive(Deserialize)]
struct QuestionFrame {
    questions: Vec<Question>,
}

#[derive(Serialize)]
struct AnswerFrame<'a> {
    answers: &'a [Vec<String>],
}

/// Localhost listener for the ask bridge. Bind early in the run so the port can
/// be handed to the child; then `serve` to accept the MCP server's connection.
pub struct Bridge {
    listener: TcpListener,
}

impl Bridge {
    pub fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        Ok(Self { listener })
    }

    pub fn port(&self) -> u16 {
        self.listener.local_addr().map(|a| a.port()).unwrap_or(0)
    }

    /// Spawn the accept loop. For each line on an accepted connection, parse a
    /// question-batch, forward it as an `AskRequest`, block on its reply, and
    /// write the answer frame back. Stops when `cancel` trips or the peer closes.
    pub fn serve(self, tx: Sender<AskRequest>, cancel: CancelToken) {
        // Note: a cancel only takes effect between connections — a bridge idle in accept() unblocks when the next connection arrives or when the process exits (each run is its own OS process).
        thread::spawn(move || {
            for stream in self.listener.incoming() {
                if cancel.is_cancelled() {
                    break;
                }
                let Ok(stream) = stream else { break };
                if handle_conn(stream, &tx).is_err() { /* peer gone */ }
                if cancel.is_cancelled() {
                    break;
                }
            }
        });
    }
}

fn handle_conn(
    stream: TcpStream,
    tx: &Sender<AskRequest>,
) -> std::io::Result<()> {
    let mut write_half = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(()); // peer closed
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(frame) = serde_json::from_str::<QuestionFrame>(trimmed) else {
            continue;
        };
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        if tx
            .send(AskRequest {
                questions: frame.questions,
                reply: reply_tx,
            })
            .is_err()
        {
            return Ok(()); // run loop gone
        }
        // Block until the run loop supplies an answer (or is cancelled/torn down).
        let answers = match reply_rx.recv() {
            Ok(a) => a,
            Err(_) => return Ok(()),
        };
        let frame = AnswerFrame { answers: &answers };
        let body = serde_json::to_string(&frame).map_err(std::io::Error::other)?;
        writeln!(write_half, "{body}")?;
        write_half.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::QuestionKind;
    use crate::run::CancelToken;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;
    use std::sync::mpsc;

    #[test]
    fn bridge_round_trips_a_question_and_answer() {
        let bridge = Bridge::bind().unwrap();
        let port = bridge.port();
        let (tx, rx) = mpsc::channel::<AskRequest>();
        bridge.serve(tx, CancelToken::new());

        let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
        writeln!(
            sock,
            r#"{{"questions":[{{"kind":"text","header":"h","question":"q?"}}]}}"#
        )
        .unwrap();

        let req = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(req.questions.len(), 1);
        assert_eq!(req.questions[0].kind, QuestionKind::Text);
        req.reply.send(vec![vec!["typed answer".into()]]).unwrap();

        let mut reader = BufReader::new(sock.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(
            line.contains(r#""answers":[["typed answer"]]"#),
            "got {line}"
        );
    }
}
