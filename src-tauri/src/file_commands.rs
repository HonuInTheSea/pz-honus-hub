use crate::models::StoreSnapshotPayload;
use crate::timing::scoped_timer;
use crate::utils::ensure_parent_dir;
use std::env;
use std::fs;
use std::path::Path;
use std::process::Command;

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let _timer = scoped_timer("read_text_file");
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    ensure_parent_dir(Path::new(&path))?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn copy_file(source: String, target: String) -> Result<(), String> {
    if source.trim().is_empty() || target.trim().is_empty() {
        return Err("Source or target path is empty.".to_string());
    }
    if let Some(parent) = Path::new(&target).parent() {
        ensure_parent_dir(parent)?;
    }
    fs::copy(&source, &target).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn backup_file(path: String) -> Result<(), String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("Path is empty.".to_string());
    }
    let backup_path = format!("{}.bak", raw);
    fs::copy(raw, backup_path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn truncate_text_file(path: String) -> Result<(), String> {
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_default_zomboid_user_dir() -> Result<Option<String>, String> {
    let _timer = scoped_timer("get_default_zomboid_user_dir");
    let base = env::var("USERPROFILE")
        .or_else(|_| env::var("HOME"))
        .unwrap_or_default();
    if base.is_empty() {
        return Ok(None);
    }
    let home = Path::new(&base);
    let mut candidates = Vec::new();
    candidates.push(home.join("Zomboid"));
    if cfg!(target_os = "linux") {
        candidates.push(home.join(".zomboid"));
    }
    for path in candidates {
        if path.exists() {
            return Ok(Some(path.to_string_lossy().to_string()));
        }
    }
    Ok(None)
}

#[tauri::command]
pub fn open_mod_in_explorer(path: String) -> Result<(), String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("Path is empty.".to_string());
    }

    let target = Path::new(raw);
    let mut open_dir = target.to_path_buf();
    let mut select_file: Option<std::path::PathBuf> = None;

    if target.is_file() {
        select_file = Some(target.to_path_buf());
        if let Some(parent) = target.parent() {
            open_dir = parent.to_path_buf();
        }
    } else {
        // Treat input as a mod directory path; prefer selecting mod.info if present.
        if target.exists() {
            open_dir = target.to_path_buf();
            let mod_info = open_dir.join("mod.info");
            if mod_info.exists() {
                select_file = Some(mod_info);
            }
        } else {
            // If the path does not exist, attempt to resolve a mod.info file within it.
            let mod_info = target.join("mod.info");
            if mod_info.exists() {
                open_dir = target.to_path_buf();
                select_file = Some(mod_info);
            } else {
                return Err("Path does not exist.".to_string());
            }
        }
    }
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("explorer.exe");
        if let Some(file) = select_file {
            cmd.arg(format!("/select,{}", file.to_string_lossy()));
        } else {
            cmd.arg(open_dir);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let open_cmd = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(open_cmd)
        .arg(open_dir)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn export_store_snapshot(payload: StoreSnapshotPayload) -> Result<(), String> {
    let dir = payload
        .default_dir
        .as_ref()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(Path::new)
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf()));
    let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let path = dir.join(format!("pz_store_snapshot_{}.json", ts));
    ensure_parent_dir(&path)?;
    let json = serde_json::to_string_pretty(&serde_json::json!({
        "mods": payload.mods,
        "browserStorage": payload.browser_storage,
        "workshop": payload.workshop,
    }))
    .map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}
