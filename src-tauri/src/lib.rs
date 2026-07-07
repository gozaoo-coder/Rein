mod commands;

use commands::storage::{init, storage_delete, storage_path, storage_read, storage_write};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let state = init(app);
            app.manage(state);
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage_read,
            storage_write,
            storage_delete,
            storage_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
