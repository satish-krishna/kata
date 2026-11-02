//! How a finished child process ended, as the ai-sdlc and format programs' callers read it.

/// How a finished process ended, with its whole stdout and its stderr kept apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CapturedExit {
    /// The exit code, or `None` when the process was ended by a signal.
    pub code: Option<i32>,
    /// Everything the process wrote to stdout, undecoded.
    pub stdout: Vec<u8>,
    /// The last lines of stderr, lossy UTF-8, ANSI stripped.
    pub stderr: String,
}
