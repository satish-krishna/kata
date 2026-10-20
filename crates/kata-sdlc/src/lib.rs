//! Workspace, git, and local-store logic for the Workbench's AI-SDLC mode.

pub mod base;
pub mod branch;
pub mod build;
pub mod changes;
pub mod checks;
pub mod commits;
pub mod decide;
pub mod diff;
pub mod frontmatter;
pub mod git;
pub mod pins;
mod process;
pub mod publish;
pub mod snapshot;
pub mod start;
pub mod store;
pub mod workspace;

#[cfg(test)]
mod testutil;
