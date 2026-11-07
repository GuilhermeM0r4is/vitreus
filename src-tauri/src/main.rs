// Prevents an extra console window on Windows; irrelevant on macOS but harmless.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod lighting;
mod state;

use std::sync::Mutex;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_state = commands::init_state(&app.handle());
            app.manage(Mutex::new(app_state));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_library,
            commands::create_campaign,
            commands::save_folders,
            commands::rename_campaign,
            commands::switch_campaign,
            commands::load_current_scene,
            commands::save_scene,
            commands::export_campaign,
            commands::import_campaign,
            commands::import_asset,
            commands::asset_path,
            commands::compute_visibility_batch,
            commands::clear_all_data,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
