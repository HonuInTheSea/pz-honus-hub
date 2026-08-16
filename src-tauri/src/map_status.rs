use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

#[derive(Debug, Deserialize)]
struct MapInfo {
    minlayer: Option<i32>,
    maxlayer: Option<i32>,
}

#[derive(Debug, Serialize)]
pub struct MapRenderStatus {
    pub state: String,
    pub message: String,
    pub expected_layers: usize,
    pub layers_with_dzi: usize,
    pub layers_with_tiles: usize,
    pub available_layers: Vec<i32>,
    pub render_process_active: bool,
}

#[tauri::command]
pub fn allow_map_asset_directory(app: AppHandle, root: String) -> Result<(), String> {
    let raw_root = root.trim();
    if raw_root.is_empty() {
        return Err("Map package folder is empty.".to_string());
    }

    let path = fs::canonicalize(raw_root)
        .map_err(|error| format!("Map package folder could not be resolved: {error}"))?;
    if !path.is_dir() {
        return Err("Map package folder is not a directory.".to_string());
    }

    let parent = path.parent().map(|parent| parent.to_path_buf());
    let scopes = app.state::<tauri::scope::Scopes>();
    scopes
        .allow_directory(path, true)
        .map_err(|error| format!("Map package folder could not be authorized: {error}"))?;

    // The distributed pzmap viewer keeps shared POI definitions beside the
    // selected map_data directory at ../pzmap/i18n/marks_en.json.
    if let Some(parent) = parent {
        scopes
            .allow_directory(parent, true)
            .map_err(|error| format!("Map support files could not be authorized: {error}"))?;
    }

    Ok(())
}

#[tauri::command]
pub fn inspect_map_render_status(root: String, view: String) -> Result<MapRenderStatus, String> {
    let root = root.trim();
    if root.is_empty() {
        return Err("Map package folder is empty.".to_string());
    }

    let map_directory = if view.trim().eq_ignore_ascii_case("top") {
        "base_top"
    } else {
        "base"
    };
    let base = Path::new(root).join(map_directory);
    let map_info_path = base.join("map_info.json");
    let render_process_active = is_render_process_active();

    if !map_info_path.is_file() {
        return Ok(MapRenderStatus {
            state: if render_process_active {
                "rendering"
            } else {
                "error"
            }
            .to_string(),
            message: if render_process_active {
                "Map rendering is in progress; map_info.json has not been written yet.".to_string()
            } else {
                format!(
                    "Map metadata is missing. Select the pzmap2dzi map_data folder containing {map_directory}/map_info.json."
                )
            },
            expected_layers: 0,
            layers_with_dzi: 0,
            layers_with_tiles: 0,
            available_layers: Vec::new(),
            render_process_active,
        });
    }

    let info = match fs::read_to_string(&map_info_path)
        .map_err(|error| error.to_string())
        .and_then(|contents| {
            serde_json::from_str::<MapInfo>(&contents).map_err(|error| error.to_string())
        }) {
        Ok(info) => info,
        Err(error) => {
            return Ok(MapRenderStatus {
                state: if render_process_active {
                    "rendering"
                } else {
                    "error"
                }
                .to_string(),
                message: if render_process_active {
                    format!("Map rendering is in progress; metadata is not complete yet ({error}).")
                } else {
                    format!("Map metadata could not be read: {error}")
                },
                expected_layers: 0,
                layers_with_dzi: 0,
                layers_with_tiles: 0,
                available_layers: Vec::new(),
                render_process_active,
            });
        }
    };

    let min_layer = info.minlayer.unwrap_or(0);
    let max_layer = info.maxlayer.unwrap_or(1);
    let expected_layers = max_layer.saturating_sub(min_layer).max(0) as usize;
    let mut layers_with_dzi = 0;
    let mut layers_with_tiles = 0;
    let mut available_layers = Vec::new();

    for layer in min_layer..max_layer {
        let layer_name = format!("layer{layer}");
        let dzi_path = base.join(format!("{layer_name}.dzi"));
        let tiles_path = base.join(format!("{layer_name}_files"));

        if dzi_path.is_file() {
            layers_with_dzi += 1;
        }
        if contains_webp(&tiles_path) {
            layers_with_tiles += 1;
            available_layers.push(layer);
        }
    }

    let state = if render_process_active {
        "rendering"
    } else if layers_with_dzi < expected_layers || layers_with_tiles < expected_layers {
        "error"
    } else {
        "ready"
    };

    let message = match state {
        "rendering" => format!(
            "Map rendering is in progress: {layers_with_tiles}/{expected_layers} layers currently contain tiles."
        ),
        "error" => format!(
            "Map rendering is incomplete: {layers_with_tiles}/{expected_layers} layers contain tiles and {layers_with_dzi}/{expected_layers} DZI files exist."
        ),
        _ => format!("Map package is ready: {layers_with_tiles} layers contain tiles."),
    };

    Ok(MapRenderStatus {
        state: state.to_string(),
        message,
        expected_layers,
        layers_with_dzi,
        layers_with_tiles,
        available_layers,
        render_process_active,
    })
}

fn contains_webp(path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }

    WalkDir::new(path)
        .into_iter()
        .filter_map(Result::ok)
        .any(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("webp"))
        })
}

fn is_render_process_active() -> bool {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
    );

    system.processes().values().any(|process| {
        let command = process
            .cmd()
            .iter()
            .map(|part| part.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        (command.contains("main.py") && command.contains("render"))
            || command.contains("--pzmap2dzi-worker")
    })
}
