//! The context-preset library: named reusable text blocks under `~/.kata/presets`.
use crate::fsutil;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[cfg_attr(feature = "ts", ts(export, export_to = "../../../app/src/bindings/"))]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Preset {
    pub name: String,
    pub body: String,
}

#[derive(Debug, thiserror::Error)]
pub enum PresetError {
    #[error("preset name must contain at least one letter or digit")]
    InvalidName,
    #[error("serializing preset: {0}")]
    Ser(String),
    #[error("{0}")]
    Io(String),
}

/// All presets, sorted by name. Best-effort (malformed files skipped).
pub fn list_presets() -> Vec<Preset> {
    let Some(dir) = fsutil::presets_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<Preset> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("toml"))
        .filter_map(|p| {
            std::fs::read_to_string(&p)
                .ok()
                .and_then(|t| toml::from_str::<Preset>(&t).ok())
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Persist a preset as `<slug(name)>.toml` (overwrites same-named).
pub fn save_preset(preset: &Preset) -> Result<PathBuf, PresetError> {
    if !preset.name.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err(PresetError::InvalidName);
    }
    let dir = fsutil::presets_dir()
        .ok_or_else(|| PresetError::Io("no home directory for ~/.kata".into()))?;
    std::fs::create_dir_all(&dir).map_err(|e| PresetError::Io(e.to_string()))?;
    let path = dir.join(format!("{}.toml", fsutil::slug(&preset.name)));
    let text = toml::to_string(preset).map_err(|e| PresetError::Ser(e.to_string()))?;
    std::fs::write(&path, text).map_err(|e| PresetError::Io(e.to_string()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    fn with_home() -> tempfile::TempDir {
        let h = tempfile::tempdir().unwrap();
        std::env::set_var("KATA_HOME", h.path());
        h
    }

    #[test]
    #[serial]
    fn save_then_list_round_trip() {
        let _h = with_home();
        save_preset(&Preset {
            name: "dotnet repro".into(),
            body: "Use dotnet test --filter.".into(),
        })
        .unwrap();
        save_preset(&Preset {
            name: "azure ctx".into(),
            body: "Target the staging slot.".into(),
        })
        .unwrap();
        let all = list_presets();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "azure ctx"); // sorted by name
        assert_eq!(all[1].body, "Use dotnet test --filter.");
    }

    #[test]
    #[serial]
    fn rejects_nameless_preset() {
        let _h = with_home();
        assert!(matches!(
            save_preset(&Preset {
                name: "  ".into(),
                body: "x".into()
            }),
            Err(PresetError::InvalidName)
        ));
    }

    #[test]
    #[serial]
    fn list_skips_malformed() {
        let _h = with_home();
        save_preset(&Preset {
            name: "good".into(),
            body: "b".into(),
        })
        .unwrap();
        let dir = crate::fsutil::presets_dir().unwrap();
        std::fs::write(dir.join("broken.toml"), "= = =").unwrap();
        assert_eq!(list_presets().len(), 1);
    }
}
