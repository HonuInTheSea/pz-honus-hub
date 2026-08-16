use crate::pz_compat::validate_server_name;
use crate::utils::safe_relative_path;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Utc};
use rayon::prelude::*;
use rusqlite::{Connection, OpenFlags, params};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Cursor as IoCursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock};
use walkdir::WalkDir;

const WORLD_VERSION_B42: i32 = 249;
const CHARACTER_STATS: [&str; 24] = [
    "Anger",
    "Boredom",
    "Discomfort",
    "Endurance",
    "Fatigue",
    "Fitness",
    "FoodSickness",
    "Hunger",
    "Idleness",
    "Intoxication",
    "Morale",
    "NicotineWithdrawal",
    "Pain",
    "Panic",
    "Poison",
    "Sanity",
    "Sickness",
    "Stress",
    "Temperature",
    "Thirst",
    "Unhappiness",
    "Wetness",
    "ZombieFever",
    "ZombieInfection",
];

const BODY_PARTS: [&str; 17] = [
    "Hand_L",
    "Hand_R",
    "ForeArm_L",
    "ForeArm_R",
    "UpperArm_L",
    "UpperArm_R",
    "Torso_Upper",
    "Torso_Lower",
    "Head",
    "Neck",
    "Groin",
    "UpperLeg_L",
    "UpperLeg_R",
    "LowerLeg_L",
    "LowerLeg_R",
    "Foot_L",
    "Foot_R",
];

const SKILL_CATEGORIES: [(&str, &[&str]); 6] = [
    ("Combat - Firearms", &["Aiming", "Reloading"]),
    (
        "Combat - Melee",
        &[
            "Axe",
            "LongBlade",
            "Blunt",
            "Maintenance",
            "SmallBlade",
            "SmallBlunt",
            "Spear",
        ],
    ),
    (
        "Crafting",
        &[
            "Blacksmith",
            "Carpentry",
            "Carving",
            "Cooking",
            "Electricity",
            "Glassmaking",
            "FlintKnapping",
            "Masonry",
            "Mechanics",
            "Pottery",
            "Tailoring",
            "MetalWelding",
        ],
    ),
    ("Farming", &["Farming", "Husbandry", "Butchering"]),
    (
        "Physical",
        &[
            "Fitness",
            "Lightfooted",
            "Nimble",
            "Sprinting",
            "Sneaking",
            "Strength",
        ],
    ),
    (
        "Survival",
        &[
            "Doctor",
            "Fishing",
            "PlantScavenging",
            "Tracking",
            "Trapping",
        ],
    ),
];

