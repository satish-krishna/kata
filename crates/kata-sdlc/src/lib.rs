//! Workspace, git, and local-store logic for the Workbench's AI-SDLC mode.
#![cfg_attr(test, allow(clippy::disallowed_methods))]

pub mod accept;
pub mod ai_sdlc;
pub mod board;
pub mod branch;
pub mod build;
pub mod changes;
pub mod checks_view;
pub mod coordinator;
pub mod copy_removal;
pub mod diff;
pub mod done;
pub mod format;
pub mod frontmatter;
pub mod git;
pub mod holds;
pub mod home;
pub mod naming;
pub mod offer;
pub mod old_checks;
pub mod open_changes;
pub mod permissions;
pub mod plugin;
mod process;
pub mod prs;
pub mod pull_requests;
pub mod review;
pub mod round;
pub mod runspec;
pub mod snapshot;
pub mod store;
pub mod view;
pub mod workspace;

#[cfg(test)]
mod testutil;
