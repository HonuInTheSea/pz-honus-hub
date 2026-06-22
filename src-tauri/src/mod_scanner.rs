use crate::models::{ModFileInfo, ModFolderScanResult, ModSummary, RequiredByInfo};
use crate::timing::scoped_timer;
use crate::utils::to_iso_string;
use encoding_rs::{EUC_KR, WINDOWS_1252};
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

fn parse_list(raw: &str) -> Vec<String> {
    raw.split(|c| c == ';' || c == ',' || c == '\n' || c == '\r')
        .map(|part| part.trim().trim_matches('"').trim_matches('\''))
        .filter(|part| !part.is_empty())
        .map(|part| part.to_string())
        .collect()
}

fn normalize_mod_ref(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('"').trim_matches('\'');
    trimmed.trim_start_matches('\\').to_string()
}

fn resolve_relative_path(base: &Path, value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
        return None;
    }

    let joined = base.join(trimmed);
    if joined.exists() {
        return Some(joined.to_string_lossy().to_string());
    }

    None
}

fn derive_workshop_id(base: &str, mod_info_path: &str) -> Option<String> {
    let base_norm = base.replace('\\', "/");
    let mod_norm = mod_info_path.replace('\\', "/");

    if !mod_norm.starts_with(&base_norm) {
        return None;
    }

    let relative = mod_norm[base_norm.len()..].trim_start_matches('/');
    let mut parts = relative.split('/').filter(|p| !p.is_empty());
    let first = parts.next()?;
    if first.chars().all(|c| c.is_ascii_digit()) {
        return Some(first.to_string());
    }
    None
}
fn parse_mod_info_file(path: &Path) -> Result<ModSummary, String> {
    let raw = fs::read(path).map_err(|e| e.to_string())?;
    let content = match String::from_utf8(raw) {
        Ok(s) => s,
        Err(e) => {
            let bytes = e.as_bytes();
            let encodings = [EUC_KR, WINDOWS_1252];
            encodings
                .iter()
                .find_map(|enc| {
                    let (decoded, _, had_errors) = enc.decode(bytes);
                    if !had_errors {
                        Some(decoded.into_owned())
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| String::from_utf8_lossy(bytes).into_owned())
        }
    };
    let base_dir = path.parent().unwrap_or_else(|| Path::new(""));

    let mut mod_id: Option<String> = None;
    let mut name: Option<String> = None;
    let mut workshop_id: Option<String> = None;
    let mut author: Option<String> = None;
    let mut version: Option<String> = None;
    let mut version_min: Option<String> = None;
    let mut version_max: Option<String> = None;
    let mut url: Option<String> = None;
    let mut description: Option<String> = None;
    let mut requires: Vec<String> = Vec::new();
    let mut dependencies: Vec<String> = Vec::new();
    let mut load_after: Vec<String> = Vec::new();
    let mut load_before: Vec<String> = Vec::new();
    let mut incompatible: Vec<String> = Vec::new();
    let mut packs: Vec<String> = Vec::new();
    let mut tiledefs: Vec<String> = Vec::new();
    let mut soundbanks: Vec<String> = Vec::new();
    let mut worldmap: Option<String> = None;
    let mut icon: Option<String> = None;
    let mut preview_image: Option<String> = None;
    let mut poster_images: Vec<String> = Vec::new();

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') || line.starts_with("//") || line.starts_with(';') {
            continue;
        }
        let (key_raw, value_raw) = match line.split_once('=') {
            Some(parts) => parts,
            None => continue,
        };

        let key = key_raw.trim().to_lowercase();
        let value = value_raw.trim();
        if value.is_empty() {
            continue;
        }

        match key.as_str() {
            "id" | "modid" => mod_id = Some(value.to_string()),
            "name" => name = Some(value.to_string()),
            "workshopid" => workshop_id = Some(value.to_string()),
            "author" | "authors" => author = Some(value.to_string()),
            "version" | "modversion" => version = Some(value.to_string()),
            "versionmin" | "version_min" => version_min = Some(value.to_string()),
            "versionmax" | "version_max" => version_max = Some(value.to_string()),
            "url" => url = Some(value.to_string()),
            "description" => description = Some(value.to_string()),
            "require" | "requires" => requires.extend(parse_list(value)),
            "depend" | "dependencies" => dependencies.extend(parse_list(value)),
            "loadafter" => load_after.extend(parse_list(value)),
            "loadbefore" => load_before.extend(parse_list(value)),
            "incompatible" => incompatible.extend(parse_list(value)),
            "pack" | "packs" => packs.extend(parse_list(value)),
            "tiledef" | "tiledefs" => tiledefs.extend(parse_list(value)),
            "soundbank" | "soundbanks" => soundbanks.extend(parse_list(value)),
            "worldmap" => worldmap = Some(value.to_string()),
            "icon" | "iconfile" => icon = resolve_relative_path(base_dir, value),
            "preview" | "previewimage" | "preview_image" => {
                preview_image = resolve_relative_path(base_dir, value)
            }
            "poster" | "posters" => {
                for entry in parse_list(value) {
                    if let Some(path) = resolve_relative_path(base_dir, &entry) {
                        poster_images.push(path);
                    }
                }
            }
            _ => {}
        }
    }

    let info_path = path.to_string_lossy().to_string();
    let name_value = name
        .clone()
        .or_else(|| mod_id.clone())
        .unwrap_or_else(|| "Unknown Mod".to_string());

    let id_value = mod_id
        .clone()
        .or_else(|| workshop_id.clone())
        .unwrap_or_else(|| info_path.clone());

    Ok(ModSummary {
        id: id_value,
        mod_id,
        name: name_value,
        workshop_id,
        author,
        hidden: None,
        favorite: None,
        version,
        version_min,
        version_max,
        install_date: None,
        url,
        requires: if requires.is_empty() {
            None
        } else {
            Some(requires)
        },
        dependencies: if dependencies.is_empty() {
            None
        } else {
            Some(dependencies)
        },
        load_after: if load_after.is_empty() {
            None
        } else {
            Some(load_after)
        },
        load_before: if load_before.is_empty() {
            None
        } else {
            Some(load_before)
        },
        incompatible: if incompatible.is_empty() {
            None
        } else {
            Some(incompatible)
        },
        packs: if packs.is_empty() { None } else { Some(packs) },
        tiledefs: if tiledefs.is_empty() {
            None
        } else {
            Some(tiledefs)
        },
        soundbanks: if soundbanks.is_empty() {
            None
        } else {
            Some(soundbanks)
        },
        worldmap,
        icon,
        preview_image_path: preview_image,
        poster_image_paths: if poster_images.is_empty() {
            None
        } else {
            Some(poster_images)
        },
        description,
        mod_info_path: Some(info_path),
        required_by: None,
        workshop: None,
    })
}

