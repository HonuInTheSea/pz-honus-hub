mod file_commands;
mod lua_export;
mod media;
mod mod_scanner;
mod models;
mod modlist;
mod presets;
mod server_files;
mod store;
mod timing;
mod utils;

pub use models::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            store::get_bootstrap_store_items,
            mod_scanner::validate_pz_workshop_path,
            mod_scanner::scan_mod_folder,
            media::list_media_script_files,
            file_commands::backup_file,
            file_commands::read_text_file,
            file_commands::write_text_file,
            file_commands::copy_file,
            file_commands::truncate_text_file,
            file_commands::get_default_zomboid_user_dir,
            server_files::list_server_names,
            server_files::delete_server_files,
            presets::list_save_mods_files,
            presets::analyze_mod_loadout,
            presets::plan_server_preset,
            presets::write_server_preset,
            presets::plan_singleplayer_save_mods,
            presets::write_singleplayer_save_mods,
            media::has_ogg_files,
            lua_export::ensure_honu_mods_db,
            file_commands::open_mod_in_explorer,
            file_commands::export_store_snapshot,
            modlist::remove_mod_from_active_mods,
            modlist::remove_mod_from_pz_modlist_settings,
            modlist::upsert_pz_modlist_settings_preset,
            modlist::remove_pz_modlist_settings_preset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
