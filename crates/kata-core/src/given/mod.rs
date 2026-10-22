//! The items a run can start with ("the given") and how one is identified.

pub mod id;
pub mod roots;
pub mod settings;
pub use id::{fnv1a64, hook_key, item_id, parse_item_id, ItemKind, ItemRef, Source, SWITCHABLE};
pub use roots::ResolveRoots;
pub mod items;
pub use settings::{hook_detail, ItemFacts, SettingsLayer};
pub mod apply;
pub use apply::{apply, merge_settings, Applied};
pub mod lock;
pub mod resolve;
pub mod status;
pub use lock::{lock_for, LockReason};
pub use resolve::{
    resolve, EnvName, ResolveOptions, Resolved, ResolvedItem, RunSetting, RunSettings,
    SettingSource,
};
pub use status::{
    given_event, status, ClaudeSide, GivenItem, GivenStatus, ImpossibleStatus, KataSide,
    StatusInput,
};
