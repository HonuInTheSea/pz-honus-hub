use std::path::Path;
use walkdir::WalkDir;

#[tauri::command]
pub fn list_media_script_files(
    media_dir: String,
    mod_media_dir: Option<String>,
) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    let mut roots = Vec::new();
    if !media_dir.trim().is_empty() {
        roots.push(media_dir);
    }
    if let Some(mod_dir) = mod_media_dir {
        if !mod_dir.trim().is_empty() {
            roots.push(mod_dir);
        }
    }
    for root in roots {
        let script_dir = Path::new(&root).join("scripts");
        if !script_dir.exists() {
            continue;
        }
        for entry in WalkDir::new(script_dir)
            .follow_links(true)
            .into_iter()
            .filter_map(|entry| entry.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if !ext.eq_ignore_ascii_case("txt") {
                continue;
            }
            out.push(path.to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
pub fn has_ogg_files(path: String) -> Result<bool, String> {
    for entry in WalkDir::new(&path)
        .follow_links(true)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        if ext.eq_ignore_ascii_case("ogg") {
            return Ok(true);
        }
    }
    Ok(false)
}
