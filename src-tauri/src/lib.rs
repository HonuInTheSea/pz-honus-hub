use chrono::{DateTime, Utc};
use lofty::{file::TaggedFileExt, prelude::Accessor, read_from_path};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::Path;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;
use zip::{ZipArchive, ZipWriter};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerDbEntry {
    pub id: i64,
    pub name: Option<String>,
    pub wx: i32,
    pub wy: i32,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    #[serde(rename = "worldVersion")]
    pub world_version: i32,
    #[serde(rename = "isDead")]
    pub is_dead: bool,
    #[serde(rename = "dataLen")]
    pub data_len: i32,
    pub death_cause: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerDbBlob {
    pub id: i64,
    pub name: Option<String>,
    pub wx: i32,
    pub wy: i32,
    pub x: i32,
    pub y: i32,
    pub z: i32,
    #[serde(rename = "worldVersion")]
    pub world_version: i32,
    #[serde(rename = "isDead")]
    pub is_dead: bool,
    #[serde(rename = "dataHex")]
    pub data_hex: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerDbStringHit {
    pub offset: usize,
    pub length: usize,
    pub value: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerDbInspect {
    pub id: i64,
    pub size: usize,
    pub strings: Vec<PlayerDbStringHit>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerBlobTextFile {
    pub name: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PlayerDbUpdate {
    pub id: i64,
    pub name: Option<String>,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub z: Option<i32>,
    #[serde(rename = "isDead")]
    pub is_dead: Option<bool>,
    #[serde(rename = "dataHex")]
    pub data_hex: Option<String>,
    pub backup: Option<bool>,
    pub death_cause: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ModFileInfo {
    pub path: String,
    pub file_name: String,
    pub modified: Option<String>,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RequiredByInfo {
    #[serde(rename = "modId")]
    pub mod_id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ModSummary {
    pub id: String,
    pub mod_id: Option<String>,
    pub name: String,
    pub workshop_id: Option<String>,
    pub author: Option<String>,
    pub hidden: Option<bool>,
    pub favorite: Option<bool>,
    pub version: Option<String>,
    pub version_min: Option<String>,
    pub version_max: Option<String>,
    pub install_date: Option<String>,
    pub url: Option<String>,
    pub requires: Option<Vec<String>>,
    pub dependencies: Option<Vec<String>>,
    pub load_after: Option<Vec<String>>,
    pub load_before: Option<Vec<String>>,
    pub incompatible: Option<Vec<String>>,
    pub packs: Option<Vec<String>>,
    pub tiledefs: Option<Vec<String>>,
    pub soundbanks: Option<Vec<String>>,
    pub worldmap: Option<String>,
    pub icon: Option<String>,
    pub preview_image_path: Option<String>,
    pub poster_image_paths: Option<Vec<String>>,
    pub description: Option<String>,
    pub mod_info_path: Option<String>,
    pub required_by: Option<Vec<RequiredByInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workshop: Option<JsonValue>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ModFolderScanResult {
    pub files: Vec<ModFileInfo>,
    pub summaries: Vec<ModSummary>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OggTrackMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track_number: Option<u32>,
    pub genre: Option<String>,
    pub year: Option<i32>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OggTrackInfo {
    pub path: String,
    pub relative_path: String,
    pub size_bytes: u64,
    pub modified_epoch_ms: u128,
    pub metadata: OggTrackMetadata,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct HonuModsDbResult {
    pub created: bool,
    pub path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StoreSnapshotPayload {
    #[serde(rename = "defaultDir")]
    pub default_dir: Option<String>,
    pub mods: Vec<ModSummary>,
    #[serde(rename = "browserStorage")]
    pub browser_storage: Option<JsonValue>,
    pub workshop: JsonValue,
}
fn find_substr(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

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

fn to_iso_string(time: SystemTime) -> Option<String> {
    let dt: DateTime<Utc> = time.into();
    Some(dt.to_rfc3339())
}

fn to_epoch_ms(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
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

fn normalize_hex(input: &str) -> String {
    input
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

fn hex_to_bytes(input: &str) -> Result<Vec<u8>, String> {
    let normalized = normalize_hex(input);
    if normalized.len() % 2 != 0 {
        return Err("Hex length must be even.".to_string());
    }
    let mut out = Vec::with_capacity(normalized.len() / 2);
    let mut i = 0;
    while i < normalized.len() {
        let chunk = &normalized[i..i + 2];
        let byte = u8::from_str_radix(chunk, 16).map_err(|_| "Invalid hex".to_string())?;
        out.push(byte);
        i += 2;
    }
    Ok(out)
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn sanitize_filename_component(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
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
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
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

fn read_player_death_cause_from_blob(data: &[u8]) -> Option<String> {
    let cursor = Cursor::new(data);
    let mut archive = match ZipArchive::new(cursor) {
        Ok(archive) => archive,
        Err(_) => return None,
    };

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        if file.name().ends_with(".bin") {
            let mut buffer = Vec::new();
            if file.read_to_end(&mut buffer).is_ok() {
                if let Some(pos) = find_substr(&buffer, b"deathCause") {
                    let start = pos + 15; // "deathCause = ".len()
                    let end = buffer[start..]
                        .iter()
                        .position(|&b| b == b'\n')
                        .unwrap_or(buffer.len());
                    let death_cause_bytes = &buffer[start..start + end];
                    return Some(String::from_utf8_lossy(death_cause_bytes).to_string());
                }
            }
        }
    }

    None
}

#[tauri::command]
pub fn extract_player_death_cause_from_blob(data_hex: String) -> Result<Option<String>, String> {
    let bytes = hex_to_bytes(&data_hex)?;
    Ok(read_player_death_cause_from_blob(&bytes))
}

#[tauri::command]
pub fn apply_player_death_cause_to_blob(
    data_hex: String,
    death_cause: String,
) -> Result<String, String> {
    let data = hex_to_bytes(&data_hex)?;
    let mut new_data = Vec::new();
    let cursor = Cursor::new(&data);
    let mut archive = ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    let mut new_zip = ZipWriter::new(Cursor::new(&mut new_data));

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).map_err(|e| e.to_string())?;

        if file.name().ends_with(".bin") {
            if let Some(pos) = find_substr(&buffer, b"deathCause") {
                let start = pos + 15; // "deathCause = ".len()
                let end = buffer[start..]
                    .iter()
                    .position(|&b| b == b'\n')
                    .unwrap_or(buffer.len());
                let new_death_cause = format!("deathCause = {}", death_cause);
                buffer.splice(start..start + end, new_death_cause.bytes());
            } else {
                let new_death_cause = format!("\ndeathCause = {}", death_cause);
                buffer.extend(new_death_cause.bytes());
            }
        }
        new_zip
            .start_file(file.name(), zip::write::FileOptions::<()>::default())
            .map_err(|e| e.to_string())?;
        new_zip.write_all(&buffer).map_err(|e| e.to_string())?;
    }
    new_zip.finish().map_err(|e| e.to_string())?;
    Ok(bytes_to_hex(&new_data))
}

#[tauri::command]
pub fn extract_player_blob_text(data_hex: String) -> Result<Vec<PlayerBlobTextFile>, String> {
    let data = hex_to_bytes(&data_hex)?;
    let cursor = Cursor::new(&data);
    let mut archive = match ZipArchive::new(cursor) {
        Ok(archive) => archive,
        Err(_) => {
            let preview = String::from_utf8_lossy(&data)
                .chars()
                .take(20000)
                .collect::<String>();
            return Ok(vec![PlayerBlobTextFile {
                name: "raw.bin".to_string(),
                text: preview,
            }]);
        }
    };
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        if !file.name().ends_with(".bin") {
            continue;
        }
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&buffer).to_string();
        out.push(PlayerBlobTextFile {
            name: file.name().to_string(),
            text,
        });
    }
    Ok(out)
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

#[tauri::command]
pub fn list_save_player_dbs(user_dir: String) -> Result<Vec<String>, String> {
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
        if name.eq_ignore_ascii_case("players.db") {
            out.push(entry.path().to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

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
pub fn export_player_db_json(payload: JsonValue) -> Result<(), String> {
    let db_path = payload
        .get("dbPath")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "dbPath missing".to_string())?;
    let player_id = payload
        .get("player")
        .and_then(|v| v.get("id"))
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let file_name = format!("player_{}_{}.json", player_id, ts);
    let path = Path::new(db_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(file_name);
    ensure_parent_dir(&path)?;
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
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
pub fn list_server_names(user_dir: String) -> Result<Vec<String>, String> {
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
pub fn list_save_mods_files(user_dir: String) -> Result<Vec<String>, String> {
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
    let target = Path::new(&zomboid_user_dir)
        .join("Saves")
        .join(&save_rel_path)
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
    let target = Path::new(&zomboid_user_dir)
        .join("Saves")
        .join(&save_rel_path)
        .join("mods.txt");
    ensure_parent_dir(&target)?;
    let content = build_mods_txt(&mod_ids);
    fs::write(&target, content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_project_zomboid_music_ogg(game_dir: String) -> Result<Vec<OggTrackInfo>, String> {
    let mut out = Vec::new();
    let base = Path::new(&game_dir);
    let music_dir = base.join("media").join("music");
    let scan_root = if music_dir.exists() {
        music_dir
    } else {
        base.to_path_buf()
    };

    for entry in WalkDir::new(&scan_root)
        .follow_links(true)
        .into_iter()
        .filter_map(|entry| entry.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !ext.eq_ignore_ascii_case("ogg") {
            continue;
        }

        let metadata = fs::metadata(path).map_err(|e| e.to_string())?;
        let modified_epoch_ms = metadata.modified().map(to_epoch_ms).unwrap_or(0);
        let tagged = read_from_path(path).ok();
        let tag = tagged
            .as_ref()
            .and_then(|t| t.primary_tag())
            .or_else(|| tagged.as_ref().and_then(|t| t.first_tag()));

        let meta = if let Some(tag) = tag {
            OggTrackMetadata {
                title: tag.title().map(|v| v.to_string()),
                artist: tag.artist().map(|v| v.to_string()),
                album: tag.album().map(|v| v.to_string()),
                track_number: tag.track(),
                genre: tag.genre().map(|v| v.to_string()),
                year: tag.year().map(|v| v as i32),
            }
        } else {
            OggTrackMetadata {
                title: None,
                artist: None,
                album: None,
                track_number: None,
                genre: None,
                year: None,
            }
        };

        let relative = path
            .strip_prefix(&game_dir)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string());

        out.push(OggTrackInfo {
            path: path.to_string_lossy().to_string(),
            relative_path: relative,
            size_bytes: metadata.len(),
            modified_epoch_ms,
            metadata: meta,
        });
    }

    out.sort_by(|a, b| {
        a.relative_path
            .to_lowercase()
            .cmp(&b.relative_path.to_lowercase())
    });
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

fn lua_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out
}

fn lua_string(input: &str) -> String {
    format!("\"{}\"", lua_escape(input))
}

fn lua_bool(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

fn lua_string_list(values: &[String]) -> String {
    if values.is_empty() {
        return "{}".to_string();
    }
    let items = values
        .iter()
        .map(|v| lua_string(v))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{{ {} }}", items)
}

fn lua_required_by_list(values: &[RequiredByInfo]) -> String {
    if values.is_empty() {
        return "{}".to_string();
    }
    let items = values
        .iter()
        .filter_map(|info| {
            let mod_id = info.mod_id.trim();
            let name = info.name.trim();
            let mut fields = Vec::new();
            if !mod_id.is_empty() {
                fields.push(format!("modId = {}", lua_string(mod_id)));
            }
            if !name.is_empty() {
                fields.push(format!("name = {}", lua_string(name)));
            }
            if fields.is_empty() {
                None
            } else {
                Some(format!("{{ {} }}", fields.join(", ")))
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("{{ {} }}", items)
}

fn lua_json(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "nil".to_string(),
        JsonValue::Bool(v) => lua_bool(*v).to_string(),
        JsonValue::Number(v) => v.to_string(),
        JsonValue::String(v) => lua_string(v),
        JsonValue::Array(values) => {
            if values.is_empty() {
                return "{}".to_string();
            }
            let items = values.iter().map(lua_json).collect::<Vec<_>>().join(", ");
            format!("{{ {} }}", items)
        }
        JsonValue::Object(values) => {
            if values.is_empty() {
                return "{}".to_string();
            }
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let items = keys
                .into_iter()
                .filter_map(|key| values.get(key).map(|value| (key, value)))
                .map(|(key, value)| format!("[{}] = {}", lua_string(key), lua_json(value)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{{ {} }}", items)
        }
    }
}

fn lua_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return lua_string(key);
    }
    let mut chars = trimmed.chars();
    let first = chars.next().unwrap();
    let valid_first = first.is_ascii_alphabetic() || first == '_';
    let valid_rest = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if valid_first && valid_rest {
        trimmed.to_string()
    } else {
        format!("[{}]", lua_string(trimmed))
    }
}

fn strip_workshop_descriptions(value: &JsonValue) -> JsonValue {
    let JsonValue::Object(map) = value else {
        return value.clone();
    };
    let mut next = serde_json::Map::new();
    for (key, val) in map {
        if key.eq_ignore_ascii_case("description")
            || key.eq_ignore_ascii_case("file_description")
            || key.eq_ignore_ascii_case("short_description")
            || key.eq_ignore_ascii_case("app_name")
            || key.eq_ignore_ascii_case("appid")
            || key.eq_ignore_ascii_case("author")
            || key.eq_ignore_ascii_case("maybe_inappropriate_violence")
            || key.eq_ignore_ascii_case("num_children")
            || key.eq_ignore_ascii_case("num_comments_public")
            || key.eq_ignore_ascii_case("num_reports")
            || key.eq_ignore_ascii_case("preview_file_size")
            || key.eq_ignore_ascii_case("preview_url")
            || key.eq_ignore_ascii_case("publishedfileid")
            || key.eq_ignore_ascii_case("raw_tags")
            || key.eq_ignore_ascii_case("result")
            || key.eq_ignore_ascii_case("revision")
            || key.eq_ignore_ascii_case("revision_change_number")
            || key.eq_ignore_ascii_case("show_subscribe_all")
            || key.eq_ignore_ascii_case("tags")
            || key.eq_ignore_ascii_case("ban_reason")
            || key.eq_ignore_ascii_case("ban_text_check_result")
            || key.eq_ignore_ascii_case("banned")
            || key.eq_ignore_ascii_case("banner")
            || key.eq_ignore_ascii_case("can_be_deleted")
            || key.eq_ignore_ascii_case("can_subscribe")
            || key.eq_ignore_ascii_case("consumer_appid")
            || key.eq_ignore_ascii_case("consumer_shortcutid")
            || key.eq_ignore_ascii_case("creator")
            || key.eq_ignore_ascii_case("creator_appid")
            || key.eq_ignore_ascii_case("creator_avatar")
            || key.eq_ignore_ascii_case("creator_avatar_hash")
            || key.eq_ignore_ascii_case("creator_avatar_medium")
            || key.eq_ignore_ascii_case("creator_avatar_small")
            || key.eq_ignore_ascii_case("creator_commentpermission")
            || key.eq_ignore_ascii_case("creator_communityvisibilitystate")
            || key.eq_ignore_ascii_case("creator_id")
            || key.eq_ignore_ascii_case("creator_loccountrycode")
            || key.eq_ignore_ascii_case("creator_locstatecode")
            || key.eq_ignore_ascii_case("creator_personastate")
            || key.eq_ignore_ascii_case("creator_personastateflags")
            || key.eq_ignore_ascii_case("creator_primaryclanid")
            || key.eq_ignore_ascii_case("creator_profileurl")
            || key.eq_ignore_ascii_case("creator_profilestate")
            || key.eq_ignore_ascii_case("creator_name")
            || key.eq_ignore_ascii_case("creator_realname")
            || key.eq_ignore_ascii_case("creator_steamid")
            || key.eq_ignore_ascii_case("creator_timecreated")
            || key.eq_ignore_ascii_case("title")
            || key.eq_ignore_ascii_case("visibility")
            || key.eq_ignore_ascii_case("workshop_accepted")
            || key.eq_ignore_ascii_case("workshop_file")
            || key.eq_ignore_ascii_case("map_followers")
            || key.eq_ignore_ascii_case("followers")
            || key.eq_ignore_ascii_case("lifetime_favorited")
            || key.eq_ignore_ascii_case("lifetime_followers")
            || key.eq_ignore_ascii_case("lifetime_playtime")
            || key.eq_ignore_ascii_case("lifetime_playtime_sessions")
            || key.eq_ignore_ascii_case("lifetime_subscriptions")
            || key.eq_ignore_ascii_case("hcontent_file")
            || key.eq_ignore_ascii_case("hcontent_preview")
            || key.eq_ignore_ascii_case("language")
            || key.eq_ignore_ascii_case("file_type")
            || key.eq_ignore_ascii_case("file_url")
            || key.eq_ignore_ascii_case("fileid")
            || key.eq_ignore_ascii_case("filename")
            || key.eq_ignore_ascii_case("flags")
        {
            continue;
        }
        next.insert(key.clone(), val.clone());
    }
    JsonValue::Object(next)
}

fn json_value_to_id(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(v) => {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        JsonValue::Number(v) => Some(v.to_string()),
        _ => None,
    }
}

fn workshop_key_for_mod(mod_item: &ModSummary) -> Option<String> {
    if let Some(workshop_id) = mod_item.workshop_id.as_ref() {
        let trimmed = workshop_id.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let meta = mod_item.workshop.as_ref()?;
    let obj = meta.as_object()?;
    if let Some(value) = obj.get("fileid").and_then(json_value_to_id) {
        return Some(value);
    }
    if let Some(value) = obj.get("publishedfileid").and_then(json_value_to_id) {
        return Some(value);
    }
    None
}

#[tauri::command]
pub fn ensure_honu_mods_db(
    base_dir: String,
    mods: Vec<ModSummary>,
) -> Result<HonuModsDbResult, String> {
    let base = Path::new(&base_dir);
    let path = base.join("honus_miqol_db.lua");
    let created = !path.exists();
    ensure_parent_dir(&path)?;

    let mut lines = Vec::new();
    lines.push("return {".to_string());
    lines.push("  mods = {".to_string());
    for mod_item in mods {
        let mod_id = mod_item.mod_id.as_deref().unwrap_or("").to_string();
        let mod_id_trimmed = mod_id.trim();
        let id_value = if mod_id_trimmed.is_empty() {
            mod_item.id.clone()
        } else {
            mod_id_trimmed.to_string()
        };
        let id_value = if id_value.starts_with('\\') {
            id_value
        } else {
            format!("\\{}", id_value)
        };
        let workshop_id = workshop_key_for_mod(&mod_item).unwrap_or_default();
        let composite_id = if workshop_id.is_empty() {
            id_value.clone()
        } else {
            format!("{}::{}", id_value, workshop_id)
        };
        let creator_name = mod_item
            .workshop
            .as_ref()
            .and_then(|meta| meta.get("creator_name"))
            .and_then(|value| value.as_str())
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        let workshop_meta = mod_item
            .workshop
            .as_ref()
            .filter(|meta| !meta.is_null())
            .map(strip_workshop_descriptions);

        lines.push("    {".to_string());
        lines.push(format!("      id = {},", lua_string(&composite_id)));
        lines.push(format!(
            "      workshop_id = {},",
            lua_string(&workshop_id)
        ));
        let author_value = mod_item
            .author
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string())
            .or_else(|| creator_name.clone());
        if let Some(author) = author_value {
            lines.push(format!("      author = {},", lua_string(&author)));
        }
        lines.push(format!(
            "      hidden = {},",
            lua_bool(mod_item.hidden.unwrap_or(false))
        ));
        lines.push(format!(
            "      favorite = {},",
            lua_bool(mod_item.favorite.unwrap_or(false))
        ));
        if let Some(version) = mod_item
            .version
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!("      version = {},", lua_string(version)));
        }
        if let Some(version) = mod_item
            .version_min
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!("      version_min = {},", lua_string(version)));
        }
        if let Some(version) = mod_item
            .version_max
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!("      version_max = {},", lua_string(version)));
        }
        if let Some(install_date) = mod_item
            .install_date
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            if let Ok(parsed) = DateTime::parse_from_rfc3339(install_date) {
                lines.push(format!("      install_date = {},", parsed.timestamp()));
            }
        }
        if let Some(url) = mod_item
            .url
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!("      url = {},", lua_string(url)));
        }
        if let Some(values) = mod_item.requires.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      requires = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.dependencies.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      dependencies = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.load_after.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      load_after = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.load_before.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      load_before = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.incompatible.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      incompatible = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.packs.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      packs = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.tiledefs.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      tiledefs = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.soundbanks.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      soundbanks = {},", lua_string_list(values)));
        }
        if let Some(worldmap) = mod_item
            .worldmap
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!("      worldmap = {},", lua_string(worldmap)));
        }
        if let Some(preview) = mod_item
            .preview_image_path
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!(
                "      preview_image_path = {},",
                lua_string(preview)
            ));
        }
        if let Some(values) = mod_item.required_by.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!(
                "      required_by = {},",
                lua_required_by_list(values)
            ));
        }
        if let Some(JsonValue::Object(map)) = workshop_meta.as_ref() {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            for field in keys {
                if let Some(field_value) = map.get(field) {
                    if *field == "creator_url" {
                        if let Some(url) = field_value.as_str() {
                            let trimmed = url.trim();
                            if !trimmed.is_empty() {
                                let appended = if trimmed.contains("appid=108600") {
                                    trimmed.to_string()
                                } else {
                                    format!("{}?appid=108600", trimmed)
                                };
                                lines.push(format!(
                                    "      {} = {},",
                                    lua_key(field),
                                    lua_string(&appended)
                                ));
                                continue;
                            }
                        }
                    }
                    lines.push(format!(
                        "      {} = {},",
                        lua_key(field),
                        lua_json(field_value)
                    ));
                }
            }
        }
        lines.push("    },".to_string());
    }
    lines.push("  }".to_string());
    lines.push("}".to_string());
    fs::write(&path, lines.join("\n")).map_err(|e| e.to_string())?;

    Ok(HonuModsDbResult {
        created,
        path: path.to_string_lossy().to_string(),
    })
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
            cmd.arg("/select,").arg(file);
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
    }))
    .map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

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
        if trimmed.to_lowercase().starts_with("mod=") && trimmed.contains(mod_id) {
            *line = String::new();
            updated = true;
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
    let path = Path::new(&user_dir)
        .join("Saves")
        .join(&rel_dir)
        .join("mods.txt");
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
                .filter(|chunk| !chunk.is_empty() && chunk != mod_id)
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
        if !lines.is_empty() && !lines.last().unwrap().trim().is_empty() {
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
            validate_pz_workshop_path,
            scan_mod_folder,
            list_save_player_dbs,
            list_media_script_files,
            extract_player_death_cause_from_blob,
            apply_player_death_cause_to_blob,
            extract_player_blob_text,
            export_player_db_json,
            backup_file,
            read_text_file,
            write_text_file,
            copy_file,
            truncate_text_file,
            get_default_zomboid_user_dir,
            list_server_names,
            delete_server_files,
            list_save_mods_files,
            analyze_mod_loadout,
            plan_server_preset,
            write_server_preset,
            plan_singleplayer_save_mods,
            write_singleplayer_save_mods,
            list_project_zomboid_music_ogg,
            has_ogg_files,
            ensure_honu_mods_db,
            open_mod_in_explorer,
            export_store_snapshot,
            remove_mod_from_active_mods,
            remove_mod_from_pz_modlist_settings,
            upsert_pz_modlist_settings_preset,
            remove_pz_modlist_settings_preset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
