//! Workspace, git, and local-store logic for the Workbench's AI-SDLC mode.

pub mod branch;
pub mod changes;
pub mod frontmatter;
pub mod git;
pub mod snapshot;
pub mod store;
pub mod workspace;

#[cfg(test)]
mod testutil;