fn merge_optional_string(base: &mut Option<String>, incoming: Option<String>) {
    if base.as_ref().map(|v| v.trim().is_empty()).unwrap_or(true) {
        if let Some(value) = incoming {
            if !value.trim().is_empty() {
                *base = Some(value);
            }
        }
    }
}

fn merge_optional_vec(base: &mut Option<Vec<String>>, incoming: Option<Vec<String>>) {
    let mut values = base.take().unwrap_or_default();
    if let Some(incoming_values) = incoming {
        for value in incoming_values {
            if value.trim().is_empty() {
                continue;
            }
            if !values
                .iter()
                .any(|existing| existing.eq_ignore_ascii_case(&value))
            {
                values.push(value);
            }
        }
    }
    if values.is_empty() {
        *base = None;
    } else {
        *base = Some(values);
    }
}

fn merge_summary(base: &mut ModSummary, incoming: ModSummary) {
    merge_optional_string(&mut base.mod_id, incoming.mod_id);
    if base.name.trim().is_empty() && !incoming.name.trim().is_empty() {
        base.name = incoming.name;
    }
    merge_optional_string(&mut base.workshop_id, incoming.workshop_id);
    merge_optional_string(&mut base.author, incoming.author);
    merge_optional_string(&mut base.version, incoming.version);
    merge_optional_string(&mut base.version_min, incoming.version_min);
    merge_optional_string(&mut base.version_max, incoming.version_max);
    merge_optional_string(&mut base.install_date, incoming.install_date);
    merge_optional_string(&mut base.url, incoming.url);
    merge_optional_vec(&mut base.requires, incoming.requires);
    merge_optional_vec(&mut base.dependencies, incoming.dependencies);
    merge_optional_vec(&mut base.load_after, incoming.load_after);
    merge_optional_vec(&mut base.load_before, incoming.load_before);
    merge_optional_vec(&mut base.incompatible, incoming.incompatible);
    merge_optional_vec(&mut base.packs, incoming.packs);
    merge_optional_vec(&mut base.tiledefs, incoming.tiledefs);
    merge_optional_vec(&mut base.soundbanks, incoming.soundbanks);
    merge_optional_string(&mut base.worldmap, incoming.worldmap);
    merge_optional_string(&mut base.icon, incoming.icon);
    merge_optional_string(&mut base.preview_image_path, incoming.preview_image_path);
    merge_optional_vec(&mut base.poster_image_paths, incoming.poster_image_paths);
    merge_optional_string(&mut base.description, incoming.description);
    merge_optional_string(&mut base.mod_info_path, incoming.mod_info_path);
}

