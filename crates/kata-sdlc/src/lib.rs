//! Workspace, git, and local-store logic for the Workbench's AI-SDLC mode.
#![cfg_attr(test, allow(clippy::disallowed_methods))]

pub mod ai_sdlc;
pub mod base;
pub mod branch;
pub mod branch_record;
pub mod build;
pub mod changes;
pub mod checks;
pub mod commits;
pub mod coordinator;
pub mod decide;
pub mod diff;
pub mod format;
pub mod frontmatter;
pub mod git;
pub mod github;
pub mod holds;
pub mod naming;
pub mod offer;
pub mod participants;
pub mod permissions;
pub mod pins;
pub mod plugin;
mod process;
pub mod prs;
pub mod publish;
pub mod pull_requests;
pub mod review;
pub mod round;
pub mod runspec;
pub mod snapshot;
pub mod start;
pub mod store;
pub mod view;
pub mod workspace;

#[cfg(test)]
mod testutil;
