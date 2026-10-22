//! The items a run can start with ("the given") and how one is identified.

pub mod id;
pub use id::{fnv1a64, hook_key, item_id, parse_item_id, ItemKind, ItemRef, Source, SWITCHABLE};
