// Persistent JSON storage in app data dir.
// Cross-platform: uses tauri::Manager::path().app_data_dir() which resolves to
//   Windows: %APPDATA%/<identifier>
//   macOS:   ~/Library/Application Support/<identifier>
//   Linux:   ~/.local/share/<identifier>
//   Android: app internal files dir
//   iOS:     app Library/Application Support
// One JSON file per storage key. All IO is sync (files are tiny).

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{Manager, State};

/// Holds resolved app data dir + lazy in-memory cache.
pub struct StorageState {
    pub dir: PathBuf,
    pub cache: Mutex<HashMap<String, Value>>,
}

impl StorageState {
    fn file_path(&self, key: &str) -> PathBuf {
        // sanitize key to prevent path traversal
        let safe: String = key
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        self.dir.join(format!("{safe}.json"))
    }
}

pub fn init(app: &tauri::App) -> StorageState {
    let dir = app
        .path()
        .app_data_dir()
        .expect("app_data_dir should resolve on all platforms");
    let _ = fs::create_dir_all(&dir);
    StorageState {
        dir,
        cache: Mutex::new(HashMap::new()),
    }
}

#[tauri::command]
pub fn storage_read(key: String, state: State<StorageState>) -> Option<Value> {
    {
        let cache = state.cache.lock().ok()?;
        if let Some(v) = cache.get(&key) {
            return Some(v.clone());
        }
    }
    let path = state.file_path(&key);
    let content = fs::read_to_string(&path).ok()?;
    let value: Value = serde_json::from_str(&content).ok()?;
    if let Ok(mut cache) = state.cache.lock() {
        cache.insert(key, value.clone());
    }
    Some(value)
}

#[tauri::command]
pub fn storage_write(
    key: String,
    value: Value,
    state: State<StorageState>,
) -> Result<(), String> {
    let path = state.file_path(&key);
    let content = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;
    if let Ok(mut cache) = state.cache.lock() {
        cache.insert(key, value);
    }
    Ok(())
}

#[tauri::command]
pub fn storage_delete(key: String, state: State<StorageState>) -> Result<(), String> {
    let path = state.file_path(&key);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    if let Ok(mut cache) = state.cache.lock() {
        cache.remove(&key);
    }
    Ok(())
}

#[tauri::command]
pub fn storage_path(state: State<StorageState>) -> String {
    state.dir.to_string_lossy().to_string()
}
