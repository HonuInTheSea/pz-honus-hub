use crate::timing::scoped_timer;
use crate::utils::{ensure_parent_dir, safe_relative_path, sanitize_filename_component};
use serde_json::Value as JsonValue;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

#[tauri::command]
pub fn list_save_mods_files(user_dir: String) -> Result<Vec<String>, String> {
    let _timer = scoped_timer("list_save_mods_files");
    let mut out = Vec::new();
    let base = Path::new(&user_dir).join("Saves");
    if !base.exists() {
        return Ok(out);
    }
    for entry in WalkDir::new(base)
        .follow_links(true)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name.eq_ignore_ascii_case("mods.txt") {
            out.push(entry.path().to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}
#[tauri::command]
pub fn analyze_mod_loadout(mods: Vec<JsonValue>) -> Result<JsonValue, String> {
    let _timer = scoped_timer("analyze_mod_loadout");
    let ordered: Vec<String> = mods
        .iter()
        .filter_map(|m| m.get("modId").and_then(|v| v.as_str()))
        .map(|v| v.to_string())
        .collect();
    let result = serde_json::json!({
        "orderedModIds": ordered,
        "missingModIds": [],
        "missingWorkshopIds": [],
        "cycles": [],
        "incompatiblePairs": [],
        "conflicts": [],
        "warnings": [],
    });
    Ok(result)
}

fn build_server_ini(mod_ids: &[String], workshop_ids: &[String]) -> String {
    let mods = mod_ids.join(";");
    let workshops = workshop_ids.join(";");
    format!("Mods={}\nWorkshopItems={}\n", mods, workshops)
}

#[tauri::command]
pub fn plan_server_preset(
    zomboid_user_dir: String,
    preset_name: String,
    mod_ids: Vec<String>,
    workshop_ids: Vec<String>,
) -> Result<JsonValue, String> {
    let _timer = scoped_timer("plan_server_preset");
    let file_name = format!("{}.ini", sanitize_filename_component(&preset_name));
    let target = Path::new(&zomboid_user_dir).join("Server").join(file_name);
    let ini_preview = build_server_ini(&mod_ids, &workshop_ids);
    Ok(serde_json::json!({
        "presetName": preset_name,
        "targetPath": target.to_string_lossy().to_string(),
        "iniPreview": ini_preview,
    }))
}

#[tauri::command]
pub fn write_server_preset(
    zomboid_user_dir: String,
    preset_name: String,
    mod_ids: Vec<String>,
    workshop_ids: Vec<String>,
) -> Result<(), String> {
    let _timer = scoped_timer("write_server_preset");
    let file_name = format!("{}.ini", sanitize_filename_component(&preset_name));
    let target = Path::new(&zomboid_user_dir).join("Server").join(file_name);
    ensure_parent_dir(&target)?;
    let ini = build_server_ini(&mod_ids, &workshop_ids);
    fs::write(&target, ini).map_err(|e| e.to_string())?;
    Ok(())
}

fn build_mods_txt(mod_ids: &[String]) -> String {
    let mut out = String::new();
    out.push_str("mods\n{\n");
    for id in mod_ids {
        out.push_str(&format!("    mod=\\{},\n", id));
    }
    out.push_str("}\n\nmaps\n{\n}\n");
    out
}

#[tauri::command]
pub fn plan_singleplayer_save_mods(
    zomboid_user_dir: String,
    save_rel_path: String,
    mod_ids: Vec<String>,
    _workshop_ids: Vec<String>,
) -> Result<JsonValue, String> {
    let _timer = scoped_timer("plan_singleplayer_save_mods");
    let target = safe_relative_path(&Path::new(&zomboid_user_dir).join("Saves"), &save_rel_path)?
        .join("mods.txt");
    let preview = build_mods_txt(&mod_ids);
    Ok(serde_json::json!({
        "presetName": format!("Active Mods ({})", save_rel_path),
        "targetPath": target.to_string_lossy().to_string(),
        "iniPreview": preview,
    }))
}

#[tauri::command]
pub fn write_singleplayer_save_mods(
    zomboid_user_dir: String,
    save_rel_path: String,
    mod_ids: Vec<String>,
    _workshop_ids: Vec<String>,
) -> Result<(), String> {
    let _timer = scoped_timer("write_singleplayer_save_mods");
    let target = safe_relative_path(&Path::new(&zomboid_user_dir).join("Saves"), &save_rel_path)?
        .join("mods.txt");
    ensure_parent_dir(&target)?;
    let content = build_mods_txt(&mod_ids);
    fs::write(&target, content).map_err(|e| e.to_string())?;
    Ok(())
}
