use crate::utils::{ensure_parent_dir, safe_relative_path};
use serde_json::Value as JsonValue;
use std::fs;
use std::path::Path;

fn rewrite_mods_txt(path: &Path, mod_id: &str) -> Result<bool, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let normalized = content.replace("\r\n", "\n");
    let mut lines: Vec<String> = normalized.lines().map(|l| l.to_string()).collect();
    let mut updated = false;
    let mut in_mods = false;
    for line in &mut lines {
        let trimmed = line.trim();
        if trimmed.eq_ignore_ascii_case("mods") {
            in_mods = true;
            continue;
        }
        if in_mods && trimmed.starts_with('}') {
            in_mods = false;
        }
        if !in_mods {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            let value = value.trim().trim_end_matches(',').trim_start_matches('\\');
            if key.trim().eq_ignore_ascii_case("mod") && value.eq_ignore_ascii_case(mod_id.trim()) {
                *line = String::new();
                updated = true;
            }
        }
    }
    if !updated {
        return Ok(false);
    }
    let rewritten = lines
        .into_iter()
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(path, rewritten).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn remove_mod_from_active_mods(
    user_dir: String,
    rel_dir: String,
    mod_id: String,
) -> Result<JsonValue, String> {
    let path = safe_relative_path(&Path::new(&user_dir).join("Saves"), &rel_dir)?.join("mods.txt");
    let updated = if path.exists() {
        rewrite_mods_txt(&path, &mod_id)?
    } else {
        false
    };
    Ok(serde_json::json!({
        "updated": updated,
        "path": path.to_string_lossy().to_string(),
    }))
}

fn rewrite_modlist_settings(path: &Path, mod_id: &str) -> Result<bool, String> {
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let normalized = content.replace("\r\n", "\n");
    let mut lines: Vec<String> = normalized.lines().map(|l| l.to_string()).collect();
    let mut updated = false;

    for line in &mut lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('!') && trimmed.ends_with(':') {
            continue;
        }

        if let Some(idx) = line.find(':') {
            let name = line[..idx].trim();
            if name.is_empty() {
                continue;
            }
            let mods_part = &line[idx + 1..];
            let cleaned = mods_part
                .split(';')
                .map(|chunk| chunk.replace('\\', "").trim().to_string())
                .filter(|chunk| !chunk.is_empty() && !chunk.eq_ignore_ascii_case(mod_id.trim()))
                .collect::<Vec<String>>();
            let rebuilt = build_pz_modlist_entry(name, &cleaned);
            if rebuilt != *line {
                *line = rebuilt;
                updated = true;
            }
        }
    }

    if !updated {
        return Ok(false);
    }
    write_modlist_lines(path, &lines)?;
    Ok(true)
}

#[tauri::command]
pub fn remove_mod_from_pz_modlist_settings(
    user_dir: String,
    mod_id: String,
) -> Result<JsonValue, String> {
    let path = Path::new(&user_dir)
        .join("Lua")
        .join("pz_modlist_settings.cfg");
    let updated = if path.exists() {
        rewrite_modlist_settings(&path, &mod_id)?
    } else {
        false
    };
    Ok(serde_json::json!({
        "updated": updated,
        "path": path.to_string_lossy().to_string(),
    }))
}

fn build_pz_modlist_entry(preset_name: &str, mod_ids: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut cleaned = Vec::new();
    for raw in mod_ids {
        let value = raw.trim().trim_start_matches('\\').to_string();
        if value.is_empty() {
            continue;
        }
        if seen.insert(value.to_lowercase()) {
            cleaned.push(value);
        }
    }
    if cleaned.is_empty() {
        return format!("{}:", preset_name.trim());
    }
    let mods = cleaned
        .iter()
        .map(|id| format!("\\{}", id))
        .collect::<Vec<_>>()
        .join(";");
    format!("{}:{};", preset_name.trim(), mods)
}

#[tauri::command]
pub fn upsert_pz_modlist_settings_preset(
    user_dir: String,
    preset_name: String,
    mod_ids: Vec<String>,
) -> Result<JsonValue, String> {
    let path = Path::new(&user_dir)
        .join("Lua")
        .join("pz_modlist_settings.cfg");
    let existing = if path.exists() {
        fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    let mut normalized = existing.replace("\r\n", "\n");
    if normalized.starts_with('\u{feff}') {
        normalized = normalized.trim_start_matches('\u{feff}').to_string();
    }
    let mut lines: Vec<String> = normalized.lines().map(|l| l.to_string()).collect();
    let preset_entry = build_pz_modlist_entry(&preset_name, &mod_ids);

    let target_name = preset_name.trim().to_lowercase();
    let mut replaced = false;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim().to_string();
        if line.is_empty() {
            i += 1;
            continue;
        }
        if line.starts_with('!') && line.ends_with(':') {
            i += 1;
            continue;
        }
        if let Some(colon) = line.find(':') {
            let name = line[..colon].trim().to_lowercase();
            if name == target_name {
                if replaced {
                    lines.remove(i);
                    continue;
                }
                lines[i] = preset_entry.clone();
                replaced = true;
            }
        }
        i += 1;
    }

    if !replaced {
        if lines.last().is_some_and(|line| !line.trim().is_empty()) {
            lines.push(String::new());
        }
        lines.push(preset_entry);
    }

    write_modlist_lines(&path, &lines)?;
    Ok(serde_json::json!({
        "updated": true,
        "path": path.to_string_lossy().to_string(),
    }))
}

#[tauri::command]
pub fn remove_pz_modlist_settings_preset(
    user_dir: String,
    preset_name: String,
) -> Result<JsonValue, String> {
    let path = Path::new(&user_dir)
        .join("Lua")
        .join("pz_modlist_settings.cfg");
    if !path.exists() {
        return Ok(serde_json::json!({
            "updated": false,
            "path": path.to_string_lossy().to_string(),
        }));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let normalized = content.replace("\r\n", "\n");
    let mut lines: Vec<String> = normalized.lines().map(|l| l.to_string()).collect();
    let target = preset_name.trim().to_lowercase();
    let mut updated = false;
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.is_empty() {
            i += 1;
            continue;
        }
        if trimmed.starts_with('!') && trimmed.ends_with(':') {
            i += 1;
            continue;
        }
        if let Some(colon) = trimmed.find(':') {
            let name = trimmed[..colon].trim().to_lowercase();
            if name == target {
                lines.remove(i);
                updated = true;
                continue;
            }
        }
        i += 1;
    }

    if !updated {
        return Ok(serde_json::json!({
            "updated": false,
            "path": path.to_string_lossy().to_string(),
        }));
    }

    write_modlist_lines(&path, &lines)?;
    Ok(serde_json::json!({
        "updated": true,
        "path": path.to_string_lossy().to_string(),
    }))
}

fn write_modlist_lines(path: &Path, lines: &[String]) -> Result<(), String> {
    let rewritten = lines
        .iter()
        .map(|line| line.trim_end())
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    ensure_parent_dir(path)?;
    fs::write(path, rewritten).map_err(|e| e.to_string())?;
    Ok(())
}
