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
pub mod publish;
mod process;
pub mod snapshot;
pub mod start;
pub mod store;
pub mod workspace;

#[cfg(test)]
mod testutil;
