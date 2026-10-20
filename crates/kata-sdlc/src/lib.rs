//! Workspace, git, and local-store logic for the Workbench's AI-SDLC mode.

pub mod base;
pub mod branch;
pub mod build;
pub mod changes;
pub mod commits;
pub mod decide;
pub mod frontmatter;
pub mod git;
pub mod pins;
pub mod snapshot;
pub mod store;
pub mod workspace;

#[cfg(test)]
mod testutil;
