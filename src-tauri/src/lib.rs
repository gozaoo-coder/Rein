mod commands;
mod sync;

use commands::storage::{init, storage_delete, storage_path, storage_read, storage_write};
use commands::sync::*;
use commands::http::http_fetch;
use sync::{DiscoveryState, PairingState, SyncState, TransportState};
use sync::store::init_store;
use tauri::Manager;

fn gen_device_id() -> String {
    // 基于主机名 + 进程启动时间生成稳定 ID
    use std::time::SystemTime;
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "device".into());
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{hostname}-{ts:x}")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let state_storage = init(app);
            app.manage(state_storage);

            // P2P 同步初始化
            let sync_store = init_store(app);
            let device_id = gen_device_id();
            let device_name = std::env::var("COMPUTERNAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_else(|_| "Rein-Device".into());
            let sync_state = SyncState {
                store: std::sync::Arc::new(sync_store),
                pairing: std::sync::Arc::new(PairingState::new()),
                discovery: std::sync::Arc::new(DiscoveryState::new()),
                transport: std::sync::Arc::new(TransportState::new()),
                device_id: device_id.clone(),
                device_name: device_name.clone(),
            };
            // 加载本地数据
            let store_ref = sync_state.store.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = store_ref.load().await;
                // 启动 UDP 发现 + TCP 服务
                sync::discovery::spawn(app_handle.clone(), device_id.clone(), device_name.clone());
                sync::transport::spawn_server(app_handle);
            });
            app.manage(sync_state);

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
            sync_device_info,
            sync_pair_code,
            sync_pair_request,
            sync_pair_respond,
            sync_unpair,
            sync_paired_list,
            sync_online_list,
            sync_data_list,
            sync_data_upsert,
            sync_data_delete,
            http_fetch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
