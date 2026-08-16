use crate::pz_compat::{server_config_paths, server_dir, validate_server_name};
use crate::timing::scoped_timer;
use std::fs;

#[tauri::command]
pub fn list_server_names(user_dir: String) -> Result<Vec<String>, String> {
    let _timer = scoped_timer("list_server_names");
    let base = server_dir(&user_dir);
    if !base.exists() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(&base).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            match path.extension().and_then(|s| s.to_str()) {
                Some(ext) if ext.eq_ignore_ascii_case("ini") => path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .map(|s| s.to_string()),
                _ => None,
            }
        })
        .collect();
    names.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    Ok(names)
}

#[tauri::command]
pub fn delete_server_files(user_dir: String, server_name: String) -> Result<(), String> {
    let trimmed = validate_server_name(&server_name)?;
    let files = server_config_paths(&user_dir, trimmed);
    for path in files {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
