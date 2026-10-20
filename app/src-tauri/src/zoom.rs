//! The Workbench's zoom level: stepped like a browser's, and remembered in
//! `<kata-home>/workbench/zoom.json` so the next launch opens at the same size.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Step {
    In,
    Out,
    Reset,
}

/// The browser's zoom steps. A saved level outside them falls back to 100%.
const LEVELS: [f64; 11] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];
const EPS: f64 = 1e-6;

/// The level one step from `current`, held at the first and last step.
pub fn next(current: f64, step: Step) -> f64 {
    match step {
        Step::Reset => 1.0,
        Step::In => LEVELS
            .into_iter()
            .find(|l| *l > current + EPS)
            .unwrap_or(LEVELS[LEVELS.len() - 1]),
        Step::Out => LEVELS
            .into_iter()
            .rev()
            .find(|l| *l < current - EPS)
            .unwrap_or(LEVELS[0]),
    }
}

/// The window's current level, seeded from the saved one at launch. Steps start
/// from here rather than from the file, so a failed save cannot hold the zoom in place.
pub struct Level(pub Mutex<f64>);

/// Step `level`, apply it to the window, then remember it. The window and `level`
/// move together; a failed save is reported but the step stands.
pub fn apply(
    level: &Mutex<f64>,
    step: Step,
    set: impl FnOnce(f64) -> Result<(), String>,
    save: impl FnOnce(f64) -> Result<(), String>,
) -> Result<f64, String> {
    let mut current = level.lock().map_err(|e| e.to_string())?;
    let next = next(*current, step);
    set(next)?;
    *current = next;
    save(next)?;
    Ok(next)
}

pub fn load_from(path: &Path) -> f64 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("zoom").and_then(Value::as_f64))
        .filter(|z| (LEVELS[0] - EPS..=LEVELS[LEVELS.len() - 1] + EPS).contains(z))
        .unwrap_or(1.0)
}

pub fn save_to(path: &Path, zoom: f64) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, json!({ "zoom": zoom }).to_string())
}

fn file() -> Option<PathBuf> {
    kata_sdlc::store::workbench_dir().map(|d| d.join("zoom.json"))
}

/// The remembered level, or 100% when there is none.
pub fn load() -> f64 {
    file().map(|f| load_from(&f)).unwrap_or(1.0)
}

pub fn save(zoom: f64) -> Result<(), String> {
    let f = file().ok_or("no home directory for the Workbench's data")?;
    save_to(&f, zoom).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kata-zoom-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("workbench").join("zoom.json")
    }

    #[test]
    fn steps_through_the_browser_levels_and_stops_at_the_ends() {
        assert_eq!(next(1.0, Step::In), 1.1);
        assert_eq!(next(1.0, Step::Out), 0.9);
        assert_eq!(next(2.0, Step::In), 2.0);
        assert_eq!(next(0.5, Step::Out), 0.5);
        assert_eq!(next(1.75, Step::Reset), 1.0);
    }

    #[test]
    fn a_level_between_steps_moves_to_the_nearest_step_in_that_direction() {
        assert_eq!(next(1.2, Step::In), 1.25);
        assert_eq!(next(1.2, Step::Out), 1.1);
    }

    #[test]
    fn a_failed_save_still_moves_the_window_and_the_next_step_starts_from_there() {
        let level = Mutex::new(1.0);
        let failing_save = |_: f64| Err("read-only".to_string());
        assert_eq!(
            apply(&level, Step::In, |_| Ok(()), failing_save),
            Err("read-only".into())
        );
        assert_eq!(apply(&level, Step::In, |_| Ok(()), |_| Ok(())), Ok(1.25));
    }

    #[test]
    fn a_window_that_refuses_the_zoom_keeps_its_level() {
        let level = Mutex::new(1.0);
        let refused = apply(&level, Step::In, |_| Err("no webview".into()), |_| Ok(()));
        assert_eq!(refused, Err("no webview".into()));
        assert_eq!(*level.lock().unwrap(), 1.0);
    }

    #[test]
    fn a_saved_level_is_read_back() {
        let file = temp_file("roundtrip");
        save_to(&file, 1.25).unwrap();
        assert_eq!(load_from(&file), 1.25);
    }

    #[test]
    fn a_missing_unreadable_or_out_of_range_file_means_100_percent() {
        let file = temp_file("bad");
        assert_eq!(load_from(&file), 1.0);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        for body in [
            "not json",
            r#"{"zoom":"big"}"#,
            r#"{"zoom":9}"#,
            r#"{"zoom":0}"#,
        ] {
            std::fs::write(&file, body).unwrap();
            assert_eq!(load_from(&file), 1.0, "{body}");
        }
    }
}