fn skill_category(id: &str) -> String {
    SKILL_CATEGORIES
        .iter()
        .find(|(_, skills)| skills.iter().any(|skill| skill.eq_ignore_ascii_case(id)))
        .map(|(category, _)| (*category).to_string())
        .unwrap_or_else(|| "Other".to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSaveSlot {
    pub relative_path: String,
    pub mode: String,
    pub save_name: String,
    pub modified_at: Option<String>,
    pub file_count: usize,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveMapMarker {
    pub id: String,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub saved_at: Option<String>,
    pub relative_path: String,
    pub save_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSummary {
    pub id: i64,
    pub name: String,
    pub source: String,
    pub is_dead: bool,
    pub world_version: i32,
    pub world_x: i32,
    pub world_y: i32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSkill {
    pub id: String,
    pub category: String,
    pub level: i32,
    pub xp: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterBodyPart {
    pub id: String,
    pub health: f32,
    pub cut: bool,
    pub bitten: bool,
    pub scratched: bool,
    pub bandaged: bool,
    pub bleeding: bool,
    pub deep_wounded: bool,
    pub fake_infected: bool,
    pub infected: bool,
    pub infected_wound: bool,
    pub wetness: f32,
    pub stiffness: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterTemperature {
    pub core_temperature: Option<f32>,
    pub body_heat_generation: Option<f32>,
    pub body_heat_real: Option<f32>,
    pub core_heat_delta: Option<f32>,
    pub skin_temperature: Option<f32>,
    pub body_response: Option<f32>,
    pub insulation: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterProtection {
    pub id: String,
    pub bite: Option<f32>,
    pub scratch: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterInfo {
    pub weight: Option<f32>,
    pub hours_survived: Option<f64>,
    pub zombies_killed: Option<i32>,
    pub known_recipes: usize,
    pub known_media: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterStatValue {
    pub id: String,
    #[serde(default)]
    pub label: String,
    pub value: f32,
    #[serde(default)]
    pub moodle_icon: Option<CharacterRenderAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterBodyPartUpdate {
    pub id: String,
    pub health: f32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterEditPayload {
    pub stats: Vec<CharacterStatValue>,
    pub body_parts: Vec<CharacterBodyPartUpdate>,
    pub skills: Vec<CharacterSkill>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterVisuals {
    pub gender: String,
    pub skin_color: Option<String>,
    pub hair_color: Option<String>,
    pub beard_color: Option<String>,
    pub skin_texture: Option<String>,
    pub hair_model: Option<String>,
    pub beard_model: Option<String>,
    pub body_hair_index: Option<i8>,
    pub clothing: Vec<String>,
    pub gear: Vec<String>,
    pub items: Vec<CharacterVisualItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterVisualItem {
    pub full_type: String,
    pub clothing_name: Option<String>,
    pub alternate_model: Option<String>,
    pub base_texture: Option<i8>,
    pub texture_choice: Option<i8>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRenderAsset {
    pub id: String,
    pub path: String,
    pub data_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterTrait {
    pub id: String,
    pub label: String,
    pub category: String,
    pub description: Option<String>,
    pub cost: Option<i32>,
    pub icon: Option<CharacterRenderAsset>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterCustomizationOption {
    pub id: String,
    pub label: String,
    pub slot: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterCustomizationOptions {
    pub hair_models: Vec<CharacterCustomizationOption>,
    pub beard_models: Vec<CharacterCustomizationOption>,
    pub clothing: Vec<CharacterCustomizationOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRenderAssets {
    pub models: Vec<CharacterRenderAsset>,
    pub textures: Vec<CharacterRenderAsset>,
    pub clothing_layers: Vec<CharacterRenderLayer>,
    pub animations: Vec<CharacterRenderAsset>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterRenderLayer {
    pub item_key: String,
    pub model_id: Option<String>,
    pub attach_bone: Option<String>,
    pub texture_ids: Vec<String>,
    pub selected_texture: Option<usize>,
    pub mask_texture_ids: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct StyleDefinition {
    model: Option<String>,
    texture: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterDetails {
    pub summary: CharacterSummary,
    pub forename: Option<String>,
    pub surname: Option<String>,
    pub profession: Option<String>,
    pub profession_icon: Option<CharacterRenderAsset>,
    pub traits: Vec<CharacterTrait>,
    pub skills: Vec<CharacterSkill>,
    pub stats: Vec<CharacterStatValue>,
    pub info: CharacterInfo,
    pub health: Vec<CharacterBodyPart>,
    pub temperature: CharacterTemperature,
    pub protection: Vec<CharacterProtection>,
    pub visuals: CharacterVisuals,
    pub inventory_count: usize,
    pub readable_strings: Vec<String>,
    pub binary_size: usize,
    pub preview_svg: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CharacterSaveSnapshot {
    pub relative_path: String,
    pub mode: String,
    pub save_name: String,
    pub modified_at: Option<String>,
    pub file_count: usize,
    pub size_bytes: u64,
    pub characters: Vec<CharacterDetails>,
}

#[derive(Debug)]
struct RawCharacter {
    summary: CharacterSummary,
    data: Vec<u8>,
}

#[derive(Debug, Default)]
struct ClothingProtectionDefinition {
    covered_parts: Vec<String>,
    bite: f32,
    scratch: f32,
}

#[derive(Debug, Default)]
struct ClothingProtectionIndex {
    definitions: HashMap<String, ClothingProtectionDefinition>,
}

struct Cursor<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Cursor<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len().saturating_sub(self.position)
    }

    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .position
            .checked_add(count)
            .ok_or_else(|| "Character data offset overflowed.".to_string())?;
        if end > self.bytes.len() {
            return Err("Character data is truncated.".to_string());
        }
        let result = &self.bytes[self.position..end];
        self.position = end;
        Ok(result)
    }

    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn i8(&mut self) -> Result<i8, String> {
        Ok(self.u8()? as i8)
    }

    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn i16(&mut self) -> Result<i16, String> {
        Ok(i16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }

    fn i32(&mut self) -> Result<i32, String> {
        Ok(i32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }

    fn i64(&mut self) -> Result<i64, String> {
        Ok(i64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }

    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_bits(u64::from_be_bytes(
            self.take(8)?.try_into().unwrap(),
        )))
    }

    fn f32(&mut self) -> Result<f32, String> {
        Ok(f32::from_bits(u32::from_be_bytes(
            self.take(4)?.try_into().unwrap(),
        )))
    }

    fn string(&mut self) -> Result<String, String> {
        let byte_count = self.u16()? as usize;
        if byte_count == 0 {
            return Ok(String::new());
        }
        String::from_utf8(self.take(byte_count)?.to_vec())
            .map_err(|_| "Character data contains invalid UTF-8.".to_string())
    }

    fn string_lossy(&mut self) -> Result<String, String> {
        let byte_count = self.u16()? as usize;
        Ok(String::from_utf8_lossy(self.take(byte_count)?).into_owned())
    }

    fn string8(&mut self) -> Result<String, String> {
        let byte_count = self.u8()? as usize;
        Ok(String::from_utf8_lossy(self.take(byte_count)?).into_owned())
    }
}

#[tauri::command]
pub fn list_character_save_slots(
    zomboid_user_dir: String,
) -> Result<Vec<CharacterSaveSlot>, String> {
    let saves_root = saves_root(&zomboid_user_dir)?;
    let mut slots = Vec::new();
    let mut seen = BTreeSet::new();

    for entry in WalkDir::new(&saves_root).follow_links(false) {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().is_file() || entry.file_name() != "players.db" {
            continue;
        }

        let save_dir = save_directory_for_database(&saves_root, entry.path())?;
        let relative_path = save_dir
            .strip_prefix(&saves_root)
            .map_err(|error| error.to_string())?;
        let relative_path_text = path_to_relative_string(relative_path);
        if !seen.insert(relative_path_text.clone()) {
            continue;
        }
        let (file_count, size_bytes, modified_at) = directory_summary(&save_dir)?;
        let components = relative_path
            .components()
            .map(|component| component.as_os_str().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let mode = components
            .first()
            .cloned()
            .unwrap_or_else(|| "Saves".to_string());
        let save_name = components
            .last()
            .cloned()
            .unwrap_or_else(|| save_dir.display().to_string());

        slots.push(CharacterSaveSlot {
            relative_path: relative_path_text,
            mode,
            save_name,
            modified_at,
            file_count,
            size_bytes,
        });
    }

    slots.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });
    Ok(slots)
}

#[tauri::command]
pub fn list_save_map_markers(zomboid_user_dir: String) -> Result<Vec<SaveMapMarker>, String> {
    let saves_root = saves_root(&zomboid_user_dir)?;
    if !saves_root.is_dir() {
        return Ok(Vec::new());
    }

    let mut markers = Vec::new();
    for entry in WalkDir::new(&saves_root).follow_links(false) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() || entry.file_name() != "players.db" {
            continue;
        }

        let save_dir = match save_directory_for_database(&saves_root, entry.path()) {
            Ok(path) => path,
            Err(_) => continue,
        };
        let relative_path = match save_dir.strip_prefix(&saves_root) {
            Ok(path) => path_to_relative_string(path),
            Err(_) => continue,
        };
        let save_name = relative_path
            .rsplit('/')
            .find(|part| !part.is_empty())
            .unwrap_or("Save")
            .to_string();
        let saved_at = fs::metadata(entry.path())
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(|time| DateTime::<Utc>::from(time).to_rfc3339());

        let characters = match read_raw_characters(entry.path()) {
            Ok(characters) => characters,
            Err(_) => continue,
        };
        for character in characters {
            let summary = character.summary;
            if !summary.x.is_finite() || !summary.y.is_finite() {
                continue;
            }
            markers.push(SaveMapMarker {
                id: format!("save:{}:{}:{}", relative_path, summary.source, summary.id),
                name: summary.name,
                x: summary.x,
                y: summary.y,
                saved_at: saved_at.clone(),
                relative_path: relative_path.clone(),
                save_name: save_name.clone(),
            });
        }
    }

    markers.sort_by(|left, right| {
        right
            .saved_at
            .cmp(&left.saved_at)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(markers)
}

#[tauri::command]
pub fn read_character_save(
    zomboid_user_dir: String,
    save_relative_path: String,
    zomboid_game_dir: Option<String>,
) -> Result<CharacterSaveSnapshot, String> {
    let saves_root = saves_root(&zomboid_user_dir)?;
    let save_dir = safe_relative_path(&saves_root, &save_relative_path)?;
    ensure_save_directory(&saves_root, &save_dir)?;
    let game_dir = zomboid_game_dir.as_deref().map(Path::new);
    build_snapshot(&saves_root, &save_dir, &save_relative_path, game_dir)
}

#[tauri::command]
pub fn copy_character_save(
    zomboid_user_dir: String,
    save_relative_path: String,
    destination_name: String,
) -> Result<String, String> {
    let saves_root = saves_root(&zomboid_user_dir)?;
    let source = safe_relative_path(&saves_root, &save_relative_path)?;
    ensure_save_directory(&saves_root, &source)?;
    let destination_name = validate_server_name(&destination_name)?.to_string();
    let parent = source
        .parent()
        .ok_or_else(|| "Selected save directory has no parent.".to_string())?;
    let destination = parent.join(destination_name);
    if destination.exists() {
        return Err("A save directory with that name already exists.".to_string());
    }

    copy_directory(&source, &destination)?;
    let relative = destination
        .strip_prefix(&saves_root)
        .map_err(|error| error.to_string())?;
    Ok(path_to_relative_string(relative))
}

#[tauri::command]
pub fn delete_character_save(
    zomboid_user_dir: String,
    save_relative_path: String,
) -> Result<(), String> {
    let saves_root = saves_root(&zomboid_user_dir)?;
    let save_dir = safe_relative_path(&saves_root, &save_relative_path)?;
    let canonical_root = saves_root
        .canonicalize()
        .map_err(|error| format!("Unable to access Saves: {error}"))?;
    let canonical_save = save_dir
        .canonicalize()
        .map_err(|error| format!("Unable to access selected save directory: {error}"))?;
    if canonical_save == canonical_root {
        return Err("The Saves root cannot be deleted.".to_string());
    }
    if !canonical_save.starts_with(&canonical_root) {
        return Err("Selected save directory must remain inside Saves.".to_string());
    }
    ensure_save_directory(&canonical_root, &canonical_save)?;
    fs::remove_dir_all(&canonical_save)
        .map_err(|error| format!("Unable to delete save directory: {error}"))
}

#[tauri::command]
pub fn save_character_stats(
    zomboid_user_dir: String,
    save_relative_path: String,
    source: String,
    character_id: i64,
    edits: CharacterEditPayload,
    zomboid_game_dir: Option<String>,
) -> Result<CharacterSaveSnapshot, String> {
    let saves_root = saves_root(&zomboid_user_dir)?;
    let save_dir = safe_relative_path(&saves_root, &save_relative_path)?;
    ensure_save_directory(&saves_root, &save_dir)?;
    let table = match source.as_str() {
        "localPlayers" => "localPlayers",
        "networkPlayers" => "networkPlayers",
        _ => return Err("Character source is invalid.".to_string()),
    };
    let database = players_database(&save_dir)?;
    let connection = Connection::open(&database)
        .map_err(|error| format!("Unable to open players.db for writing: {error}"))?;
    let query = format!("SELECT name, worldversion, data FROM {table} WHERE id = ?1");
    let (name, world_version, mut data): (String, i32, Vec<u8>) = connection
        .query_row(&query, params![character_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|error| format!("Unable to find character data: {error}"))?;
    let world_version = if (1..=4096).contains(&world_version) {
        world_version
    } else {
        WORLD_VERSION_B42
    };
    let offsets = find_edit_offsets(&data, &name, world_version)?;
    if offsets.stats.len() != CHARACTER_STATS.len() {
        return Err(
            "The selected character does not contain a complete B42.20 stat block.".to_string(),
        );
    }
    for update in edits.stats {
        if let Some(index) = CHARACTER_STATS.iter().position(|id| *id == update.id) {
            if !update.value.is_finite() {
                return Err(format!("Stat {} must be a finite number.", update.id));
            }
            let bytes = update.value.to_bits().to_be_bytes();
            let end = offsets.stats[index]
                .checked_add(bytes.len())
                .ok_or_else(|| "Stat offset overflowed.".to_string())?;
            if end > data.len() {
                return Err("Stat data is truncated.".to_string());
            }
            data[offsets.stats[index]..end].copy_from_slice(&bytes);
        }
    }
    for update in edits.body_parts {
        let Some(index) = BODY_PARTS.iter().position(|id| *id == update.id) else {
            continue;
        };
        if !update.health.is_finite() {
            return Err(format!(
                "Body part {} health must be a finite number.",
                update.id
            ));
        }
        let value = update.health.clamp(0.0, 100.0);
        let bytes = value.to_bits().to_be_bytes();
        let end = offsets.body_health[index]
            .checked_add(bytes.len())
            .ok_or_else(|| "Body health offset overflowed.".to_string())?;
        if end > data.len() {
            return Err("Body health data is truncated.".to_string());
        }
        data[offsets.body_health[index]..end].copy_from_slice(&bytes);
    }
    for update in edits.skills {
        let Some(offset) = offsets.skill_levels.get(&update.id) else {
            continue;
        };
        let value = update.level.clamp(0, 10);
        let end = offset
            .checked_add(std::mem::size_of::<i32>())
            .ok_or_else(|| "Skill level offset overflowed.".to_string())?;
        if end > data.len() {
            return Err("Skill level data is truncated.".to_string());
        }
        data[*offset..end].copy_from_slice(&value.to_be_bytes());
    }
    let update = format!("UPDATE {table} SET data = ?1 WHERE id = ?2");
    connection
        .execute(&update, params![data, character_id])
        .map_err(|error| format!("Unable to save character stats: {error}"))?;
    drop(connection);
    let game_dir = zomboid_game_dir.as_deref().map(Path::new);
    build_snapshot(&saves_root, &save_dir, &save_relative_path, game_dir)
}

/// Loads only the game assets required by the selected survivor. Keeping path
/// resolution in Rust prevents the webview from reading arbitrary local files
/// and mirrors Project Zomboid's media-relative asset lookup.
#[tauri::command]
pub fn load_character_render_assets(
    zomboid_game_dir: String,
    visuals: CharacterVisuals,
) -> Result<CharacterRenderAssets, String> {
    let game_dir = Path::new(zomboid_game_dir.trim())
        .canonicalize()
        .map_err(|error| format!("Unable to access the Project Zomboid game directory: {error}"))?;
    if !game_dir.join("media").is_dir() {
        return Err(
            "The selected directory does not contain Project Zomboid media assets.".to_string(),
        );
    }

    let index = cached_media_asset_index(&game_dir)?;
    let mut models = Vec::new();
    let mut textures = Vec::new();
    let mut warnings = Vec::new();
    let mut model_paths = BTreeMap::<String, PathBuf>::new();
    let mut texture_paths = BTreeMap::<String, PathBuf>::new();
    let mut clothing_layers = Vec::new();

    let body_model = if visuals.gender.eq_ignore_ascii_case("female") {
        "media/models_X/Skinned/FemaleBody.x"
    } else {
        "media/models_X/Skinned/MaleBody.x"
    };
    add_model_path(&index, &mut model_paths, "body", body_model, &mut warnings);

    if let Some(model) = visuals.hair_model.as_deref() {
        let style = find_style_definition(
            &game_dir,
            model,
            true,
            visuals.gender.eq_ignore_ascii_case("female"),
        );
        let resolved_model = style.model.as_deref().unwrap_or(model);
        add_resolved_model(
            &index,
            &mut model_paths,
            "hair",
            resolved_model,
            &mut warnings,
        );
        if let Some(texture) = style.texture.as_deref() {
            add_texture_path(&index, &mut texture_paths, "hair", texture, &mut warnings);
        }
    }
    if let Some(model) = visuals.beard_model.as_deref() {
        let style = find_style_definition(&game_dir, model, false, false);
        let resolved_model = style.model.as_deref().unwrap_or(model);
        add_resolved_model(
            &index,
            &mut model_paths,
            "beard",
            resolved_model,
            &mut warnings,
        );
        if let Some(texture) = style.texture.as_deref() {
            add_texture_path(&index, &mut texture_paths, "hair", texture, &mut warnings);
        }
    }

    for (item_index, item) in visuals.items.iter().enumerate() {
        let Some(clothing_name) = item
            .clothing_name
            .as_deref()
            .or_else(|| item.full_type.split_once('.').map(|(_, name)| name))
        else {
            continue;
        };
        let xml_key = format!("media/clothing/clothingItems/{}.xml", clothing_name.trim());
        let Some(xml_path) = index.find(&xml_key) else {
            continue;
        };
        let xml = fs::read_to_string(xml_path).unwrap_or_default();
        let model_tag = if visuals.gender.eq_ignore_ascii_case("female") {
            "m_FemaleModel"
        } else {
            "m_MaleModel"
        };
        let model_id = format!("clothing-{item_index}");
        let model = xml_tag_values(&xml, model_tag)
            .into_iter()
            .find(|value| !value.is_empty())
            .or_else(|| item.alternate_model.clone());
        if let Some(model) = model {
            add_resolved_model(&index, &mut model_paths, &model_id, &model, &mut warnings);
        }
        let mut texture_ids = Vec::new();
        let mut texture_names = xml_tag_values(&xml, "m_BaseTextures");
        texture_names.extend(xml_tag_values(&xml, "textureChoices"));
        for (texture_index, texture) in texture_names.into_iter().enumerate() {
            let id = format!("clothing-texture-{item_index}-{texture_index}");
            add_texture_path(&index, &mut texture_paths, &id, &texture, &mut warnings);
            if texture_paths.contains_key(&id) {
                texture_ids.push(id);
            }
        }
        let mut mask_names = xml_tag_values(&xml, "m_Masks")
            .into_iter()
            .filter_map(|value| character_mask_name(value.parse::<usize>().ok()?))
            .map(str::to_string)
            .collect::<Vec<_>>();
        if mask_names.is_empty() {
            mask_names = heuristic_overlay_masks(clothing_name);
        }
        let mut mask_texture_ids = Vec::new();
        let mask_folder = xml_tag_value(&xml, "m_MasksFolder")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "media/textures/Body/Masks".to_string());
        for (mask_index, mask_name) in mask_names.into_iter().enumerate() {
            let id = format!("clothing-mask-{item_index}-{mask_index}");
            add_texture_path(
                &index,
                &mut texture_paths,
                &id,
                &format!("{mask_folder}/{mask_name}"),
                &mut warnings,
            );
            if texture_paths.contains_key(&id) {
                mask_texture_ids.push(id);
            }
        }
        let item_key = if item.full_type.is_empty() {
            clothing_name.to_string()
        } else {
            item.full_type.clone()
        };
        let attach_bone = xml_tag_values(&xml, "m_AttachBone")
            .into_iter()
            .find(|value| !value.is_empty());
        clothing_layers.push(CharacterRenderLayer {
            item_key,
            model_id: model_paths
                .contains_key(&model_id)
                .then_some(model_id.clone()),
            attach_bone,
            texture_ids,
            selected_texture: item
                .texture_choice
                .or(item.base_texture)
                .and_then(|value| (value >= 0).then_some(value as usize)),
            mask_texture_ids,
        });
    }

    let skin_name = visuals
        .skin_texture
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            if visuals.gender.eq_ignore_ascii_case("female") {
                "FemaleBody01".to_string()
            } else {
                "MaleBody01a".to_string()
            }
        });
    let skin_name = if visuals.gender.eq_ignore_ascii_case("male")
        && !skin_name.to_ascii_lowercase().ends_with('a')
    {
        format!("{skin_name}a")
    } else {
        skin_name
    };
    add_texture_path(
        &index,
        &mut texture_paths,
        "skin",
        &format!("Body/{skin_name}"),
        &mut warnings,
    );
    if !texture_paths.contains_key("hair") {
        add_texture_path(
            &index,
            &mut texture_paths,
            "hair",
            "F_Hair_White",
            &mut warnings,
        );
    }

    let model_results = model_paths
        .into_par_iter()
        .map(|(id, path)| {
            let asset = encode_render_asset(&game_dir, &id, &path, "text/plain")?;
            let model_textures = fs::read_to_string(&path)
                .ok()
                .map(|contents| {
                    x_texture_names(&contents)
                        .into_iter()
                        .map(|texture| (format!("model-texture-{id}-{texture}"), texture))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Ok::<_, String>((asset, model_textures))
        })
        .collect::<Vec<_>>();
    for result in model_results {
        let (asset, model_textures) = result?;
        models.push(asset);
        for (texture_id, texture) in model_textures {
            add_optional_texture_path(&index, &mut texture_paths, &texture_id, &texture);
        }
    }
    let texture_results = texture_paths
        .into_par_iter()
        .map(|(id, path)| {
            let mime = if path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
            {
                "image/png"
            } else {
                "application/octet-stream"
            };
            encode_render_asset(&game_dir, &id, &path, mime)
        })
        .collect::<Vec<_>>();
    for result in texture_results {
        textures.push(result?);
    }

    let mut animations = Vec::new();
    for (id, requested) in [
        ("idle", "media/anims_X/Bob/Bob_Idle.X"),
        ("walk", "media/anims_X/Bob/Bob_Walk.x"),
        ("run", "media/anims_X/Bob/Bob_Run.X"),
        ("sit", "media/anims_X/Bob/Bob_SitGround_Idle.X"),
    ] {
        if let Some(path) = index.find(requested) {
            animations.push(encode_render_asset(&game_dir, id, path, "text/plain")?);
        } else {
            warnings.push(format!("Animation asset was not found: {requested}"));
        }
    }

    Ok(CharacterRenderAssets {
        models,
        textures,
        clothing_layers,
        animations,
        warnings,
    })
}

/// Returns the same style and clothing choices exposed by the in-game
/// character customizer, using the installed Build 42.20 XML definitions.
#[tauri::command]
pub fn load_character_customization_options(
    zomboid_game_dir: String,
    gender: String,
) -> Result<CharacterCustomizationOptions, String> {
    let game_dir = Path::new(zomboid_game_dir.trim())
        .canonicalize()
        .map_err(|error| format!("Unable to access the Project Zomboid game directory: {error}"))?;
    if !game_dir.join("media").is_dir() {
        return Err(
            "The selected directory does not contain Project Zomboid media assets.".to_string(),
        );
    }
    let female = gender.eq_ignore_ascii_case("female");
    Ok(CharacterCustomizationOptions {
        hair_models: list_style_options(&game_dir, true, female),
        beard_models: list_style_options(&game_dir, false, false),
        clothing: list_clothing_options(&game_dir),
    })
}

#[derive(Debug, Clone)]
struct MediaAssetIndex {
    files: HashMap<String, PathBuf>,
}

static MEDIA_INDEX_CACHE: OnceLock<RwLock<HashMap<PathBuf, Arc<MediaAssetIndex>>>> =
    OnceLock::new();

fn cached_media_asset_index(game_dir: &Path) -> Result<Arc<MediaAssetIndex>, String> {
    let cache = MEDIA_INDEX_CACHE.get_or_init(|| RwLock::new(HashMap::new()));
    if let Some(index) = cache
        .read()
        .map_err(|_| "Media asset cache is unavailable.".to_string())?
        .get(game_dir)
        .cloned()
    {
        return Ok(index);
    }
    let built = Arc::new(MediaAssetIndex::build(game_dir)?);
    let mut entries = cache
        .write()
        .map_err(|_| "Media asset cache is unavailable.".to_string())?;
    Ok(entries
        .entry(game_dir.to_path_buf())
        .or_insert_with(|| built.clone())
        .clone())
}

impl MediaAssetIndex {
    fn build(game_dir: &Path) -> Result<Self, String> {
        let media = game_dir.join("media");
        let mut files = HashMap::new();
        for entry in WalkDir::new(&media).follow_links(false) {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(game_dir)
                .map_err(|error| error.to_string())?;
            files.insert(normalize_asset_key(relative), entry.path().to_path_buf());
        }
        Ok(Self { files })
    }

    fn find(&self, requested: &str) -> Option<&PathBuf> {
        let key = normalize_asset_key(Path::new(requested));
        if let Some(path) = self.files.get(&key) {
            return Some(path);
        }
        let key = key.strip_prefix("media/").unwrap_or(&key);
        self.files
            .iter()
            .find(|(candidate, _)| candidate.strip_prefix("media/").unwrap_or(candidate) == key)
            .map(|(_, path)| path)
    }

    fn find_texture(&self, requested: &str) -> Option<&PathBuf> {
        if let Some(path) = self.find(requested) {
            return Some(path);
        }
        let basename = requested
            .replace('\\', "/")
            .rsplit('/')
            .next()
            .unwrap_or(requested)
            .to_ascii_lowercase();
        self.files
            .iter()
            .find(|(candidate, _)| {
                candidate.ends_with(&format!("/textures/{basename}"))
                    || candidate.ends_with(&format!("/{basename}"))
            })
            .map(|(_, path)| path)
    }
}

fn normalize_asset_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_ascii_lowercase()
}

fn add_model_path(
    index: &MediaAssetIndex,
    paths: &mut BTreeMap<String, PathBuf>,
    id: &str,
    requested: &str,
    warnings: &mut Vec<String>,
) {
    let Some(path) = index.find(requested) else {
        warnings.push(format!("Model asset was not found: {requested}"));
        return;
    };
    paths.entry(id.to_string()).or_insert_with(|| path.clone());
}

fn add_resolved_model(
    index: &MediaAssetIndex,
    paths: &mut BTreeMap<String, PathBuf>,
    id: &str,
    requested: &str,
    warnings: &mut Vec<String>,
) {
    let mut value = requested
        .trim()
        .replace('\\', "/")
        .trim_start_matches("x:")
        .to_string();
    let candidates = if value.to_ascii_lowercase().starts_with("media/") {
        vec![value.clone()]
    } else if value.to_ascii_lowercase().starts_with("skinned/") {
        value = format!("media/models_X/{value}");
        vec![value.clone()]
    } else {
        vec![
            format!("media/models_X/{value}"),
            format!("media/models_X/Skinned/Hair/{value}"),
            format!("media/models_X/Skinned/Beards/{value}"),
            format!("media/models_X/Skinned/Clothes/{value}"),
            format!("media/models_X/Skinned/BackPacks/{value}"),
        ]
    };
    for candidate in candidates {
        let Some(path) = find_with_model_extension(index, &candidate) else {
            continue;
        };
        paths.entry(id.to_string()).or_insert(path);
        return;
    }
    warnings.push(format!(
        "Model asset was not found for visual '{requested}'"
    ));
}

fn find_with_model_extension(index: &MediaAssetIndex, requested: &str) -> Option<PathBuf> {
    let requested = requested
        .strip_suffix(".x")
        .or_else(|| requested.strip_suffix(".X"))
        .or_else(|| requested.strip_suffix(".fbx"))
        .or_else(|| requested.strip_suffix(".FBX"))
        .unwrap_or(requested);
    for extension in ["x", "X", "fbx", "FBX"] {
        let candidate = format!("{requested}.{extension}");
        if let Some(path) = index.find(&candidate) {
            return Some(path.clone());
        }
    }
    index.find(requested).cloned()
}

fn add_texture_path(
    index: &MediaAssetIndex,
    paths: &mut BTreeMap<String, PathBuf>,
    id: &str,
    requested: &str,
    warnings: &mut Vec<String>,
) {
    let requested = requested.trim();
    if requested.is_empty() {
        return;
    }
    if let Some(path) = find_texture_path(index, requested) {
        paths.entry(id.to_string()).or_insert_with(|| path.clone());
        return;
    }
    warnings.push(format!("Texture asset was not found: {requested}"));
}

fn add_optional_texture_path(
    index: &MediaAssetIndex,
    paths: &mut BTreeMap<String, PathBuf>,
    id: &str,
    requested: &str,
) {
    if let Some(path) = find_texture_path(index, requested) {
        paths.entry(id.to_string()).or_insert_with(|| path.clone());
    }
}

fn find_texture_path<'a>(index: &'a MediaAssetIndex, requested: &str) -> Option<&'a PathBuf> {
    let requested = requested.trim().replace('\\', "/");
    if requested.is_empty() {
        return None;
    }
    let candidates = [
        requested.clone(),
        format!("media/textures/{requested}"),
        format!("media/textures/{requested}.png"),
        format!(
            "media/textures/{}.png",
            requested.trim_start_matches("media/textures/")
        ),
    ];
    candidates.into_iter().find_map(|candidate| {
        index.find_texture(&candidate).or_else(|| {
            if !candidate.to_ascii_lowercase().ends_with(".png") {
                index.find_texture(&format!("{candidate}.png"))
            } else {
                None
            }
        })
    })
}

fn character_mask_name(index: usize) -> Option<&'static str> {
    [
        "Head",
        "Torso",
        "Pelvis",
        "LeftArm",
        "LeftHand",
        "RightArm",
        "RightHand",
        "LeftLeg",
        "LeftFoot",
        "RightLeg",
        "RightFoot",
        "Dress",
        "Chest",
        "Waist",
        "Belt",
        "Crotch",
    ]
    .get(index)
    .copied()
}

fn heuristic_overlay_masks(name: &str) -> Vec<String> {
    let key = name.to_ascii_lowercase();
    if key.contains("shirt")
        || key.contains("tshirt")
        || key.contains("tanktop")
        || key.contains("vest")
        || key.contains("sweater")
        || key.contains("jumper")
    {
        return ["Chest", "Waist", "LeftArm", "RightArm"]
            .into_iter()
            .map(str::to_string)
            .collect();
    }
    if key.contains("belt") {
        return vec!["Belt".to_string()];
    }
    if key.contains("sock") || key.contains("stocking") {
        return ["LeftLeg", "RightLeg", "LeftFoot", "RightFoot"]
            .into_iter()
            .map(str::to_string)
            .collect();
    }
    if key.contains("shoe") || key.contains("boot") || key.contains("sneaker") {
        return ["LeftFoot", "RightFoot"]
            .into_iter()
            .map(str::to_string)
            .collect();
    }
    if key.contains("trouser") || key.contains("jean") || key.contains("pants") {
        return ["Crotch", "LeftLeg", "RightLeg"]
            .into_iter()
            .map(str::to_string)
            .collect();
    }
    if key.contains("hat")
        || key.contains("bandana")
        || key.contains("beanie")
        || key.contains("mask")
        || key.contains("glass")
    {
        return vec!["Head".to_string()];
    }
    Vec::new()
}

fn xml_tag_values(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut values = Vec::new();
    let mut remaining = xml;
    while let Some(start) = remaining.find(&open) {
        let value_start = start + open.len();
        let Some(end) = remaining[value_start..].find(&close) else {
            break;
        };
        let value = remaining[value_start..value_start + end].trim().to_string();
        values.push(value);
        remaining = &remaining[value_start + end + close.len()..];
    }
    values
}

fn xml_tag_value(xml: &str, tag: &str) -> Option<String> {
    xml_tag_values(xml, tag).into_iter().next()
}

fn find_style_definition(
    game_dir: &Path,
    style_name: &str,
    hair: bool,
    female: bool,
) -> StyleDefinition {
    let path = if hair {
        game_dir.join("media/hairStyles/hairStyles.xml")
    } else {
        game_dir.join("media/hairStyles/beardStyles.xml")
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return StyleDefinition::default();
    };
    let section = if hair {
        if female { "female" } else { "male" }
    } else {
        "style"
    };
    let open = format!("<{section}>");
    let close = format!("</{section}>");
    contents
        .split(&open)
        .skip(1)
        .filter_map(|block| block.split_once(&close).map(|(value, _)| value))
        .find_map(|block| {
            let name = xml_tag_value(block, "name")?;
            name.eq_ignore_ascii_case(style_name)
                .then(|| StyleDefinition {
                    model: xml_tag_value(block, "model"),
                    texture: xml_tag_value(block, "texture"),
                })
        })
        .unwrap_or_default()
}

fn list_style_options(
    game_dir: &Path,
    hair: bool,
    female: bool,
) -> Vec<CharacterCustomizationOption> {
    let path = if hair {
        game_dir.join("media/hairStyles/hairStyles.xml")
    } else {
        game_dir.join("media/hairStyles/beardStyles.xml")
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let section = if hair {
        if female { "female" } else { "male" }
    } else {
        "style"
    };
    let open = format!("<{section}>");
    let close = format!("</{section}>");
    let mut options = contents
        .split(&open)
        .skip(1)
        .filter_map(|block| block.split_once(&close).map(|(value, _)| value))
        .filter_map(|block| {
            let name = xml_tag_value(block, "name")?;
            Some(CharacterCustomizationOption {
                label: humanize_identifier(&name),
                id: name,
                slot: None,
            })
        })
        .collect::<Vec<_>>();
    options.sort_by_key(|option| option.label.to_ascii_lowercase());
    options.dedup_by(|left, right| left.id.eq_ignore_ascii_case(&right.id));
    options
}

fn clothing_slot(name: &str) -> Option<&'static str> {
    let key = name.to_ascii_lowercase();
    if key.contains("mask") || key.contains("respirator") {
        Some("Mask")
    } else if key.contains("belt") {
        Some("Belt")
    } else if key.contains("hat") || key.contains("bandana") || key.contains("beanie") {
        Some("Hat")
    } else if key.contains("glass") || key.contains("eyewear") {
        Some("Glasses")
    } else if key.contains("vest") {
        Some("Vest")
    } else if key.contains("tshirt") || key.contains("tanktop") {
        Some("T-shirt")
    } else if key.contains("shirt") || key.contains("jumper") || key.contains("sweater") {
        Some("Shirt")
    } else if key.contains("trouser") || key.contains("jean") || key.contains("pants") {
        Some("Pants")
    } else if key.contains("skirt") {
        Some("Skirt")
    } else if key.contains("dress") {
        Some("Dress")
    } else if key.contains("sock") || key.contains("stocking") {
        Some("Socks")
    } else if key.contains("shoe") || key.contains("boot") || key.contains("sneaker") {
        Some("Shoes")
    } else if key.contains("necklace") || key.contains("scarf") {
        Some("Necklace")
    } else {
        None
    }
}

fn list_clothing_options(game_dir: &Path) -> Vec<CharacterCustomizationOption> {
    let root = game_dir.join("media/clothing/clothingItems");
    let mut options = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return options;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file()
            || !path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("xml"))
        {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let Some(slot) = clothing_slot(id) else {
            continue;
        };
        options.push(CharacterCustomizationOption {
            id: id.to_string(),
            label: humanize_identifier(id),
            slot: Some(slot.to_string()),
        });
    }
    options.sort_by(|left, right| {
        left.slot.cmp(&right.slot).then_with(|| {
            left.label
                .to_ascii_lowercase()
                .cmp(&right.label.to_ascii_lowercase())
        })
    });
    options.dedup_by(|left, right| left.id.eq_ignore_ascii_case(&right.id));
    options
}

fn x_texture_names(contents: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut remaining = contents;
    while let Some(start) = remaining.find("TextureFilename") {
        let tail = &remaining[start..];
        let Some(quote_start) = tail.find('"') else {
            break;
        };
        let tail = &tail[quote_start + 1..];
        let Some(quote_end) = tail.find('"') else {
            break;
        };
        let value = tail[..quote_end].trim().to_string();
        if !value.is_empty() && !names.contains(&value) {
            names.push(value);
        }
        remaining = &tail[quote_end + 1..];
    }
    names
}

fn encode_render_asset(
    game_dir: &Path,
    id: &str,
    path: &Path,
    mime: &str,
) -> Result<CharacterRenderAsset, String> {
    if !path.starts_with(game_dir) {
        return Err("Resolved render asset escaped the game directory.".to_string());
    }
    let relative = path
        .strip_prefix(game_dir)
        .map_err(|error| error.to_string())?;
    let bytes = fs::read(path).map_err(|error| format!("Unable to read render asset: {error}"))?;
    Ok(CharacterRenderAsset {
        id: id.to_string(),
        path: normalize_asset_key(relative),
        data_url: format!("data:{mime};base64,{}", BASE64.encode(bytes)),
    })
}

fn saves_root(zomboid_user_dir: &str) -> Result<PathBuf, String> {
    let user_dir = Path::new(zomboid_user_dir.trim());
    if user_dir.as_os_str().is_empty() {
        return Err("Project Zomboid user directory is empty.".to_string());
    }
    Ok(user_dir.join("Saves"))
}

fn ensure_save_directory(saves_root: &Path, save_dir: &Path) -> Result<(), String> {
    if !save_dir.starts_with(saves_root) || !save_dir.is_dir() {
        return Err("Selected save directory does not exist inside Saves.".to_string());
    }
    players_database(save_dir)?;
    Ok(())
}

fn players_database(save_dir: &Path) -> Result<PathBuf, String> {
    if save_dir.join("players.db").is_file() {
        return Ok(save_dir.join("players.db"));
    }
    WalkDir::new(save_dir)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .find(|entry| entry.file_type().is_file() && entry.file_name() == "players.db")
        .map(|entry| entry.into_path())
        .ok_or_else(|| "Selected directory does not contain a nested players.db.".to_string())
}

fn save_directory_for_database(saves_root: &Path, database: &Path) -> Result<PathBuf, String> {
    let mut candidate = database
        .parent()
        .ok_or_else(|| "Player database has no parent directory.".to_string())?;
    loop {
        let relative = candidate
            .strip_prefix(saves_root)
            .map_err(|error| error.to_string())?;
        let component_count = relative.components().count();
        if component_count <= 2 || has_save_marker(candidate) {
            return Ok(candidate.to_path_buf());
        }
        let Some(parent) = candidate.parent() else {
            return Ok(candidate.to_path_buf());
        };
        if parent == candidate {
            return Ok(candidate.to_path_buf());
        }
        candidate = parent;
    }
}

fn has_save_marker(path: &Path) -> bool {
    [
        "map_p.bin",
        "map_meta.bin",
        "world_version.txt",
        "map_zone.bin",
    ]
    .iter()
    .any(|name| path.join(name).is_file())
}

fn directory_summary(path: &Path) -> Result<(usize, u64, Option<String>), String> {
    let mut file_count = 0;
    let mut size_bytes: u64 = 0;
    for entry in WalkDir::new(path).follow_links(false) {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_file() {
            file_count += 1;
            size_bytes =
                size_bytes.saturating_add(entry.metadata().map_err(|e| e.to_string())?.len());
        }
    }
    let modified_at = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(|time| DateTime::<Utc>::from(time).to_rfc3339());
    Ok((file_count, size_bytes, modified_at))
}

#[derive(Debug, Clone, Default)]
struct TraitDefinitionMetadata {
    cost: i32,
    ui_name: Option<String>,
    ui_description: Option<String>,
    xp_boosts: Vec<(String, i32)>,
}

#[derive(Debug, Clone, Default)]
struct ProfessionDefinitionMetadata {
    icon_path: Option<String>,
}

fn fallback_trait(id: &str) -> CharacterTrait {
    CharacterTrait {
        id: id.to_string(),
        label: humanize_identifier(id),
        category: "Trait".to_string(),
        description: None,
        cost: None,
        icon: None,
    }
}

fn build_profession_definition_index(
    game_dir: &Path,
) -> HashMap<String, ProfessionDefinitionMetadata> {
    let path = game_dir.join("media/scripts/generated/characters/character_professions.txt");
    let Ok(contents) = fs::read_to_string(path) else {
        return HashMap::new();
    };

    let mut index = HashMap::new();
    let mut current_id: Option<String> = None;
    let mut current = ProfessionDefinitionMetadata::default();
    for line in contents.lines() {
        let trimmed = line.trim();
        if let Some(header) = trimmed.strip_prefix("character_profession_definition") {
            if let Some(id) = current_id.take() {
                index.insert(id, current.clone());
            }
            current = ProfessionDefinitionMetadata::default();
            current_id = header
                .split_whitespace()
                .next()
                .map(|id| id.trim_start_matches("base:").to_ascii_lowercase());
            continue;
        }
        if trimmed == "}" {
            if let Some(id) = current_id.take() {
                index.insert(id, current.clone());
            }
            current = ProfessionDefinitionMetadata::default();
            continue;
        }
        let Some((key, raw_value)) = trimmed.trim_end_matches(',').split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("IconPathName") {
            current.icon_path = Some(raw_value.trim().trim_matches('"').to_string());
        }
    }
    if let Some(id) = current_id {
        index.insert(id, current);
    }
    index
}

fn humanize_identifier(value: &str) -> String {
    let identifier = value.rsplit_once(':').map_or(value, |(_, id)| id);
    let mut output = String::with_capacity(identifier.len() + 8);
    let mut previous: Option<char> = None;
    for character in identifier.chars() {
        if matches!(character, '_' | '-' | '.') {
            if !output.ends_with(' ') {
                output.push(' ');
            }
        } else if character.is_uppercase()
            && previous.is_some_and(|value| value.is_lowercase())
            && !output.ends_with(' ')
        {
            output.push(' ');
            output.extend(character.to_lowercase());
        } else {
            output.push(character);
        }
        previous = Some(character);
    }

    let mut result = output
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            chars.next().map_or_else(String::new, |first| {
                first
                    .to_uppercase()
                    .chain(chars.flat_map(char::to_lowercase))
                    .collect()
            })
        })
        .collect::<Vec<_>>()
        .join(" ");
    if result.is_empty() {
        result = "Unknown".to_string();
    }
    result
}

fn build_trait_definition_index(game_dir: &Path) -> HashMap<String, TraitDefinitionMetadata> {
    let path = game_dir.join("media/scripts/generated/characters/character_traits.txt");
    let Ok(contents) = fs::read_to_string(path) else {
        return HashMap::new();
    };

    let mut index = HashMap::new();
    let mut current_id: Option<String> = None;
    let mut current = TraitDefinitionMetadata::default();
    for line in contents.lines() {
        let trimmed = line.trim();
        if let Some(header) = trimmed.strip_prefix("character_trait_definition") {
            if let Some(id) = current_id.take() {
                index.insert(id, current.clone());
            }
            current = TraitDefinitionMetadata::default();
            current_id = header
                .split_whitespace()
                .next()
                .map(|id| id.trim_start_matches("base:").to_ascii_lowercase());
            continue;
        }
        if trimmed == "}" {
            if let Some(id) = current_id.take() {
                index.insert(id, current.clone());
            }
            current = TraitDefinitionMetadata::default();
            continue;
        }
        let Some((key, raw_value)) = trimmed.trim_end_matches(',').split_once('=') else {
            continue;
        };
        let value = raw_value.trim().trim_matches('"');
        match key.trim() {
            "Cost" => current.cost = value.parse().unwrap_or_default(),
            "UIName" => current.ui_name = Some(value.to_string()),
            "UIDescription" => current.ui_description = Some(value.to_string()),
            "XPBoosts" => {
                current.xp_boosts = value
                    .split(';')
                    .filter_map(|boost| {
                        let (perk, level) = boost.split_once('=')?;
                        Some((perk.trim().to_string(), level.trim().parse().ok()?))
                    })
                    .collect();
            }
            _ => {}
        }
    }
    if let Some(id) = current_id {
        index.insert(id, current);
    }
    index
}

fn load_english_translations(game_dir: &Path) -> HashMap<String, String> {
    let path = game_dir.join("media/lua/shared/Translate/EN/UI.json");
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<HashMap<String, String>>(&contents).ok())
        .unwrap_or_default()
}

fn trait_category(metadata: &TraitDefinitionMetadata) -> String {
    if metadata.cost >= 0 {
        "Positive trait".to_string()
    } else {
        "Negative trait".to_string()
    }
}

fn trait_description(
    metadata: &TraitDefinitionMetadata,
    translations: &HashMap<String, String>,
) -> Option<String> {
    let mut descriptions = metadata
        .ui_description
        .as_ref()
        .and_then(|key| translations.get(key))
        .map(|description| description.replace("<br>", "\n"))
        .into_iter()
        .collect::<Vec<_>>();

    let mut boosts = metadata.xp_boosts.clone();
    boosts.sort_by_key(|(perk, _)| humanize_identifier(perk));
    descriptions.extend(
        boosts
            .into_iter()
            .map(|(perk, level)| format!("{level:+} {}", humanize_identifier(&perk))),
    );
    (!descriptions.is_empty()).then(|| descriptions.join("\n"))
}

fn moodle_icon_filename(stat_id: &str) -> Option<&'static str> {
    match stat_id.to_ascii_lowercase().as_str() {
        "anger" => Some("Mood_Angry.png"),
        "boredom" => Some("Mood_Bored.png"),
        "discomfort" => Some("Mood_Discomfort.png"),
        "endurance" => Some("Status_DifficultyBreathing.png"),
        "fatigue" => Some("Mood_Sleepy.png"),
        "hunger" => Some("Status_Hunger.png"),
        "intoxication" => Some("Mood_Drunk.png"),
        "pain" => Some("Mood_Pained.png"),
        "panic" => Some("Mood_Panicked.png"),
        "sickness" | "foodsickness" => Some("Mood_Nauseous.png"),
        "stress" => Some("Mood_Stressed.png"),
        "temperature" => Some("Status_TemperatureHot.png"),
        "thirst" => Some("Status_Thirst.png"),
        "unhappiness" => Some("Mood_Sad.png"),
        "wetness" => Some("Status_Wet.png"),
        _ => None,
    }
}

fn resolve_ui_png(game_dir: &Path, id: &str, relative_path: &str) -> Option<CharacterRenderAsset> {
    let path = game_dir.join(relative_path);
    path.is_file()
        .then(|| encode_render_asset(game_dir, id, &path, "image/png").ok())
        .flatten()
}

fn resolve_named_game_icon(
    game_dir: &Path,
    id: &str,
    icon_name: &str,
    pack_bytes: Option<&[u8]>,
) -> Option<CharacterRenderAsset> {
    let icon_name = icon_name.trim();
    if icon_name.is_empty() {
        return None;
    }
    for relative_path in [
        format!("media/ui/{icon_name}.png"),
        format!("media/textures/{icon_name}.png"),
        format!("media/ui/Traits/{icon_name}.png"),
    ] {
        if let Some(asset) = resolve_ui_png(game_dir, id, &relative_path) {
            return Some(asset);
        }
    }
    let Some(bytes) = pack_bytes else {
        return resolve_ui2_pack_icon(game_dir, id, icon_name);
    };
    resolve_pack_icon_bytes(bytes, id, icon_name)
}

#[derive(Debug, Clone, Copy)]
struct PackSubTexture {
    page_data_start: usize,
    page_data_length: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
}

fn pack_i32(bytes: &[u8], offset: &mut usize) -> Option<i32> {
    let end = offset.checked_add(4)?;
    let value = i32::from_le_bytes(bytes.get(*offset..end)?.try_into().ok()?);
    *offset = end;
    Some(value)
}

fn pack_string(bytes: &[u8], offset: &mut usize) -> Option<String> {
    let length = usize::try_from(pack_i32(bytes, offset)?).ok()?;
    let end = offset.checked_add(length)?;
    let value = String::from_utf8_lossy(bytes.get(*offset..end)?).into_owned();
    *offset = end;
    Some(value)
}

fn find_ui2_pack_icon(bytes: &[u8], requested_name: &str) -> Option<PackSubTexture> {
    if bytes.get(0..4)? != b"PZPK" {
        return None;
    }
    let mut offset = 12;
    let page_count =
        usize::try_from(i32::from_le_bytes(bytes.get(8..12)?.try_into().ok()?)).ok()?;
    for _ in 0..page_count {
        let _page_name = pack_string(bytes, &mut offset)?;
        let entry_count = usize::try_from(pack_i32(bytes, &mut offset)?).ok()?;
        let _mask = pack_i32(bytes, &mut offset)?;
        let mut found = None;
        for _ in 0..entry_count {
            let entry_name = pack_string(bytes, &mut offset)?;
            let values = [
                pack_i32(bytes, &mut offset)?,
                pack_i32(bytes, &mut offset)?,
                pack_i32(bytes, &mut offset)?,
                pack_i32(bytes, &mut offset)?,
                pack_i32(bytes, &mut offset)?,
                pack_i32(bytes, &mut offset)?,
                pack_i32(bytes, &mut offset)?,
                pack_i32(bytes, &mut offset)?,
            ];
            if entry_name.eq_ignore_ascii_case(requested_name) {
                found = Some((values, entry_name));
            }
        }
        let png_length = usize::try_from(pack_i32(bytes, &mut offset)?).ok()?;
        let png_start = offset;
        let png_end = png_start.checked_add(png_length)?;
        if let Some((values, _)) = found {
            if values[..4].iter().all(|value| *value >= 0) {
                return Some(PackSubTexture {
                    page_data_start: png_start,
                    page_data_length: png_length,
                    x: values[0] as usize,
                    y: values[1] as usize,
                    width: values[2] as usize,
                    height: values[3] as usize,
                });
            }
        }
        offset = png_end;
    }
    None
}

fn crop_pack_png(bytes: &[u8], texture: PackSubTexture) -> Option<Vec<u8>> {
    let end = texture
        .page_data_start
        .checked_add(texture.page_data_length)?;
    let decoder = png::Decoder::new(IoCursor::new(bytes.get(texture.page_data_start..end)?));
    let mut reader = decoder.read_info().ok()?;
    let mut decoded = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut decoded).ok()?;
    let source = &decoded[..info.buffer_size()];
    let width = usize::try_from(info.width).ok()?;
    let height = usize::try_from(info.height).ok()?;
    let crop_right = texture.x.checked_add(texture.width)?;
    let crop_bottom = texture.y.checked_add(texture.height)?;
    if crop_right > width || crop_bottom > height || texture.width == 0 || texture.height == 0 {
        return None;
    }

    let channels = match info.color_type {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        _ => return None,
    };
    let mut rgba = Vec::with_capacity(texture.width * texture.height * 4);
    for y in texture.y..crop_bottom {
        for x in texture.x..crop_right {
            let source_index = (y * width + x) * channels;
            match channels {
                1 => rgba.extend_from_slice(&[
                    source[source_index],
                    source[source_index],
                    source[source_index],
                    255,
                ]),
                2 => rgba.extend_from_slice(&[
                    source[source_index],
                    source[source_index],
                    source[source_index],
                    source[source_index + 1],
                ]),
                3 => rgba.extend_from_slice(&[
                    source[source_index],
                    source[source_index + 1],
                    source[source_index + 2],
                    255,
                ]),
                4 => rgba.extend_from_slice(&source[source_index..source_index + 4]),
                _ => unreachable!(),
            }
        }
    }

    let mut encoded = Vec::new();
    let mut encoder = png::Encoder::new(&mut encoded, texture.width as u32, texture.height as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.write_header().ok()?.write_image_data(&rgba).ok()?;
    Some(encoded)
}

fn resolve_ui2_pack_icon(
    game_dir: &Path,
    id: &str,
    icon_name: &str,
) -> Option<CharacterRenderAsset> {
    let path = game_dir.join("media/texturepacks/UI2.pack");
    let bytes = fs::read(&path).ok()?;
    resolve_pack_icon_bytes(&bytes, id, icon_name)
}

fn resolve_pack_icon_bytes(
    bytes: &[u8],
    id: &str,
    icon_name: &str,
) -> Option<CharacterRenderAsset> {
    let texture = find_ui2_pack_icon(&bytes, icon_name)?;
    let png = crop_pack_png(&bytes, texture)?;
    Some(CharacterRenderAsset {
        id: id.to_string(),
        path: format!("media/texturepacks/UI2.pack#{icon_name}"),
        data_url: format!("data:image/png;base64,{}", BASE64.encode(png)),
    })
}

fn enrich_character_display_data(
    character: &mut CharacterDetails,
    game_dir: Option<&Path>,
    pack_bytes: Option<&[u8]>,
    trait_definitions: &HashMap<String, TraitDefinitionMetadata>,
    profession_definitions: &HashMap<String, ProfessionDefinitionMetadata>,
    translations: &HashMap<String, String>,
) {
    for stat in &mut character.stats {
        stat.label = humanize_identifier(&stat.id);
        stat.moodle_icon = game_dir.and_then(|game_dir| {
            moodle_icon_filename(&stat.id).and_then(|filename| {
                resolve_ui_png(
                    game_dir,
                    &format!("moodle_{}", stat.id.to_ascii_lowercase()),
                    &format!("media/ui/Moodles/32/{filename}"),
                )
            })
        });
    }

    if let (Some(game_dir), Some(profession)) = (game_dir, character.profession.as_deref()) {
        let key = profession.rsplit_once(':').map_or_else(
            || profession.to_ascii_lowercase(),
            |(_, id)| id.to_ascii_lowercase(),
        );
        if let Some(icon_path) = profession_definitions
            .get(&key)
            .and_then(|definition| definition.icon_path.as_deref())
        {
            character.profession_icon =
                resolve_named_game_icon(game_dir, "profession", icon_path, pack_bytes);
        }
    }

    for trait_value in &mut character.traits {
        let key = trait_value.id.rsplit_once(':').map_or_else(
            || trait_value.id.to_ascii_lowercase(),
            |(_, id)| id.to_ascii_lowercase(),
        );
        let Some(metadata) = trait_definitions.get(&key) else {
            trait_value.label = humanize_identifier(&trait_value.id);
            continue;
        };

        trait_value.category = trait_category(metadata);
        trait_value.cost = Some(metadata.cost);
        trait_value.label = metadata
            .ui_name
            .as_ref()
            .and_then(|key| translations.get(key))
            .cloned()
            .unwrap_or_else(|| humanize_identifier(&trait_value.id));
        trait_value.description = trait_description(metadata, translations);

        if let Some(game_dir) = game_dir {
            let specific_path = format!("media/ui/Traits/trait_{key}.png");
            trait_value.icon = resolve_ui_png(game_dir, &format!("trait_{key}"), &specific_path)
                .or_else(|| {
                    resolve_named_game_icon(
                        game_dir,
                        &format!("trait_{key}"),
                        &format!("trait_{key}"),
                        pack_bytes,
                    )
                })
                .or_else(|| {
                    resolve_named_game_icon(game_dir, "trait_generic", "trait_generic", pack_bytes)
                });
        }
    }

    character.traits.retain(|trait_value| {
        matches!(
            trait_value.category.as_str(),
            "Positive trait" | "Negative trait"
        )
    });
}

fn build_snapshot(
    saves_root: &Path,
    save_dir: &Path,
    requested_relative_path: &str,
    game_dir: Option<&Path>,
) -> Result<CharacterSaveSnapshot, String> {
    let (file_count, size_bytes, modified_at) = directory_summary(save_dir)?;
    let components = requested_relative_path
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let mode = components
        .first()
        .cloned()
        .unwrap_or_else(|| "Saves".to_string());
    let save_name = components
        .last()
        .cloned()
        .unwrap_or_else(|| save_dir.display().to_string());
    let protection_index = game_dir.and_then(|path| build_clothing_protection_index(path).ok());
    let trait_definitions = game_dir
        .map(build_trait_definition_index)
        .unwrap_or_default();
    let profession_definitions = game_dir
        .map(build_profession_definition_index)
        .unwrap_or_default();
    let translations = game_dir.map(load_english_translations).unwrap_or_default();
    let pack_bytes =
        game_dir.and_then(|path| fs::read(path.join("media/texturepacks/UI2.pack")).ok());
    let characters = read_raw_characters(&players_database(save_dir)?)?
        .into_iter()
        .map(|character| {
            let world_version = if (1..=4096).contains(&character.summary.world_version) {
                character.summary.world_version
            } else {
                WORLD_VERSION_B42
            };
            let mut parsed = parse_character(character, world_version)?;
            if let Some(index) = protection_index.as_ref() {
                parsed.protection = protection_for_visuals(&parsed.visuals, index);
            }
            enrich_character_display_data(
                &mut parsed,
                game_dir,
                pack_bytes.as_deref(),
                &trait_definitions,
                &profession_definitions,
                &translations,
            );
            Ok::<CharacterDetails, String>(parsed)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let relative = save_dir
        .strip_prefix(saves_root)
        .map_err(|error| error.to_string())?;
    Ok(CharacterSaveSnapshot {
        relative_path: path_to_relative_string(relative),
        mode,
        save_name,
        modified_at,
        file_count,
        size_bytes,
        characters,
    })
}

fn build_clothing_protection_index(game_dir: &Path) -> Result<ClothingProtectionIndex, String> {
    let scripts = game_dir.join("media/scripts");
    if !scripts.is_dir() {
        return Err("Project Zomboid item scripts were not found.".to_string());
    }

    let mut index = ClothingProtectionIndex::default();
    for entry in WalkDir::new(scripts).follow_links(false) {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().is_file()
            || !entry
                .path()
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("txt"))
        {
            continue;
        }
        let contents = fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
        parse_clothing_script(&contents, &mut index);
    }
    Ok(index)
}

fn parse_clothing_script(contents: &str, index: &mut ClothingProtectionIndex) {
    let mut item_name: Option<String> = None;
    let mut definition = ClothingProtectionDefinition::default();
    let mut depth = 0_i32;

    for raw_line in contents.lines() {
        let line = raw_line.split("//").next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }

        if item_name.is_none() {
            let Some(rest) = line.strip_prefix("item ") else {
                continue;
            };
            let name = rest
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches('{')
                .trim();
            if name.is_empty() {
                continue;
            }
            item_name = Some(name.to_ascii_lowercase());
            definition = ClothingProtectionDefinition::default();
            depth = brace_delta(line);
            continue;
        }

        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim().trim_end_matches(',').trim();
            if key.eq_ignore_ascii_case("BloodLocation") {
                definition.covered_parts = value
                    .split(';')
                    .map(|part| part.trim().trim_start_matches("base:").to_ascii_lowercase())
                    .filter(|part| !part.is_empty())
                    .collect();
            } else if key.eq_ignore_ascii_case("BiteDefense") {
                definition.bite = value.parse::<f32>().unwrap_or_default().clamp(0.0, 100.0);
            } else if key.eq_ignore_ascii_case("ScratchDefense") {
                definition.scratch = value.parse::<f32>().unwrap_or_default().clamp(0.0, 100.0);
            }
        }

        depth += brace_delta(line);
        if depth <= 0 {
            if let Some(name) = item_name.take() {
                if !definition.covered_parts.is_empty()
                    && (definition.bite > 0.0 || definition.scratch > 0.0)
                {
                    index.definitions.insert(name, definition);
                }
            }
            definition = ClothingProtectionDefinition::default();
            depth = 0;
        }
    }

    if let Some(name) = item_name {
        if !definition.covered_parts.is_empty()
            && (definition.bite > 0.0 || definition.scratch > 0.0)
        {
            index.definitions.insert(name, definition);
        }
    }
}

fn brace_delta(line: &str) -> i32 {
    line.bytes().fold(0, |delta, byte| match byte {
        b'{' => delta + 1,
        b'}' => delta - 1,
        _ => delta,
    })
}

fn protection_for_visuals(
    visuals: &CharacterVisuals,
    index: &ClothingProtectionIndex,
) -> Vec<CharacterProtection> {
    let mut totals = BODY_PARTS
        .iter()
        .map(|part| ((*part).to_string(), (0.0_f32, 0.0_f32)))
        .collect::<HashMap<_, _>>();

    for item in &visuals.items {
        let item_name = item
            .clothing_name
            .as_deref()
            .or_else(|| item.full_type.split_once('.').map(|(_, name)| name));
        let Some(item_name) = item_name else {
            continue;
        };
        let Some(definition) = index.definitions.get(&item_name.to_ascii_lowercase()) else {
            continue;
        };
        for location in &definition.covered_parts {
            for part in covered_body_parts(location) {
                if let Some((bite, scratch)) = totals.get_mut(part) {
                    *bite = (*bite + definition.bite).min(100.0);
                    *scratch = (*scratch + definition.scratch).min(100.0);
                }
            }
        }
    }

    BODY_PARTS
        .iter()
        .map(|part| {
            let (bite, scratch) = totals.get(*part).copied().unwrap_or_default();
            CharacterProtection {
                id: (*part).to_string(),
                bite: Some(bite),
                scratch: Some(scratch),
            }
        })
        .collect()
}

fn covered_body_parts(location: &str) -> Vec<&'static str> {
    match location {
        "apron" => vec!["Torso_Upper", "Torso_Lower", "UpperLeg_L", "UpperLeg_R"],
        "shirtnosleeves" | "jumpernosleeves" => vec!["Torso_Upper", "Torso_Lower"],
        "shirt" => vec!["Torso_Upper", "Torso_Lower", "UpperArm_L", "UpperArm_R"],
        "shirtlongsleeves" | "jumper" => vec![
            "Torso_Upper",
            "Torso_Lower",
            "UpperArm_L",
            "UpperArm_R",
            "ForeArm_L",
            "ForeArm_R",
        ],
        "jacket" => vec![
            "Torso_Upper",
            "Torso_Lower",
            "UpperArm_L",
            "UpperArm_R",
            "ForeArm_L",
            "ForeArm_R",
            "Neck",
        ],
        "longjacket" => vec![
            "Torso_Upper",
            "Torso_Lower",
            "UpperArm_L",
            "UpperArm_R",
            "ForeArm_L",
            "ForeArm_R",
            "Neck",
            "Groin",
            "UpperLeg_L",
            "UpperLeg_R",
        ],
        "shortsshort" => vec!["Groin", "UpperLeg_L", "UpperLeg_R"],
        "trousers" => vec![
            "Groin",
            "UpperLeg_L",
            "UpperLeg_R",
            "LowerLeg_L",
            "LowerLeg_R",
        ],
        "shoes" => vec!["Foot_L", "Foot_R"],
        "fullhelmet" | "head" | "hat" => vec!["Head"],
        "hands" => vec!["Hand_L", "Hand_R"],
        "neck" => vec!["Neck"],
        "groin" => vec!["Groin"],
        "upperbody" => vec!["Torso_Upper"],
        "lowerbody" => vec!["Torso_Lower"],
        "lowerlegs" => vec!["LowerLeg_L", "LowerLeg_R"],
        "upperlegs" => vec!["UpperLeg_L", "UpperLeg_R"],
        "lowerarms" => vec!["ForeArm_L", "ForeArm_R"],
        "upperarms" => vec!["UpperArm_L", "UpperArm_R"],
        "hand_l" => vec!["Hand_L"],
        "hand_r" => vec!["Hand_R"],
        "forearm_l" => vec!["ForeArm_L"],
        "forearm_r" => vec!["ForeArm_R"],
        "upperarm_l" => vec!["UpperArm_L"],
        "upperarm_r" => vec!["UpperArm_R"],
        "upperleg_l" => vec!["UpperLeg_L"],
        "upperleg_r" => vec!["UpperLeg_R"],
        "lowerleg_l" => vec!["LowerLeg_L"],
        "lowerleg_r" => vec!["LowerLeg_R"],
        "foot_l" => vec!["Foot_L"],
        "foot_r" => vec!["Foot_R"],
        _ => Vec::new(),
    }
}

fn read_raw_characters(path: &Path) -> Result<Vec<RawCharacter>, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("Unable to open players.db: {error}"))?;
    let mut characters = Vec::new();

    for table in ["localPlayers", "networkPlayers"] {
        let sql = if table == "localPlayers" {
            "SELECT id, name, wx, wy, x, y, z, worldversion, data, isDead FROM localPlayers ORDER BY id"
        } else {
            "SELECT id, name, x, y, z, worldversion, data, isDead FROM networkPlayers ORDER BY id"
        };
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| format!("Unable to read {table}: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(RawCharacter {
                    summary: CharacterSummary {
                        id: row.get(0)?,
                        name: row
                            .get::<_, Option<String>>(1)?
                            .unwrap_or_else(|| "Unknown Survivor".to_string()),
                        source: table.to_string(),
                        is_dead: if table == "localPlayers" {
                            row.get::<_, i64>(9).unwrap_or_default() != 0
                        } else {
                            row.get::<_, i64>(7).unwrap_or_default() != 0
                        },
                        world_version: if table == "localPlayers" {
                            row.get(7)?
                        } else {
                            row.get(5)?
                        },
                        world_x: if table == "localPlayers" {
                            row.get(2)?
                        } else {
                            0
                        },
                        world_y: if table == "localPlayers" {
                            row.get(3)?
                        } else {
                            0
                        },
                        x: if table == "localPlayers" {
                            row.get(4)?
                        } else {
                            row.get(2)?
                        },
                        y: if table == "localPlayers" {
                            row.get(5)?
                        } else {
                            row.get(3)?
                        },
                        z: if table == "localPlayers" {
                            row.get(6)?
                        } else {
                            row.get(4)?
                        },
                    },
                    data: row
                        .get::<_, Option<Vec<u8>>>(if table == "localPlayers" { 8 } else { 6 })?
                        .unwrap_or_default(),
                })
            })
            .map_err(|error| format!("Unable to enumerate {table}: {error}"))?;
        for row in rows {
            characters.push(row.map_err(|error| error.to_string())?);
        }
    }
    Ok(characters)
}

fn parse_character(raw: RawCharacter, world_version: i32) -> Result<CharacterDetails, String> {
    let descriptor = find_descriptor(&raw.data, &raw.summary.name, world_version);

    let (forename, surname, profession, gender, visual_start) =
        descriptor.unwrap_or_else(|| (None, None, None, "Unknown".to_string(), 0));
    let mut visuals = CharacterVisuals {
        gender,
        skin_color: None,
        hair_color: None,
        beard_color: None,
        skin_texture: None,
        hair_model: None,
        beard_model: None,
        body_hair_index: None,
        clothing: Vec::new(),
        gear: Vec::new(),
        items: Vec::new(),
    };
    let mut traits = BTreeSet::new();
    let mut skills = BTreeMap::<String, CharacterSkill>::new();
    let mut stats = Vec::new();
    let mut health = Vec::new();
    let mut temperature = CharacterTemperature {
        core_temperature: None,
        body_heat_generation: None,
        body_heat_real: None,
        core_heat_delta: None,
        skin_temperature: None,
        body_response: None,
        insulation: None,
    };
    let mut info = CharacterInfo {
        weight: None,
        hours_survived: None,
        zombies_killed: None,
        known_recipes: 0,
        known_media: 0,
    };
    let mut inventory_count = 0;

    if visual_start > 0 {
        let mut cursor = Cursor::new(&raw.data[visual_start..]);
        let visual_parsed = parse_visual(&mut cursor, &mut visuals).is_ok();
        let inventory_start = cursor.position;
        if visual_parsed {
            if let Ok(count) = skip_inventory(&mut cursor, &mut visuals) {
                inventory_count = count;
                let _ = cursor.u8();
                let _ = cursor.f32();
                let sections_result = parse_character_sections(
                    &mut cursor,
                    world_version,
                    &mut stats,
                    &mut health,
                    &mut temperature,
                    &mut traits,
                    &mut skills,
                    &mut info,
                );
                if sections_result.is_err() {
                    stats.clear();
                    health.clear();
                    traits.clear();
                    skills.clear();
                    temperature = CharacterTemperature {
                        core_temperature: None,
                        body_heat_generation: None,
                        body_heat_real: None,
                        core_heat_delta: None,
                        skin_temperature: None,
                        body_response: None,
                        insulation: None,
                    };
                    info = CharacterInfo {
                        weight: None,
                        hours_survived: None,
                        zombies_killed: None,
                        known_recipes: 0,
                        known_media: 0,
                    };
                }
            }
            if inventory_count == 0 {
                inventory_count =
                    count_inventory_items(&raw.data[visual_start + inventory_start..]);
            }
        }

        // A visual or inventory record can vary between Build 42 revisions.
        // Locate the stats block independently so a harmless visual-format
        // difference cannot blank the stats, skills, health, or info panes.
        if (stats.is_empty()
            || skills.is_empty()
            || info.weight.is_none() && info.hours_survived.is_none()
            || temperature.core_temperature.is_none())
            && let Some(stats_start) = find_stats_start(
                &raw.data,
                visual_start + if visual_parsed { inventory_start } else { 0 },
                world_version,
            )
        {
            stats.clear();
            health.clear();
            traits.clear();
            skills.clear();
            temperature = CharacterTemperature {
                core_temperature: None,
                body_heat_generation: None,
                body_heat_real: None,
                core_heat_delta: None,
                skin_temperature: None,
                body_response: None,
                insulation: None,
            };
            info = CharacterInfo {
                weight: None,
                hours_survived: None,
                zombies_killed: None,
                known_recipes: 0,
                known_media: 0,
            };
            let mut stats_cursor = Cursor::new(&raw.data[stats_start..]);
            for stat_name in CHARACTER_STATS {
                stats.push(CharacterStatValue {
                    id: stat_name.to_string(),
                    label: humanize_identifier(stat_name),
                    value: stats_cursor.f32().unwrap_or_default(),
                    moodle_icon: None,
                });
            }
            if let Some(trait_start) =
                find_trait_start(&raw.data, stats_start + CHARACTER_STATS.len() * 4)
            {
                let _ = parse_tail_from_trait_start(
                    &raw.data,
                    trait_start,
                    world_version,
                    &mut traits,
                    &mut skills,
                    &mut info,
                );
            }
            if let Some(found_temperature) = find_thermal_record(&raw.data, stats_start) {
                temperature = found_temperature;
            }
        }
    }

    // XP stores only values that have been materialized. Fill in the rest so
    // every Build 42 skill remains visible and editable at level zero.
    for (_, skill_ids) in SKILL_CATEGORIES {
        for id in skill_ids {
            skills.entry((*id).to_string()).or_insert(CharacterSkill {
                id: (*id).to_string(),
                category: skill_category(id),
                level: 0,
                xp: Some(0.0),
            });
        }
    }

    let strings = extract_strings(&raw.data);
    for value in &strings {
        if value.starts_with("base:")
            && value.len() > 5
            && value != profession.as_deref().unwrap_or("")
        {
            traits.insert(value.clone());
        }
        if value.starts_with("Base.") {
            let lower = value.to_ascii_lowercase();
            if lower.contains("shirt")
                || lower.contains("trouser")
                || lower.contains("pants")
                || lower.contains("jacket")
                || lower.contains("vest")
                || lower.contains("shoe")
                || lower.contains("sock")
                || lower.contains("hat")
                || lower.contains("belt")
                || lower.contains("glove")
                || lower.contains("mask")
                || lower.contains("coat")
            {
                visuals.clothing.push(value.clone());
            } else {
                visuals.gear.push(value.clone());
            }
        }
    }
    dedupe_strings(&mut visuals.clothing);
    dedupe_strings(&mut visuals.gear);
    let clothing_names = visuals.clothing.clone();
    for full_type in clothing_names {
        if visuals
            .items
            .iter()
            .any(|item| item.full_type.eq_ignore_ascii_case(&full_type))
        {
            continue;
        }
        let clothing_name = full_type
            .split_once('.')
            .map(|(_, value)| value.to_string())
            .filter(|value| !value.is_empty());
        visuals.items.push(CharacterVisualItem {
            full_type,
            clothing_name,
            alternate_model: None,
            base_texture: None,
            texture_choice: None,
        });
    }
    let readable_strings = strings
        .into_iter()
        .filter(|value| {
            value.len() >= 3 && !value.starts_with("Base.") && !value.starts_with("base:")
        })
        .take(80)
        .collect();
    let preview_svg = render_character_svg(&raw.summary, &visuals);
    let summary = raw.summary;
    let protections = BODY_PARTS
        .iter()
        .map(|id| CharacterProtection {
            id: (*id).to_string(),
            bite: None,
            scratch: None,
        })
        .collect();

    Ok(CharacterDetails {
        summary,
        forename,
        surname,
        profession,
        profession_icon: None,
        traits: traits.into_iter().map(|id| fallback_trait(&id)).collect(),
        skills: skills.into_values().collect(),
        stats,
        info,
        health,
        temperature,
        protection: protections,
        visuals,
        inventory_count,
        readable_strings,
        binary_size: raw.data.len(),
        preview_svg,
    })
}

fn parse_character_sections(
    cursor: &mut Cursor<'_>,
    world_version: i32,
    stats: &mut Vec<CharacterStatValue>,
    health: &mut Vec<CharacterBodyPart>,
    temperature: &mut CharacterTemperature,
    traits: &mut BTreeSet<String>,
    skills: &mut BTreeMap<String, CharacterSkill>,
    info: &mut CharacterInfo,
) -> Result<(), String> {
    for stat_name in CHARACTER_STATS {
        let value = cursor.f32()?;
        stats.push(CharacterStatValue {
            id: stat_name.to_string(),
            label: humanize_identifier(stat_name),
            value,
            moodle_icon: None,
        });
    }

    let (found_health, found_temperature) = parse_body_damage(cursor, world_version, None)?;
    *health = found_health;
    *temperature = found_temperature;

    let trait_count = cursor.i32()?;
    if !(0..=128).contains(&trait_count) {
        return Err("Character trait count is invalid.".to_string());
    }
    for _ in 0..trait_count {
        traits.insert(cursor.string()?);
    }
    cursor.f32()?;
    cursor.i32()?;
    cursor.i32()?;
    parse_xp_map(cursor, skills)?;
    parse_perk_levels(cursor, skills)?;
    skip_xp_multipliers(cursor)?;
    parse_character_tail(cursor, world_version, info)?;
    Ok(())
}

fn find_descriptor(
    data: &[u8],
    character_name: &str,
    world_version: i32,
) -> Option<(
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    usize,
)> {
    let first_name = character_name.split_whitespace().next().unwrap_or("");
    for offset in 0..data.len().saturating_sub(2) {
        if let Some(candidate) = read_string_at(data, offset) {
            if candidate != first_name && candidate != character_name {
                continue;
            }
            if offset < 5 || data[offset - 5] != 1 {
                continue;
            }
            if let Some(found) = parse_descriptor(data, offset, world_version) {
                return Some(found);
            }
        }
    }
    None
}

struct CharacterEditOffsets {
    stats: Vec<usize>,
    body_health: Vec<usize>,
    skill_levels: HashMap<String, usize>,
}

fn find_edit_offsets(
    data: &[u8],
    character_name: &str,
    world_version: i32,
) -> Result<CharacterEditOffsets, String> {
    let visual_start = find_descriptor(data, character_name, world_version)
        .map(|descriptor| descriptor.4)
        .ok_or_else(|| "Unable to locate the serialized character descriptor.".to_string())?;
    let mut cursor = Cursor::new(&data[visual_start..]);
    let mut visuals = CharacterVisuals {
        gender: "Unknown".to_string(),
        skin_color: None,
        hair_color: None,
        beard_color: None,
        skin_texture: None,
        hair_model: None,
        beard_model: None,
        body_hair_index: None,
        clothing: Vec::new(),
        gear: Vec::new(),
        items: Vec::new(),
    };
    parse_visual(&mut cursor, &mut visuals)?;
    let after_visual = visual_start + cursor.position;
    let stats_start = match skip_inventory(&mut cursor, &mut visuals) {
        Ok(_) => visual_start + cursor.position + 5,
        Err(_) => find_stats_start(data, after_visual, world_version)
            .ok_or_else(|| "Unable to locate the serialized character stats.".to_string())?,
    };
    let mut cursor = Cursor::new(&data[stats_start..]);
    let mut offsets = Vec::with_capacity(CHARACTER_STATS.len());
    for _ in CHARACTER_STATS {
        offsets.push(stats_start + cursor.position);
        cursor.f32()?;
    }
    let mut body_health = Vec::with_capacity(BODY_PARTS.len());
    parse_body_damage(&mut cursor, world_version, Some(&mut body_health))?;
    let trait_count = cursor.i32()?;
    if !(0..=128).contains(&trait_count) {
        return Err("Character trait count is invalid.".to_string());
    }
    for _ in 0..trait_count {
        cursor.string()?;
    }
    cursor.f32()?;
    cursor.i32()?;
    cursor.i32()?;
    let mut ignored_skills = BTreeMap::new();
    parse_xp_map(&mut cursor, &mut ignored_skills)?;
    let perk_count = cursor.i32()?;
    if !(0..=256).contains(&perk_count) {
        return Err("Perk count is invalid.".to_string());
    }
    let mut skill_levels = HashMap::new();
    for _ in 0..perk_count {
        let id = cursor.string()?;
        skill_levels.insert(id, visual_start + cursor.position);
        cursor.i32()?;
    }
    skip_xp_multipliers(&mut cursor)?;
    Ok(CharacterEditOffsets {
        stats: offsets,
        body_health,
        skill_levels,
    })
}

fn find_stats_start(data: &[u8], search_start: usize, _world_version: i32) -> Option<usize> {
    let end = data.len().saturating_sub(CHARACTER_STATS.len() * 4);
    for start in search_start..end {
        let mut stats_cursor = Cursor::new(&data[start..]);
        let mut valid = true;
        for stat in CHARACTER_STATS {
            let Ok(value) = stats_cursor.f32() else {
                valid = false;
                break;
            };
            let (minimum, maximum) = character_stat_bounds(stat);
            if !value.is_finite() || value < minimum || value > maximum {
                valid = false;
                break;
            }
        }
        if !valid {
            continue;
        }

        if find_trait_start(data, start + CHARACTER_STATS.len() * 4).is_some() {
            return Some(start);
        }
    }
    None
}

fn find_trait_start(data: &[u8], search_start: usize) -> Option<usize> {
    for start in search_start..data.len().saturating_sub(4) {
        let mut cursor = Cursor::new(&data[start..]);
        let Ok(count) = cursor.i32() else {
            continue;
        };
        if !(1..=32).contains(&count) {
            continue;
        }
        let mut valid = true;
        for _ in 0..count {
            let Ok(value) = cursor.string() else {
                valid = false;
                break;
            };
            if !value.to_ascii_lowercase().starts_with("base:") {
                valid = false;
                break;
            }
        }
        if valid {
            return Some(start);
        }
    }
    None
}

fn parse_tail_from_trait_start(
    data: &[u8],
    trait_start: usize,
    world_version: i32,
    traits: &mut BTreeSet<String>,
    skills: &mut BTreeMap<String, CharacterSkill>,
    info: &mut CharacterInfo,
) -> Result<(), String> {
    let mut cursor = Cursor::new(&data[trait_start..]);
    let trait_count = cursor.i32()?;
    for _ in 0..trait_count {
        traits.insert(cursor.string()?);
    }
    cursor.f32()?;
    cursor.i32()?;
    cursor.i32()?;
    parse_xp_map(&mut cursor, skills)?;
    parse_perk_levels(&mut cursor, skills)?;
    skip_xp_multipliers(&mut cursor)?;
    parse_character_tail(&mut cursor, world_version, info)
}

fn find_thermal_record(data: &[u8], search_start: usize) -> Option<CharacterTemperature> {
    for start in search_start..data.len().saturating_sub(45) {
        if data[start] != 1 {
            continue;
        }
        let mut cursor = Cursor::new(&data[start..]);
        let Ok(set_point) = cursor.u8().and_then(|_| cursor.f32()) else {
            continue;
        };
        if !set_point.is_finite() || !(15.0..=45.0).contains(&set_point) {
            continue;
        }
        let Ok(metabolic_rate) = cursor.f32() else {
            continue;
        };
        let Ok(metabolic_real) = cursor.f32() else {
            continue;
        };
        let _ = cursor.f32();
        let _ = cursor.f32();
        let Ok(core_heat_delta) = cursor.f32() else {
            continue;
        };
        let _ = cursor.f32();
        let _ = cursor.f32();
        let _ = cursor.f32();
        let Ok(count) = cursor.i32() else {
            continue;
        };
        if !(0..=32).contains(&count) {
            continue;
        }
        let mut temperature = CharacterTemperature {
            core_temperature: Some(set_point),
            body_heat_generation: Some(metabolic_rate),
            body_heat_real: Some(metabolic_real),
            core_heat_delta: Some(core_heat_delta),
            skin_temperature: None,
            body_response: None,
            insulation: None,
        };
        for _ in 0..count {
            let node_index = cursor.i32().ok()?;
            let celcius = cursor.f32().ok()?;
            let skin_celcius = cursor.f32().ok()?;
            let _ = cursor.f32().ok()?;
            let primary_delta = cursor.f32().ok()?;
            let secondary_delta = cursor.f32().ok()?;
            let insulation = cursor.f32().ok()?;
            let _ = cursor.f32().ok()?;
            let _ = cursor.f32().ok()?;
            let _ = cursor.f32().ok()?;
            if node_index == 6 {
                temperature.core_temperature = Some(celcius);
                temperature.skin_temperature = Some(skin_celcius);
                temperature.body_response = Some((primary_delta + secondary_delta) / 2.0);
                temperature.insulation = Some(insulation);
            }
        }
        return Some(temperature);
    }
    None
}

fn character_stat_bounds(id: &str) -> (f32, f32) {
    match id {
        // The normal game API clamps CharacterStat values, but the editor
        // preserves its existing ability to write any finite value. Keep the
        // discovery bounds broad enough to find an edited value again.
        "Anger" => (-100.0, 100.0),
        "Boredom" | "Discomfort" | "FoodSickness" | "Intoxication" | "Pain" | "Panic"
        | "Poison" | "Unhappiness" | "Wetness" | "ZombieFever" | "ZombieInfection" => {
            (-100.0, 100.0)
        }
        "Endurance" | "Fatigue" | "Hunger" | "Idleness" | "Morale" | "Sanity" | "Sickness"
        | "Stress" | "Thirst" => (-100.0, 100.0),
        "Fitness" => (-100.0, 100.0),
        "NicotineWithdrawal" => (-100.0, 100.0),
        "Temperature" => (-100.0, 100.0),
        _ => (f32::MIN, f32::MAX),
    }
}

fn render_character_svg(summary: &CharacterSummary, visuals: &CharacterVisuals) -> String {
    let skin = normalized_color(visuals.skin_color.as_deref(), "#C58F70");
    let hair = normalized_color(visuals.hair_color.as_deref(), "#4B3023");
    let shirt = item_color(&visuals.clothing, &["shirt", "vest", "jacket"], "#40566B");
    let pants = item_color(&visuals.clothing, &["trouser", "pants"], "#2D3744");
    let shoes = item_color(&visuals.clothing, &["shoe", "boot"], "#1A1E22");
    let has_hat = has_item(&visuals.clothing, &["hat", "cap", "fedora"]);
    let has_pack = has_item(&visuals.gear, &["bag", "backpack", "satchel"]);
    let has_beard = visuals.beard_model.is_some();
    let name = escape_xml(&summary.name);
    let location = format!(
        "Cell {}, {} · {:.1}, {:.1}",
        summary.world_x, summary.world_y, summary.x, summary.y
    );
    let location = escape_xml(&location);

    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 520" role="img" aria-label="3D character preview for {name}">
  <defs>
    <linearGradient id="preview-bg" x2="0" y2="1"><stop stop-color="#172733"/><stop offset="1" stop-color="#314B5A"/></linearGradient>
    <linearGradient id="skin" x2="1" y2="1"><stop stop-color="{skin}"/><stop offset="1" stop-color="#704D45"/></linearGradient>
    <linearGradient id="shirt" x2="1" y2="1"><stop stop-color="{shirt}"/><stop offset="1" stop-color="#17222D"/></linearGradient>
    <linearGradient id="pants" x2="1" y2="1"><stop stop-color="{pants}"/><stop offset="1" stop-color="#10151B"/></linearGradient>
    <linearGradient id="hair" x2="1" y2="1"><stop stop-color="{hair}"/><stop offset="1" stop-color="#171216"/></linearGradient>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
  </defs>
  <rect width="720" height="520" rx="20" fill="url(#preview-bg)"/>
  <path d="M40 430H680M80 390H640M120 350H600" stroke="#B8D4DF" stroke-opacity=".12"/>
  <ellipse cx="360" cy="444" rx="142" ry="24" fill="#081016" opacity=".7" filter="url(#shadow)"/>
  <g transform="translate(360 45)" stroke="#0C141A" stroke-width="5" stroke-linejoin="round">
    {backpack}
    <path d="M-65 232L-45 370H-5L-3 244Z" fill="url(#pants)"/>
    <path d="M5 244L5 370H48L66 232Z" fill="url(#pants)"/>
    <path d="M-46 367L-65 405L-1 405L5 370Z" fill="{shoes}"/>
    <path d="M5 370L12 405L76 405L48 367Z" fill="{shoes}"/>
    <path d="M-112 130C-128 157-129 205-108 244L-78 232L-73 151Z" fill="url(#shirt)"/>
    <path d="M112 130C128 157 129 205 108 244L78 232L73 151Z" fill="url(#shirt)"/>
    <path d="M-78 90Q0 60 78 90L94 238Q0 274-94 238Z" fill="url(#shirt)"/>
    <path d="M-18 112L0 132L18 112" fill="none" stroke="#D5E4E8" stroke-opacity=".4"/>
    <ellipse cx="0" cy="40" rx="67" ry="78" fill="url(#skin)"/>
    <path d="M-62 30Q-50-48 0-43Q54-48 65 30Q31-3-62 30Z" fill="url(#hair)"/>
    {beard}
    {hat}
    <circle cx="-23" cy="38" r="5" fill="#11181D" stroke="none"/>
    <circle cx="23" cy="38" r="5" fill="#11181D" stroke="none"/>
    <path d="M-15 70Q0 80 15 70" fill="none" stroke="#3E2527"/>
  </g>
  <text x="32" y="42" fill="#F3FAFC" font-family="sans-serif" font-size="22" font-weight="700">{name}</text>
  <text x="32" y="70" fill="#B9D0D9" font-family="sans-serif" font-size="14">{location}</text>
  <text x="688" y="482" text-anchor="end" fill="#B9D0D9" font-family="sans-serif" font-size="12">B42.20 character preview</text>
</svg>"##,
        name = name,
        skin = skin,
        shirt = shirt,
        pants = pants,
        shoes = shoes,
        hair = hair,
        backpack = if has_pack {
            r##"<path d="M-48 111Q0 92 48 111L53 222Q0 240-53 222Z" fill="#27353D"/>"##
        } else {
            ""
        },
        beard = if has_beard {
            r#"<path d="M-40 60Q0 102 40 60L30 93Q0 119-30 93Z" fill="url(#hair)"/>"#
        } else {
            ""
        },
        hat = if has_hat {
            r##"<path d="M-66-29Q0-63 66-29L59-5H-59Z" fill="#303A40"/><path d="M-88-5H88L77 10H-77Z" fill="#202A30"/>"##
        } else {
            ""
        },
        location = location,
    )
}

fn normalized_color(value: Option<&str>, fallback: &str) -> String {
    let Some(value) = value else {
        return fallback.to_string();
    };
    if value.len() == 7
        && value.starts_with('#')
        && value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

fn item_color(items: &[String], terms: &[&str], fallback: &str) -> String {
    let Some(item) = items.iter().find(|item| {
        terms
            .iter()
            .any(|term| item.to_ascii_lowercase().contains(term))
    }) else {
        return fallback.to_string();
    };
    let item = item.to_ascii_lowercase();
    if item.contains("red") || item.contains("fire") {
        "#8F3030".to_string()
    } else if item.contains("blue") || item.contains("denim") {
        "#315B83".to_string()
    } else if item.contains("green") || item.contains("military") || item.contains("camo") {
        "#4C6144".to_string()
    } else if item.contains("white") || item.contains("tanktop") {
        "#D6D7CF".to_string()
    } else if item.contains("yellow") {
        "#B99C3E".to_string()
    } else {
        fallback.to_string()
    }
}

fn has_item(items: &[String], terms: &[&str]) -> bool {
    items.iter().any(|item| {
        terms
            .iter()
            .any(|term| item.to_ascii_lowercase().contains(term))
    })
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn parse_descriptor(
    data: &[u8],
    forename_offset: usize,
    _world_version: i32,
) -> Option<(
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    usize,
)> {
    let mut cursor = Cursor {
        bytes: data,
        position: forename_offset,
    };
    let forename = cursor.string().ok()?;
    let surname = cursor.string().ok()?;
    let _torso = cursor.string().ok()?;
    let gender = cursor.i32().ok()?;
    if gender != 0 && gender != 1 {
        return None;
    }
    let profession = cursor.string().ok()?;
    let extra_present = cursor.i32().ok()?;
    if extra_present == 1 {
        let extra_count = cursor.i32().ok()?;
        if !(0..=128).contains(&extra_count) {
            return None;
        }
        for _ in 0..extra_count {
            cursor.string().ok()?;
        }
    }
    let boost_count = cursor.i32().ok()?;
    if !(0..=128).contains(&boost_count) {
        return None;
    }
    for _ in 0..boost_count {
        cursor.string().ok()?;
        cursor.i32().ok()?;
    }
    cursor.string().ok()?;
    cursor.f32().ok()?;
    cursor.i32().ok()?;
    Some((
        Some(forename),
        Some(surname),
        Some(profession),
        if gender == 1 { "Female" } else { "Male" }.to_string(),
        cursor.position,
    ))
}

fn parse_visual(cursor: &mut Cursor<'_>, visuals: &mut CharacterVisuals) -> Result<(), String> {
    let flags = cursor.u8()?;
    visuals.hair_color = read_color(cursor, flags & 4 != 0)?;
    visuals.beard_color = read_color(cursor, flags & 2 != 0)?;
    visuals.skin_color = read_color(cursor, flags & 8 != 0)?;
    visuals.body_hair_index = Some(cursor.i8()?);
    let _skin_texture_index = cursor.i8()?;
    let _zombie_rot_stage = cursor.i8()?;
    let skin_texture_name = if flags & 64 != 0 {
        Some(cursor.string_lossy()?)
    } else {
        None
    };
    let beard_model = if flags & 16 != 0 {
        Some(cursor.string_lossy()?)
    } else {
        None
    };
    let hair_model = if flags & 32 != 0 {
        Some(cursor.string_lossy()?)
    } else {
        None
    };
    visuals.skin_texture = skin_texture_name;
    visuals.beard_model = beard_model;
    visuals.hair_model = hair_model;
    skip_length_prefixed_bytes(cursor)?;
    skip_length_prefixed_bytes(cursor)?;
    skip_length_prefixed_bytes(cursor)?;
    let body_visual_count = cursor.u8()? as usize;
    for _ in 0..body_visual_count {
        let item = parse_item_visual(cursor)?;
        if let Some(item) = item {
            if !item.full_type.is_empty() {
                visuals.gear.push(item.full_type.clone());
            }
            visuals.items.push(item);
        }
    }
    let _non_attached_hair = cursor.string_lossy()?;
    let natural_flags = cursor.u8()?;
    let _ = read_color(cursor, natural_flags & 4 != 0)?;
    let _ = read_color(cursor, natural_flags & 2 != 0)?;
    Ok(())
}

fn parse_item_visual(cursor: &mut Cursor<'_>) -> Result<Option<CharacterVisualItem>, String> {
    let flags = cursor.u8()?;
    let full_type = cursor.string()?;
    let alternate_model = cursor.string()?;
    let clothing_name = cursor.string()?;
    let _ = read_color(cursor, flags & 1 != 0)?;
    let base_texture = if flags & 2 != 0 {
        Some(cursor.i8()?)
    } else {
        None
    };
    let texture_choice = if flags & 4 != 0 {
        Some(cursor.i8()?)
    } else {
        None
    };
    if flags & 8 != 0 {
        let _ = cursor.f32()?;
    }
    if flags & 16 != 0 {
        let _ = cursor.string()?;
    }
    for _ in 0..6 {
        skip_length_prefixed_bytes(cursor)?;
    }
    Ok(Some(CharacterVisualItem {
        full_type,
        clothing_name: (!clothing_name.is_empty()).then_some(clothing_name),
        alternate_model: (!alternate_model.is_empty()).then_some(alternate_model),
        base_texture,
        texture_choice,
    }))
}

fn skip_inventory(
    cursor: &mut Cursor<'_>,
    visuals: &mut CharacterVisuals,
) -> Result<usize, String> {
    let _container_type = cursor.string()?;
    let _explored = cursor.u8()?;
    let group_count = cursor.i16()?;
    if !(0..=4096).contains(&group_count) {
        return Err("Inventory group count is invalid.".to_string());
    }
    let mut item_count = 0usize;
    for _ in 0..group_count {
        let identical = cursor.i32()?;
        if !(1..=4096).contains(&identical) {
            return Err("Inventory item count is invalid.".to_string());
        }
        let data_len = cursor.i32()?;
        if data_len <= 0 || data_len as usize > cursor.remaining() {
            return Err("Inventory item data is invalid.".to_string());
        }
        let payload = cursor.take(data_len as usize)?;
        let strings = extract_strings(payload);
        for value in strings
            .into_iter()
            .filter(|value| value.starts_with("Base."))
        {
            visuals.gear.push(value);
        }
        item_count = item_count.saturating_add(identical as usize);
        for _ in 1..identical {
            let _ = cursor.i32()?;
        }
    }
    let _looted = cursor.u8()?;
    let _capacity = cursor.i32()?;
    Ok(item_count)
}

fn parse_body_damage(
    cursor: &mut Cursor<'_>,
    world_version: i32,
    health_offsets: Option<&mut Vec<usize>>,
) -> Result<(Vec<CharacterBodyPart>, CharacterTemperature), String> {
    let mut body_parts = Vec::with_capacity(BODY_PARTS.len());
    let mut health_offsets = health_offsets;
    for part_id in BODY_PARTS {
        let cut = cursor.u8()? != 0;
        let bitten = cursor.u8()? != 0;
        let scratched = cursor.u8()? != 0;
        let bandaged = cursor.u8()? != 0;
        let bleeding = cursor.u8()? != 0;
        let deep_wounded = cursor.u8()? != 0;
        let fake_infected = cursor.u8()? != 0;
        let infected = cursor.u8()? != 0;
        if let Some(offsets) = health_offsets.as_deref_mut() {
            offsets.push(cursor.position);
        }
        let health = cursor.f32()?;
        if bandaged {
            cursor.f32()?;
        }
        let infected_wound = cursor.u8()? != 0;
        if infected_wound {
            cursor.f32()?;
        }
        for _ in 0..7 {
            cursor.f32()?;
        }
        cursor.u8()?;
        cursor.u8()?;
        cursor.u8()?;
        cursor.f32()?;
        cursor.u8()?;
        cursor.u8()?;
        cursor.f32()?;
        let splint = cursor.u8()? != 0;
        if splint {
            cursor.f32()?;
        }
        cursor.u8()?;
        cursor.f32()?;
        cursor.u8()?;
        cursor.f32()?;
        cursor.string8()?;
        cursor.string8()?;
        cursor.f32()?;
        let wetness = cursor.f32()?;
        let stiffness = cursor.f32()?;
        if world_version >= 227 {
            cursor.f32()?;
            cursor.f32()?;
            cursor.f32()?;
        }
        body_parts.push(CharacterBodyPart {
            id: part_id.to_string(),
            health,
            cut,
            bitten,
            scratched,
            bandaged,
            bleeding,
            deep_wounded,
            fake_infected,
            infected,
            infected_wound,
            wetness,
            stiffness,
        });
    }

    cursor.f32()?;
    cursor.u8()?;
    cursor.f32()?;
    if world_version >= 222 {
        cursor.i32()?;
    }
    cursor.u8()?;
    for _ in 0..6 {
        cursor.f32()?;
    }

    let mut temperature = CharacterTemperature {
        core_temperature: None,
        body_heat_generation: None,
        body_heat_real: None,
        core_heat_delta: None,
        skin_temperature: None,
        body_response: None,
        insulation: None,
    };
    // Some saves contain an additional pair of legacy body-damage floats
    // before this flag. Resynchronize on the first valid thermal marker and
    // a plausible Celsius set point instead of abandoning the rest of the
    // serialized character.
    if !matches!(cursor.bytes.get(cursor.position), Some(0 | 1)) {
        for offset in 1..=16 {
            let Some(&marker) = cursor.bytes.get(cursor.position + offset) else {
                break;
            };
            if matches!(marker, 0 | 1) && cursor.position + offset + 5 <= cursor.bytes.len() {
                let set_point = f32::from_bits(u32::from_be_bytes(
                    cursor.bytes[cursor.position + offset + 1..cursor.position + offset + 5]
                        .try_into()
                        .unwrap(),
                ));
                if set_point.is_finite() && (15.0..=45.0).contains(&set_point) {
                    cursor.position += offset;
                    break;
                }
            }
        }
    }
    if cursor.u8()? != 0 {
        let set_point = cursor.f32()?;
        temperature.core_temperature = Some(set_point);
        let metabolic_rate = cursor.f32()?;
        let metabolic_real = if world_version >= 243 {
            cursor.f32()?
        } else {
            metabolic_rate
        };
        cursor.f32()?;
        cursor.f32()?;
        let core_heat_delta = cursor.f32()?;
        cursor.f32()?;
        cursor.f32()?;
        if world_version >= 249 {
            cursor.f32()?;
        }
        let count = cursor.i32()?;
        if !(0..=64).contains(&count) {
            return Err("Thermal node count is invalid.".to_string());
        }
        for _ in 0..count {
            let node_index = cursor.i32()?;
            let celcius = cursor.f32()?;
            let skin_celcius = cursor.f32()?;
            cursor.f32()?;
            let primary_delta = cursor.f32()?;
            let secondary_delta = cursor.f32()?;
            let insulation = if world_version >= 241 {
                cursor.f32()?
            } else {
                0.0
            };
            if world_version >= 243 {
                cursor.f32()?;
                cursor.f32()?;
                cursor.f32()?;
            }
            if node_index == 6 {
                temperature.core_temperature = Some(celcius);
                temperature.skin_temperature = Some(skin_celcius);
                temperature.body_response = Some((primary_delta + secondary_delta) / 2.0);
                temperature.insulation = Some(insulation);
            }
        }
        temperature.body_heat_generation = Some(metabolic_rate);
        temperature.body_heat_real = Some(metabolic_real);
        temperature.core_heat_delta = Some(core_heat_delta);
    }
    Ok((body_parts, temperature))
}

fn parse_xp_map(
    cursor: &mut Cursor<'_>,
    skills: &mut BTreeMap<String, CharacterSkill>,
) -> Result<(), String> {
    let count = cursor.i32()?;
    if !(0..=256).contains(&count) {
        return Err("XP map count is invalid.".to_string());
    }
    for _ in 0..count {
        let id = cursor.string()?;
        let xp = cursor.f32()?;
        skills
            .entry(id.clone())
            .or_insert(CharacterSkill {
                category: skill_category(&id),
                id,
                level: 0,
                xp: Some(xp),
            })
            .xp = Some(xp);
    }
    Ok(())
}

fn parse_perk_levels(
    cursor: &mut Cursor<'_>,
    skills: &mut BTreeMap<String, CharacterSkill>,
) -> Result<(), String> {
    let count = cursor.i32()?;
    if !(0..=256).contains(&count) {
        return Err("Perk count is invalid.".to_string());
    }
    for _ in 0..count {
        let id = cursor.string()?;
        let level = cursor.i32()?;
        skills
            .entry(id.clone())
            .or_insert(CharacterSkill {
                category: skill_category(&id),
                id,
                level,
                xp: None,
            })
            .level = level;
    }
    Ok(())
}

fn skip_xp_multipliers(cursor: &mut Cursor<'_>) -> Result<(), String> {
    let count = cursor.i32()?;
    if !(0..=256).contains(&count) {
        return Err("XP multiplier count is invalid.".to_string());
    }
    for _ in 0..count {
        cursor.string()?;
        cursor.f32()?;
        cursor.i8()?;
        cursor.i8()?;
    }
    Ok(())
}

fn parse_character_tail(
    cursor: &mut Cursor<'_>,
    world_version: i32,
    info: &mut CharacterInfo,
) -> Result<(), String> {
    // IsoGameCharacter.save writes these hand indexes after XP and before
    // the fire/effect fields. Keep this cursor aligned with B42.20 before
    // reading the recipe and media sections that follow it.
    cursor.i32()?;
    cursor.i32()?;
    cursor.u8()?;
    for _ in 0..8 {
        cursor.f32()?;
    }
    let read_books = cursor.i32()?;
    if !(0..=4096).contains(&read_books) {
        return Err("Read book count is invalid.".to_string());
    }
    for _ in 0..read_books {
        cursor.string()?;
        cursor.i32()?;
    }
    cursor.f32()?;
    let recipes = cursor.i32()?;
    if !(0..=4096).contains(&recipes) {
        return Err("Recipe count is invalid.".to_string());
    }
    for _ in 0..recipes {
        cursor.string()?;
    }
    info.known_recipes = recipes as usize;
    cursor.i32()?;
    cursor.f32()?;
    cursor.f32()?;
    cursor.f32()?;
    for _ in 0..15 {
        cursor.u8()?;
    }
    let literature = cursor.i32()?;
    if !(0..=4096).contains(&literature) {
        return Err("Read literature count is invalid.".to_string());
    }
    for _ in 0..literature {
        cursor.string()?;
        cursor.i32()?;
    }
    let media = if world_version >= 222 {
        let count = cursor.i32()?;
        if !(0..=4096).contains(&count) {
            return Err("Read media count is invalid.".to_string());
        }
        for _ in 0..count {
            cursor.string()?;
        }
        count as usize
    } else {
        0
    };
    info.known_media = media;
    cursor.i64()?;
    let cheats = cursor.i32()?;
    if !(0..=64).contains(&cheats) {
        return Err("Cheat count is invalid.".to_string());
    }
    for _ in 0..cheats {
        cursor.u8()?;
    }
    info.hours_survived = Some(cursor.f64()?);
    info.zombies_killed = Some(cursor.i32()?);
    let worn_items = cursor.u8()? as usize;
    if worn_items > 127 {
        return Err("Worn item count is invalid.".to_string());
    }
    for _ in 0..worn_items {
        cursor.string()?;
        cursor.i16()?;
    }
    cursor.i16()?;
    cursor.i16()?;
    cursor.i32()?;
    cursor.f32()?;
    cursor.f32()?;
    cursor.f32()?;
    cursor.f32()?;
    info.weight = Some(cursor.f32()?);
    Ok(())
}

fn read_color(cursor: &mut Cursor<'_>, present: bool) -> Result<Option<String>, String> {
    if !present {
        return Ok(None);
    }
    let r = cursor.u8()?;
    let g = cursor.u8()?;
    let b = cursor.u8()?;
    Ok(Some(format!("#{r:02X}{g:02X}{b:02X}")))
}

fn skip_bytes(cursor: &mut Cursor<'_>, count: usize) -> Result<(), String> {
    cursor.take(count).map(|_| ())
}

fn skip_length_prefixed_bytes(cursor: &mut Cursor<'_>) -> Result<(), String> {
    let count = cursor.u8()? as usize;
    skip_bytes(cursor, count)
}

fn read_string_at(data: &[u8], offset: usize) -> Option<String> {
    if offset + 2 > data.len() {
        return None;
    }
    let count = u16::from_be_bytes([data[offset], data[offset + 1]]) as usize;
    if count == 0 || count > 256 || offset + 2 + count > data.len() {
        return None;
    }
    let value = String::from_utf8(data[offset + 2..offset + 2 + count].to_vec()).ok()?;
    value
        .chars()
        .all(|character| !character.is_control())
        .then_some(value)
}

fn extract_strings(data: &[u8]) -> Vec<String> {
    let mut values = Vec::new();
    for offset in 0..data.len().saturating_sub(2) {
        if let Some(value) = read_string_at(data, offset) {
            if value.len() >= 2 && !values.contains(&value) {
                values.push(value);
            }
        }
    }
    values
}

fn count_inventory_items(data: &[u8]) -> usize {
    extract_strings(data)
        .iter()
        .filter(|value| value.starts_with("Base."))
        .count()
}

fn dedupe_strings(values: &mut Vec<String>) {
    let mut seen = BTreeSet::new();
    values.retain(|value| seen.insert(value.clone()));
    values.truncate(60);
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|error| error.to_string())?;
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|error| error.to_string())?;
        let target = destination.join(relative);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::copy(entry.path(), &target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn path_to_relative_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::{
        CharacterEditPayload, CharacterStatValue, CharacterVisualItem, CharacterVisuals,
        ClothingProtectionIndex, WORLD_VERSION_B42, clothing_slot, copy_directory,
        delete_character_save, find_style_definition, list_clothing_options, list_style_options,
        load_character_render_assets, parse_character, parse_clothing_script,
        protection_for_visuals, read_raw_characters, resolve_ui2_pack_icon, save_character_stats,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_configured_players_database_fixture() {
        let Some(fixture) = std::env::var_os("PZ_CHARACTER_EDITOR_FIXTURE") else {
            return;
        };
        let players_db = PathBuf::from(fixture).join("players.db");
        let raw = read_raw_characters(&players_db).expect("players.db should be readable");
        assert!(
            !raw.is_empty(),
            "fixture should contain at least one character"
        );
        let parsed = parse_character(raw.into_iter().next().unwrap(), WORLD_VERSION_B42)
            .expect("character blob should parse");
        assert!(!parsed.summary.name.trim().is_empty());
        assert!(parsed.summary.world_x >= 0);
        assert!(parsed.summary.world_y >= 0);
        assert!(!parsed.stats.is_empty());
        assert!(!parsed.skills.is_empty());
        assert!(parsed.info.weight.is_some() || parsed.info.hours_survived.is_some());
        assert!(parsed.temperature.core_temperature.is_some());
    }

    #[test]
    fn saves_stats_to_a_temporary_save_copy() {
        let Some(fixture) = std::env::var_os("PZ_CHARACTER_EDITOR_FIXTURE") else {
            return;
        };
        let source = PathBuf::from(fixture);
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("pz-character-editor-test-{stamp}"));
        let target = root.join("Saves").join("Sandbox").join("fixture-copy");
        fs::create_dir_all(target.parent().expect("target should have a parent"))
            .expect("temporary save parent should be created");
        copy_directory(&source, &target).expect("fixture should be copied");

        let raw = read_raw_characters(&target.join("players.db")).expect("copy should be readable");
        let first = raw
            .into_iter()
            .next()
            .expect("copy should contain a player");
        let next_value = 12.345_f32;
        let snapshot = save_character_stats(
            root.to_string_lossy().into_owned(),
            "Sandbox/fixture-copy".to_string(),
            first.summary.source.clone(),
            first.summary.id,
            CharacterEditPayload {
                stats: vec![CharacterStatValue {
                    id: "Anger".to_string(),
                    label: "Anger".to_string(),
                    value: next_value,
                    moodle_icon: None,
                }],
                body_parts: Vec::new(),
                skills: Vec::new(),
            },
            None,
        )
        .expect("stat update should succeed");
        let anger = snapshot
            .characters
            .iter()
            .find(|character| character.summary.id == first.summary.id)
            .and_then(|character| character.stats.iter().find(|stat| stat.id == "Anger"))
            .expect("updated stat should be present");
        assert!((anger.value - next_value).abs() < 0.001);
        delete_character_save(
            root.to_string_lossy().into_owned(),
            "Sandbox/fixture-copy".to_string(),
        )
        .expect("temporary save copy should be deletable");
        assert!(!target.exists());
        fs::remove_dir_all(root).expect("temporary save copy should be removed");
    }

    #[test]
    fn resolves_build_42_character_assets() {
        let Some(fixture) = std::env::var_os("PZ_CHARACTER_EDITOR_FIXTURE") else {
            return;
        };
        let Some(game_dir) = std::env::var_os("PZ_GAME_DIR") else {
            return;
        };
        let players_db = PathBuf::from(fixture).join("players.db");
        let raw = read_raw_characters(&players_db).expect("players.db should be readable");
        let parsed = parse_character(raw.into_iter().next().unwrap(), WORLD_VERSION_B42)
            .expect("character blob should parse");
        let assets = load_character_render_assets(
            PathBuf::from(game_dir).to_string_lossy().into_owned(),
            parsed.visuals,
        )
        .expect("installed game assets should resolve");
        assert!(assets.models.iter().any(|asset| asset.id == "body"));
        assert!(assets.textures.iter().any(|asset| asset.id == "skin"));
        assert!(!assets.clothing_layers.is_empty());
        assert!(
            assets
                .models
                .iter()
                .any(|asset| asset.id.starts_with("clothing-"))
        );
        assert!(
            assets
                .textures
                .iter()
                .any(|asset| asset.id.starts_with("clothing-texture-"))
        );
        assert!(assets.clothing_layers.iter().any(|layer| {
            layer.item_key.to_lowercase().contains("hat_fedora")
                && layer.attach_bone.as_deref() == Some("Bip01_Head")
        }));
        assert!(assets.clothing_layers.iter().any(|layer| {
            layer
                .item_key
                .to_lowercase()
                .contains("tshirt_profession_firemanred02")
                && layer.model_id.is_none()
                && !layer.texture_ids.is_empty()
        }));
        assert!(assets.animations.iter().any(|asset| asset.id == "idle"));
        assert!(
            assets
                .models
                .iter()
                .all(|asset| asset.data_url.starts_with("data:"))
        );
    }

    #[test]
    fn resolves_build_42_occupation_and_trait_atlas_icons() {
        let game_dir =
            PathBuf::from(r"C:\Program Files (x86)\Steam\steamapps\common\ProjectZomboid");
        if !game_dir.join("media/texturepacks/UI2.pack").is_file() {
            return;
        }
        let occupation = resolve_ui2_pack_icon(&game_dir, "profession", "profession_fireofficer2")
            .expect("Build 42.20 occupation icon should be in UI2.pack");
        let trait_icon = resolve_ui2_pack_icon(&game_dir, "trait_fit", "trait_fit")
            .expect("Build 42.20 trait icon should be in UI2.pack");
        assert!(occupation.data_url.starts_with("data:image/png;base64,"));
        assert!(trait_icon.data_url.starts_with("data:image/png;base64,"));
        assert_ne!(occupation.data_url, trait_icon.data_url);
    }

    #[test]
    fn reads_build_42_customization_definitions() {
        let game_dir =
            PathBuf::from(r"C:\Program Files (x86)\Steam\steamapps\common\ProjectZomboid");
        if !game_dir.join("media").is_dir() {
            return;
        }
        let hair = find_style_definition(&game_dir, "LongBraids", true, true);
        assert!(hair.model.is_some());
        assert!(hair.texture.is_some());
        let beard = find_style_definition(&game_dir, "PointyChin", false, false);
        assert!(beard.model.is_some());
        assert!(!list_style_options(&game_dir, true, true).is_empty());
        assert!(!list_clothing_options(&game_dir).is_empty());
    }

    #[test]
    fn classifies_mask_and_tshirt_catalog_entries_before_generic_names() {
        assert_eq!(clothing_slot("Hat_DustMask"), Some("Mask"));
        assert_eq!(clothing_slot("Tshirt_Fossoil"), Some("T-shirt"));
        assert_eq!(clothing_slot("Shirt_Lumberjack"), Some("Shirt"));
    }

    #[test]
    fn resolves_build_42_clothing_protection_from_item_scripts() {
        let mut index = ClothingProtectionIndex::default();
        parse_clothing_script(
            "module Base {\n    item TestTrousers\n    {\n        BloodLocation = Trousers,\n        BiteDefense = 20,\n        ScratchDefense = 30,\n    }\n}",
            &mut index,
        );
        let visuals = CharacterVisuals {
            gender: "Male".to_string(),
            skin_color: None,
            hair_color: None,
            beard_color: None,
            skin_texture: None,
            hair_model: None,
            beard_model: None,
            body_hair_index: None,
            clothing: vec!["Base.TestTrousers".to_string()],
            gear: Vec::new(),
            items: vec![CharacterVisualItem {
                full_type: "Base.TestTrousers".to_string(),
                clothing_name: Some("TestTrousers".to_string()),
                alternate_model: None,
                base_texture: None,
                texture_choice: None,
            }],
        };
        let protection = protection_for_visuals(&visuals, &index);
        let thighs = protection
            .iter()
            .find(|part| part.id == "UpperLeg_L")
            .expect("thigh protection should be present");
        assert_eq!(thighs.bite, Some(20.0));
        assert_eq!(thighs.scratch, Some(30.0));
    }
}
