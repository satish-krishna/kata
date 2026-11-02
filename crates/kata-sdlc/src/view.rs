//! What the Workbench's home and change page read: a system's changes as the plugin reported them, with
//! what each shows and offers. The Tauri commands build these; the types live here so ts-rs can generate
//! their bindings.
use crate::ai_sdlc::state::ChangeState;
use crate::offer::{ChangeOffer, LiveFacts};
use crate::plugin::Readiness;
use serde::Serialize;

/// One change as the list and the change page show it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct ChangeView {
    pub state: ChangeState,
    pub offer: ChangeOffer,
    pub live: LiveFacts,
    pub readiness: Readiness,
}

/// A system's changes, and whether a new one may be started.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct SystemView {
    pub system: String,
    pub readiness: Readiness,
    pub can_start_change: bool,
    pub start_change_reason: Option<String>,
    pub changes: Vec<ChangeView>,
    pub problems: Vec<String>,
}

/// Every system of a workspace the home lists, from one read, and whether a new change may be started in it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
pub struct WorkspaceView {
    /// One view per system asked for, in the order asked.
    pub systems: Vec<SystemView>,
    /// True only when at least one system was read and every one of them may start a change.
    pub can_start_change: bool,
    /// Why a new change may not be started: the first refusing system's reason; null when it may.
    pub start_change_reason: Option<String>,
}
