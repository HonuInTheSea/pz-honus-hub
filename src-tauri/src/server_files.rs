use crate::timing::scoped_timer;
use std::fs;
use std::path::Path;

#[tauri::command]
pub fn list_server_names(user_dir: String) -> Result<Vec<String>, String> {
    let _timer = scoped_timer("list_server_names");
    let base = Path::new(&user_dir).join("Server");
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
    let base = Path::new(&user_dir).join("Server");
    let trimmed = server_name.trim();
    if trimmed.is_empty() {
        return Err("Server name is empty.".to_string());
    }
    let files = vec![
        base.join(format!("{}.ini", trimmed)),
        base.join(format!("{}_SandboxVars.lua", trimmed)),
        base.join(format!("{}_spawnregions.lua", trimmed)),
        base.join(format!("{}_spawnpoints.lua", trimmed)),
    ];
    for path in files {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
