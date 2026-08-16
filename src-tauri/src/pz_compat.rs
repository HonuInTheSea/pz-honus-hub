use serde::Serialize;
use std::path::{Path, PathBuf};

/// Compatibility contract for the Project Zomboid build this application targets.
///
/// These values are intentionally kept in one module.  PZ changes server-file
/// formats independently of the desktop application's release cadence, so a
/// future game update should be reviewable as a small, explicit change here.
pub const WORKSHOP_APP_ID: &str = "108600";
pub const GAME_VERSION: &str = "42.20";
pub const MOD_BREAK_VERSION: &str = "42.0";
pub const WORLD_VERSION: u32 = 249;
pub const SANDBOX_VERSION: u32 = 6;

pub const VANILLA_MAPS: &[&str] = &[
    "Brandenburg, KY",
    "Echo Creek, KY",
    "Ekron, KY",
    "Fallas Lake, KY",
    "Irvington, KY",
    "March Ridge, KY",
    "Muldraugh, KY",
    "Riverside, KY",
    "Rosewood, KY",
    "Valley Station, KY",
    "West Point, KY",
];

pub const SERVER_CONFIG_FILES: &[&str] = &[
    "{name}.ini",
    "{name}_SandboxVars.lua",
    "{name}_spawnregions.lua",
    "{name}_spawnpoints.lua",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PzCompatibilityInfo {
    pub game_version: &'static str,
    pub mod_break_version: &'static str,
    pub world_version: u32,
    pub sandbox_version: u32,
    pub workshop_app_id: &'static str,
    pub vanilla_maps: &'static [&'static str],
    pub server_config_files: &'static [&'static str],
}

#[tauri::command]
pub fn get_pz_compatibility_info() -> PzCompatibilityInfo {
    PzCompatibilityInfo {
        game_version: GAME_VERSION,
        mod_break_version: MOD_BREAK_VERSION,
        world_version: WORLD_VERSION,
        sandbox_version: SANDBOX_VERSION,
        workshop_app_id: WORKSHOP_APP_ID,
        vanilla_maps: VANILLA_MAPS,
        server_config_files: SERVER_CONFIG_FILES,
    }
}

pub(crate) fn server_dir(user_dir: &str) -> PathBuf {
    Path::new(user_dir).join("Server")
}

pub(crate) fn validate_server_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return Err("Server name is empty or invalid.".to_string());
    }
    if trimmed
        .chars()
        .any(|character| character.is_control() || "<>:\"/\\|?*".contains(character))
    {
        return Err(
            "Server name contains characters that are not valid in a file name.".to_string(),
        );
    }
    if Path::new(trimmed).components().count() != 1 {
        return Err("Server name must be a single file name.".to_string());
    }
    Ok(trimmed)
}

pub(crate) fn server_config_paths(user_dir: &str, server_name: &str) -> Vec<PathBuf> {
    let base = server_dir(user_dir);
    vec![
        base.join(format!("{server_name}.ini")),
        base.join(format!("{server_name}_SandboxVars.lua")),
        base.join(format!("{server_name}_spawnregions.lua")),
        base.join(format!("{server_name}_spawnpoints.lua")),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_the_b42_20_contract() {
        assert_eq!(GAME_VERSION, "42.20");
        assert_eq!(MOD_BREAK_VERSION, "42.0");
        assert_eq!(WORLD_VERSION, 249);
        assert_eq!(SANDBOX_VERSION, 6);
        assert_eq!(VANILLA_MAPS.len(), 11);
    }

    #[test]
    fn rejects_server_names_that_escape_the_server_directory() {
        assert!(validate_server_name("My Server").is_ok());
        assert!(validate_server_name("..").is_err());
        assert!(validate_server_name("../outside").is_err());
        assert!(validate_server_name("bad/name").is_err());
        assert!(validate_server_name("bad:name").is_err());
    }

    #[test]
    fn keeps_server_file_names_in_one_contract() {
        let paths = server_config_paths("C:\\Users\\Player\\Zomboid", "Honu");
        assert_eq!(paths.len(), SERVER_CONFIG_FILES.len());
        assert!(paths[0].ends_with("Server\\Honu.ini"));
        assert!(paths[1].ends_with("Server\\Honu_SandboxVars.lua"));
    }
}
