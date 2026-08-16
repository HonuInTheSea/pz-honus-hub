mod character_editor;
mod file_commands;
mod lua_export;
mod map_status;
mod map_view;
mod media;
mod mod_scanner;
mod models;
mod modlist;
mod presets;
mod pz_compat;
mod pzmap2dzi;
mod pzmap2dzi_renderer;
mod server_files;
mod store;
mod timing;
mod utils;

pub use models::*;

pub fn run_pzmap2dzi_worker_if_requested() -> bool {
    pzmap2dzi::run_worker_if_requested()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(pzmap2dzi::BuildManager::default())
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
            pz_compat::get_pz_compatibility_info,
            character_editor::list_character_save_slots,
            character_editor::list_save_map_markers,
            character_editor::read_character_save,
            character_editor::copy_character_save,
            character_editor::delete_character_save,
            character_editor::save_character_stats,
            character_editor::load_character_render_assets,
            character_editor::load_character_customization_options,
            map_view::open_project_zomboid_map,
            map_view::close_project_zomboid_map,
            map_view::set_project_zomboid_map_visibility,
            map_status::inspect_map_render_status,
            map_status::allow_map_asset_directory,
            pzmap2dzi::estimate_pzmap2dzi_build,
            pzmap2dzi::inspect_pzmap2dzi_output,
            pzmap2dzi::inspect_pzmap2dzi_resume,
            pzmap2dzi::prepare_pzmap2dzi_output,
            pzmap2dzi::parse_pzmap2dzi_yaml,
            pzmap2dzi::serialize_pzmap2dzi_yaml,
            pzmap2dzi::get_pzmap2dzi_build_status,
            pzmap2dzi::start_pzmap2dzi_build,
            pzmap2dzi::stop_pzmap2dzi_build,
            pzmap2dzi::terminate_pzmap2dzi_build,
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