#[tauri::command]
pub fn validate_pz_workshop_path(path: String) -> Result<bool, String> {
    let dir = Path::new(&path);
    if !dir.exists() || !dir.is_dir() {
        return Ok(false);
    }

    let last = dir.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let contains_108600 = last == "108600"
        || dir
            .components()
            .any(|c| c.as_os_str().to_string_lossy() == "108600");

    if !contains_108600 {
        return Ok(false);
    }

    let mut has_numeric_folder = false;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(file_type) = entry.file_type() {
                if !file_type.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_digit()) {
                    has_numeric_folder = true;
                    break;
                }
            }
        }
    }

    Ok(has_numeric_folder)
}

#[tauri::command]
pub fn scan_mod_folder(path: String) -> Result<ModFolderScanResult, String> {
    let _timer = scoped_timer("scan_mod_folder");
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    for entry in WalkDir::new(&path)
        .follow_links(true)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy();
        if file_name.eq_ignore_ascii_case("mod.info") {
            paths.push(entry.path().to_path_buf());
        }
    }

    let results: Vec<(ModFileInfo, ModSummary)> = paths
        .par_iter()
        .map(|info_path| -> Result<(ModFileInfo, ModSummary), String> {
            let metadata = fs::metadata(info_path).map_err(|e| e.to_string())?;
            let modified = metadata.modified().ok().and_then(to_iso_string);
            let file_info = ModFileInfo {
                path: info_path.to_string_lossy().to_string(),
                file_name: "mod.info".to_string(),
                modified,
                size: metadata.len(),
            };

            let mut summary = parse_mod_info_file(info_path)?;
            summary.install_date = metadata.modified().ok().and_then(to_iso_string);
            if summary.workshop_id.is_none() {
                if let Some(mod_info_path) = summary.mod_info_path.clone() {
                    summary.workshop_id = derive_workshop_id(&path, &mod_info_path);
                }
            }
            Ok((file_info, summary))
        })
        .collect::<Result<Vec<_>, String>>()?;

    let mut files: Vec<ModFileInfo> = Vec::with_capacity(results.len());
    let mut summaries: Vec<ModSummary> = Vec::with_capacity(results.len());
    for (file, summary) in results {
        files.push(file);
        summaries.push(summary);
    }

    let mut deduped: HashMap<String, ModSummary> = HashMap::new();
    let mut uniques: Vec<ModSummary> = Vec::new();
    for summary in summaries {
        let mod_id = summary.mod_id.clone().unwrap_or_default();
        let name = summary.name.trim().to_string();
        if mod_id.trim().is_empty() || name.is_empty() {
            uniques.push(summary);
            continue;
        }
        let key = format!("{}::{}", name.to_lowercase(), mod_id.to_lowercase());
        if let Some(existing) = deduped.get_mut(&key) {
            merge_summary(existing, summary);
        } else {
            deduped.insert(key, summary);
        }
    }

    let mut merged_summaries: Vec<ModSummary> = deduped.into_values().collect();
    merged_summaries.extend(uniques);
    let mut summaries = merged_summaries;

    let mut by_mod_id: HashMap<String, (String, String)> = HashMap::new();
    for mod_item in &summaries {
        let mod_id = match &mod_item.mod_id {
            Some(id) => id.trim(),
            None => "",
        };
        if mod_id.is_empty() {
            continue;
        }
        let name = mod_item.name.trim();
        by_mod_id.insert(
            mod_id.to_lowercase(),
            (mod_id.to_string(), name.to_string()),
        );
    }

    let mut required_by_map: HashMap<String, Vec<RequiredByInfo>> = HashMap::new();
    for mod_item in &summaries {
        let source_id = match &mod_item.mod_id {
            Some(id) => id.trim(),
            None => "",
        };
        if source_id.is_empty() {
            continue;
        }
        let source_name = mod_item.name.clone();

        let mut raw_refs: Vec<String> = Vec::new();
        if let Some(values) = &mod_item.requires {
            raw_refs.extend(values.clone());
        }
        if let Some(values) = &mod_item.dependencies {
            raw_refs.extend(values.clone());
        }

        for raw in raw_refs {
            let normalized = normalize_mod_ref(&raw);
            let key = normalized.to_lowercase();
            if by_mod_id.contains_key(&key) {
                let entry = required_by_map.entry(key).or_default();
                if entry.iter().any(|info| info.mod_id == source_id) {
                    continue;
                }
                entry.push(RequiredByInfo {
                    mod_id: source_id.to_string(),
                    name: source_name.clone(),
                });
            }
        }
    }

    for mod_item in &mut summaries {
        let mod_id = match &mod_item.mod_id {
            Some(id) => id.trim(),
            None => "",
        };
        if mod_id.is_empty() {
            continue;
        }
        if let Some(list) = required_by_map.get(&mod_id.to_lowercase()) {
            let mut sorted = list.clone();
            sorted.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            mod_item.required_by = Some(sorted);
        }
    }

    Ok(ModFolderScanResult { files, summaries })
}
