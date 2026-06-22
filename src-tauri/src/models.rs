use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

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
