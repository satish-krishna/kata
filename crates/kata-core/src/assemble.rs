use tempfile::TempDir;

#[derive(Debug)]
pub struct Assembled {
    pub plugin_dir: Option<String>,
    pub system_prompt_file: Option<String>,
    // RAII: when dropped, the temp directory and its contents are removed.
    #[allow(dead_code)]
    _temp: Option<TempDir>,
}

impl Assembled {
    /// Construct without a backing temp dir, for tests of pure consumers.
    pub fn for_test(plugin_dir: Option<String>, system_prompt_file: Option<String>) -> Self {
        Self { plugin_dir, system_prompt_file, _temp: None }
    }
}
