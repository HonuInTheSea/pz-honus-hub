//! Native save-game source discovery.
//!
//! Save chunks are versioned independently from static map cells. This module
//! keeps that boundary explicit and produces a machine-readable inventory for
//! the viewer while the chunk sprite decoder is extended version by version.

use super::output::{ImageSaveOptions, OutputFormat, RgbaImage};
use super::save_chunk;
use super::world_dictionary;
use super::{CellRect, Geometry, TextureLibrary, cache};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) fn render_inventory(
    config: &Value,
    output_html: &Path,
    map_version: Option<u32>,
    emit: &mut impl FnMut(f32, &str, &str),
) -> Result<Vec<SaveInfo>, String> {
    let root = config_string(config, "save_game_root")
        .map(|value| expand_environment(&value))
        .map(|value| super::filesystem_path(&value));
    let parser = parser_metadata(config);
    let Some(root) = root else {
        write_index(output_html, Vec::new(), &parser)?;
        super::write_rendered_map_list(output_html, "saves")?;
        return Ok(Vec::new());
    };
    let (requested_all, requested_names) = requested_save_names(config);
    emit(
        63.7,
        "saves",
        if requested_all {
            "Discovering all save-game folders"
        } else {
            "Resolving explicitly configured save-game folders"
        },
    );
    let saves = if requested_all {
        discover_saves(&root)
    } else {
        requested_names
            .into_iter()
            .map(|name| {
                let path = root.join(super::filesystem_path(&name));
                (name, path)
            })
            .collect()
    };
    emit(
        63.72,
        "saves",
        &format!("Found {} candidate save folder(s)", saves.len()),
    );
    let pz_root = config_string(config, "pz_root").map(|value| super::filesystem_path(&value));
    let mod_root = config_string(config, "mod_root").map(|value| super::filesystem_path(&value));
    let dump_failed_chunks = config_bool(config, "save_game_dump_failed_chunks");
    let mut entries = Vec::new();
    let mut infos = Vec::new();
    let total_saves = saves.len();
    for (save_index, (name, path)) in saves.into_iter().enumerate() {
        emit(
            63.72 + 0.06 * (save_index as f32 / total_saves.max(1) as f32),
            "saves",
            &format!(
                "Inspecting save {}/{}: {}",
                save_index + 1,
                total_saves,
                name
            ),
        );
        if requested_all {
            let world_version = scan_chunks(&path)
                .first()
                .and_then(|chunk| read_world_version(&chunk.path));
            if let Some(map_version) = map_version {
                if !versions_match(map_version, world_version) {
                    continue;
                }
            }
        }
        let info = inspect_save(
            &name,
            &path,
            pz_root.as_deref(),
            mod_root.as_deref(),
            output_html,
            dump_failed_chunks,
        );
        write_save_metadata(output_html, &name, &info)?;
        entries.push(info.json());
        infos.push(info);
    }
    write_index(output_html, entries, &parser)?;
    super::write_rendered_map_list(output_html, "saves")?;
    Ok(infos)
}

fn versions_match(map_version: u32, world_version: Option<u32>) -> bool {
    world_version.is_some_and(|version| (map_version == 0) == (version <= 195))
}

fn requested_save_names(config: &Value) -> (bool, Vec<String>) {
    let Some(value) = config.get("save_games") else {
        return (true, Vec::new());
    };
    if value
        .as_str()
        .is_some_and(|text| text.trim().eq_ignore_ascii_case("all"))
    {
        return (true, Vec::new());
    }
    (false, super::configured_names(config, "save_games"))
}

#[derive(Debug, Clone)]
pub(crate) struct SaveInfo {
    name: String,
    path: PathBuf,
    world_version: Option<u32>,
    block_size: usize,
    chunks: Vec<SaveChunk>,
    tile_defs: HashMap<i32, String>,
    parsed_squares: usize,
    sprite_count: usize,
    parse_failures: usize,
    failed_chunk_dumps: usize,
    parse_error_details: Vec<String>,
    square_coordinate_checksum: u64,
    parsed_layer_span: i32,
    parsed_min_layer: Option<i32>,
    parsed_max_layer: Option<i32>,
    world_dictionary_sprite_count: usize,
}

#[derive(Debug, Clone)]
pub(crate) struct SaveChunk {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) path: PathBuf,
    pub(crate) bytes: u64,
}

struct ParsedSaveChunk {
    data: save_chunk::SavedChunk,
}

struct SaveChunkCache {
    entries: HashMap<(usize, i32, i32), Option<ParsedSaveChunk>>,
    order: VecDeque<(usize, i32, i32)>,
    capacity: usize,
}

impl SaveChunkCache {
    const CAPACITY: usize = 128;

    fn new() -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            capacity: Self::CAPACITY,
        }
    }

    fn get(&mut self, save_index: usize, chunk: &SaveChunk) -> Option<&save_chunk::SavedChunk> {
        let key = (save_index, chunk.x, chunk.y);
        if !self.entries.contains_key(&key) {
            let parsed = save_chunk::parse_file(&chunk.path)
                .ok()
                .map(|data| ParsedSaveChunk { data });
            self.entries.insert(key, parsed);
        }
        self.order.retain(|entry| *entry != key);
        self.order.push_back(key);
        while self.order.len() > self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.entries.remove(&evicted);
            }
        }
        self.entries
            .get(&key)
            .and_then(Option::as_ref)
            .map(|parsed| &parsed.data)
    }
}

impl SaveInfo {
    fn json(&self) -> Value {
        json!({
            "name": self.name,
            "path": self.path,
            "version": self.world_version.map(|version| if version <= 195 { "B41" } else { "B42" }),
            "world_version": self.world_version,
            "block_size": self.block_size,
            "block_count": self.chunks.len(),
            "chunks": self.chunks.iter().map(|chunk| json!({
                "x": chunk.x,
                "y": chunk.y,
                "path": chunk.path,
                "bytes": chunk.bytes
            })).collect::<Vec<_>>(),
            "tile_definition_count": self.tile_defs.len(),
            "world_dictionary_sprite_count": self.world_dictionary_sprite_count,
            "parsed_squares": self.parsed_squares,
            "sprite_count": self.sprite_count,
            "chunk_parse_failures": self.parse_failures,
            "failed_chunk_dumps": self.failed_chunk_dumps,
            "parse_error_details": self.parse_error_details,
            "square_coordinate_checksum": self.square_coordinate_checksum,
            "parsed_layer_span": self.parsed_layer_span,
            "parsed_min_layer": self.parsed_min_layer,
            "parsed_max_layer": self.parsed_max_layer,
            "renderer": "rust-pzmap2dzi-save-source"
        })
    }
}

/// Render parsed save squares into the same DZI coordinate system as the
/// static map. Save chunks are block-addressed, so the renderer translates
/// each local square to world-square coordinates before drawing either view.
#[allow(clippy::too_many_arguments)]
pub(crate) fn render_views(
    saves: &[SaveInfo],
    output_html: &Path,
    stop_path: &Path,
    geometry: &Geometry,
    render_ranges: Option<&[CellRect]>,
    cell_rects: &[CellRect],
    textures: &mut TextureLibrary,
    texture_paths: &[PathBuf],
    tile_size: usize,
    omit_levels: usize,
    layer_range: std::ops::Range<i32>,
    output_format: OutputFormat,
    image_save_options: ImageSaveOptions,
    config: &Value,
    emit: &mut impl FnMut(f32, &str, &str),
) -> Result<(), String> {
    let mut chunk_cache = SaveChunkCache::new();
    let save_config = super::effective_command_config(config, "save");
    let save_top_config = super::effective_command_config(config, "save_top");
    let save_tile_size = render_tile_size(&save_config, tile_size);
    let save_top_tile_size = render_tile_size(&save_top_config, tile_size);
    let save_geometry =
        geometry.with_layout(save_tile_size, render_tile_align_levels(&save_config, 1));
    let save_top_geometry = geometry.with_layout(
        save_top_tile_size,
        render_tile_align_levels(&save_top_config, 1),
    );
    let save_omit_levels = render_omit_levels(&save_config, omit_levels);
    let save_top_omit_levels = render_omit_levels(&save_top_config, omit_levels);
    let save_layer_range =
        super::configured_layer_range(&save_config, layer_range.start, layer_range.end)?;
    let save_top_layer_range =
        super::configured_layer_range(&save_top_config, layer_range.start, layer_range.end)?;
    let save_render_ranges = super::configured_cell_ranges(&save_config, "render_cell_range")?;
    let save_top_render_ranges =
        super::configured_cell_ranges(&save_top_config, "render_cell_range")?;
    let save_output_format = render_output_format(&save_config, output_format);
    let save_top_output_format = render_output_format(&save_top_config, output_format);
    let save_image_options = render_image_options(&save_config, image_save_options);
    let save_top_image_options = render_image_options(&save_top_config, image_save_options);
    let save_top_view_color_mode = config_string_nested(&save_top_config, "top_view_color_mode")
        .unwrap_or_else(|| "base+water".to_string());
    let save_plant_config = save_texture_config(&save_config);
    let save_top_plant_config = save_texture_config(&save_top_config);
    for (save_index, save) in saves.iter().enumerate() {
        super::ensure_not_stopped(stop_path)?;
        if save.chunks.is_empty() {
            emit(
                94.0 + (save_index as f32 / saves.len().max(1) as f32) * 5.0,
                "save",
                &format!("Skipping save {} because it has no chunks", save.name),
            );
            continue;
        }
        emit(
            94.0 + (save_index as f32 / saves.len().max(1) as f32) * 5.0,
            "save",
            &format!(
                "Rendering save {}/{}: {} ({} chunks)",
                save_index + 1,
                saves.len(),
                save.name,
                save.chunks.len()
            ),
        );
        let mut source_paths = save
            .chunks
            .iter()
            .map(|chunk| chunk.path.clone())
            .collect::<Vec<_>>();
        for texture_path in texture_paths {
            collect_files(texture_path, &mut source_paths);
        }
        let signature = if cache::enabled(config) {
            cache::signature(config, source_paths)
        } else {
            cache::disabled_signature().to_string()
        };
        let save_signature = cache::scoped_signature(&save_config, &signature);
        let save_top_signature = cache::scoped_signature(&save_top_config, &signature);
        let safe_name = safe_name(&save.name);
        textures.configure_plants_with_progress(&save_plant_config, |message| {
            emit(
                94.0 + (save_index as f32 / saves.len().max(1) as f32) * 5.0,
                "save",
                &format!("{}: {message}", save.name),
            )
        })?;
        for layer in geometry_layer_range(&save_geometry, save, &save_layer_range) {
            render_save_view(
                save,
                save_index,
                &mut chunk_cache,
                &safe_name,
                "base",
                layer,
                false,
                output_html,
                stop_path,
                &save_geometry,
                save_render_ranges.as_deref().or(render_ranges),
                cell_rects,
                layer_range.start,
                textures,
                save_tile_size,
                save_omit_levels,
                save_output_format,
                save_image_options,
                &save_signature,
                super::configured_pyramid_backend(&save_config),
                super::configured_pyramid_cache_limit_mb(&save_config),
                "base+water",
                emit,
            )?;
        }
        textures.configure_plants_with_progress(&save_top_plant_config, |message| {
            emit(
                94.0 + (save_index as f32 / saves.len().max(1) as f32) * 5.0,
                "save",
                &format!("{} top-view: {message}", save.name),
            )
        })?;
        for layer in geometry_layer_range(&save_top_geometry, save, &save_top_layer_range) {
            render_save_view(
                save,
                save_index,
                &mut chunk_cache,
                &safe_name,
                "base_top",
                layer,
                true,
                output_html,
                stop_path,
                &save_top_geometry,
                save_top_render_ranges.as_deref().or(render_ranges),
                cell_rects,
                layer_range.start,
                textures,
                save_top_tile_size,
                save_top_omit_levels,
                save_top_output_format,
                save_top_image_options,
                &save_top_signature,
                super::configured_pyramid_backend(&save_top_config),
                super::configured_pyramid_cache_limit_mb(&save_top_config),
                &save_top_view_color_mode,
                emit,
            )?;
        }
        emit(
            95.0 + (save_index as f32 / saves.len().max(1) as f32) * 5.0,
            "save",
            &format!("rust-pzmap2dzi save rendered {}", save.name),
        );
    }
    Ok(())
}

fn geometry_layer_range(
    geometry: &Geometry,
    save: &SaveInfo,
    requested: &std::ops::Range<i32>,
) -> std::ops::Range<i32> {
    let min_layer = save
        .parsed_min_layer
        .unwrap_or(geometry_layer_min(geometry));
    let max_layer = save
        .parsed_max_layer
        .unwrap_or(geometry_layer_min(geometry) + 1);
    min_layer.max(requested.start)..max_layer.min(requested.end)
}

fn geometry_layer_min(_geometry: &Geometry) -> i32 {
    0
}

#[allow(clippy::too_many_arguments)]
fn render_save_view(
    save: &SaveInfo,
    save_index: usize,
    chunk_cache: &mut SaveChunkCache,
    safe_name: &str,
    view: &str,
    layer: i32,
    top_view: bool,
    output_html: &Path,
    stop_path: &Path,
    geometry: &Geometry,
    render_ranges: Option<&[CellRect]>,
    cell_rects: &[CellRect],
    render_min_layer: i32,
    textures: &mut TextureLibrary,
    tile_size: usize,
    omit_levels: usize,
    output_format: OutputFormat,
    image_save_options: ImageSaveOptions,
    source_signature: &str,
    pyramid_backend: super::PyramidBackend,
    pyramid_cache_limit_mb: usize,
    top_view_color_mode: &str,
    emit: &mut impl FnMut(f32, &str, &str),
) -> Result<(), String> {
    let width = if top_view {
        geometry.top_width
    } else {
        geometry.iso_width
    };
    let height = if top_view {
        geometry.top_height
    } else {
        geometry.iso_height
    };
    let levels = super::pyramid_levels(width.max(1), height.max(1));
    let visible_levels = super::retained_pyramid_levels(&levels, omit_levels);
    let max_level = levels.len() - 1;
    let visible_width = visible_levels.last().map(|(w, _)| *w).unwrap_or(width);
    let visible_height = visible_levels.last().map(|(_, h)| *h).unwrap_or(height);
    let base = output_html
        .join("map_data/saves")
        .join(safe_name)
        .join(view);
    let map_info = json!({
        "w": visible_width,
        "h": visible_height,
        "skip": omit_levels,
        "x0": super::map_info_origin(geometry, top_view).0,
        "y0": super::map_info_origin(geometry, top_view).1,
        "sqr": if top_view { geometry.top_square_size } else { super::ISO_SQUARE_WIDTH as usize },
        "cell_size": geometry.cell_size,
        "block_size": save.block_size,
        "minlayer": save.parsed_min_layer.unwrap_or(layer),
        "maxlayer": save.parsed_max_layer.unwrap_or(layer + 1),
        "pz_version": save.world_version.map(|version| if version <= 195 { "B41" } else { "B42" }),
        "pzmap2dzi_version": "rust-pzmap2dzi",
        "cell_rects": cell_rects.iter().map(|range| json!([
            range.x, range.y, range.width, range.height
        ])).collect::<Vec<_>>(),
        "renderer": "pzmap2dzi-rust-save"
    });
    super::ensure_map_info_compatible(&base, &map_info)?;
    let cache_path = base.join(format!("layer{layer}.rust-cache"));
    if cache::is_current(&cache_path, source_signature)
        && super::pyramid_outputs_exist(&base, layer, visible_levels, tile_size, output_format)
    {
        return Ok(());
    }
    fs::create_dir_all(base.join(format!("layer{layer}_files/{max_level}")))
        .map_err(|error| error.to_string())?;
    let tiles_x = width.div_ceil(tile_size);
    let tiles_y = height.div_ceil(tile_size);
    let total = (tiles_x * tiles_y).max(1);
    for tile_y in 0..tiles_y {
        for tile_x in 0..tiles_x {
            super::ensure_not_stopped(stop_path)?;
            let tile_width = tile_size.min(width.saturating_sub(tile_x * tile_size));
            let tile_height = tile_size.min(height.saturating_sub(tile_y * tile_size));
            let mut image = RgbaImage::new(tile_width.max(1), tile_height.max(1));
            draw_save_tile(
                &mut image,
                tile_x,
                tile_y,
                tile_size,
                top_view,
                geometry,
                save,
                save_index,
                chunk_cache,
                render_ranges,
                textures,
                layer,
                top_view_color_mode,
            )?;
            super::composite_lower_layers(
                &base,
                &mut image,
                layer,
                render_min_layer,
                max_level,
                tile_x,
                tile_y,
                output_format,
            )?;
            super::write_optional_tile(
                &image,
                &base.join(format!(
                    "layer{layer}_files/{max_level}/{tile_x}_{tile_y}.{}",
                    output_format.extension()
                )),
                output_format,
                image_save_options,
                layer == 0,
            )?;
            let complete = tile_y * tiles_x + tile_x + 1;
            emit(
                87.0 + complete as f32 / total as f32 * 7.0,
                "save",
                &format!("rust-pzmap2dzi save {safe_name} {view} tile {complete}/{total}"),
            );
        }
    }
    emit(
        94.0,
        "save_pyramid",
        &format!(
            "Building save {safe_name} {view} layer {layer} Deep Zoom pyramid: {} source level(s); {} CPU workers; {} MB RAM budget; backend={}",
            max_level,
            super::pyramid_worker_count(tile_size).0,
            super::pyramid_worker_count(tile_size).2 / (1024 * 1024),
            pyramid_backend.label()
        ),
    );
    let pyramid_started = std::time::Instant::now();
    let mut last_pyramid_report = std::time::Instant::now();
    super::build_pyramid_with_progress(
        stop_path,
        &base,
        layer,
        &levels,
        tile_size,
        output_format,
        image_save_options,
        source_signature,
        pyramid_cache_limit_mb,
        pyramid_backend,
        |level, level_complete, level_total, complete, total| {
            super::ensure_not_stopped(stop_path)?;
            if level_complete == 1
                || level_complete == level_total
                || last_pyramid_report.elapsed().as_secs() >= 5
            {
                emit(
                    94.0 + complete as f32 / total.max(1) as f32,
                    "save_pyramid",
                    &format!(
                        "Building save {safe_name} {view} layer {layer} pyramid: level {level}/{max_level} tile {level_complete}/{level_total} ({complete}/{total}), elapsed {:.1}s",
                        pyramid_started.elapsed().as_secs_f64()
                    ),
                );
                last_pyramid_report = std::time::Instant::now();
            }
            Ok(())
        },
    )?;
    emit(
        95.0,
        "save_pyramid",
        &format!("Completed save {safe_name} {view} layer {layer} Deep Zoom pyramid"),
    );
    super::prune_pyramid_levels(&base, layer, levels.len(), visible_levels.len())?;
    let dzi = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Image TileSize=\"{tile_size}\" Overlap=\"0\" Format=\"{}\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"{visible_width}\" Height=\"{visible_height}\"/></Image>",
        output_format.dzi_name()
    );
    fs::write(base.join(format!("layer{layer}.dzi")), dzi).map_err(|error| error.to_string())?;
    fs::write(
        base.join("map_info.json"),
        serde_json::to_vec_pretty(&map_info).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    cache::write(&cache_path, source_signature)
}

fn draw_save_tile(
    image: &mut RgbaImage,
    tile_x: usize,
    tile_y: usize,
    tile_size: usize,
    top_view: bool,
    geometry: &Geometry,
    save: &SaveInfo,
    save_index: usize,
    chunk_cache: &mut SaveChunkCache,
    render_ranges: Option<&[CellRect]>,
    textures: &mut TextureLibrary,
    layer: i32,
    top_view_color_mode: &str,
) -> Result<(), String> {
    let offset_x = (tile_x * tile_size) as i32;
    let offset_y = (tile_y * tile_size) as i32;
    for chunk in &save.chunks {
        let Some(parsed) = chunk_cache.get(save_index, chunk) else {
            continue;
        };
        for square in &parsed.squares {
            let square_x = chunk.x * save.block_size as i32 + square.x as i32;
            let square_y = chunk.y * save.block_size as i32 + square.y as i32;
            if !super::in_ranges(
                render_ranges,
                square_x.div_euclid(geometry.cell_size),
                square_y.div_euclid(geometry.cell_size),
            ) {
                continue;
            }
            let Some(sprites) = square
                .layers
                .iter()
                .find_map(|(square_layer, sprites)| (*square_layer == layer).then_some(sprites))
            else {
                continue;
            };
            let tile_names = sprites
                .iter()
                .filter_map(|sprite| save.tile_defs.get(sprite))
                .cloned()
                .collect::<Vec<_>>();
            if tile_names.is_empty() {
                continue;
            }
            if top_view {
                let pixel_x = (square_x - geometry.min_cell_x * geometry.cell_size)
                    * geometry.top_square_size as i32
                    - offset_x;
                let pixel_y = (square_y - geometry.min_cell_y * geometry.cell_size)
                    * geometry.top_square_size as i32
                    - offset_y;
                let color =
                    super::top_view_color(&tile_names, textures, top_view_color_mode, layer)?;
                for y in 0..geometry.top_square_size as i32 {
                    for x in 0..geometry.top_square_size as i32 {
                        image.set_pixel(pixel_x + x, pixel_y + y, color);
                    }
                }
            } else {
                let grid_x = square_x - square_y;
                let grid_y = square_x + square_y;
                let pixel_x = (grid_x - geometry.min_x) * super::ISO_GRID_WIDTH - offset_x;
                let pixel_y = (grid_y - geometry.min_y) * super::ISO_GRID_HEIGHT
                    + super::ISO_SQUARE_HEIGHT / 2
                    + layer.saturating_mul(6) * super::ISO_GRID_HEIGHT
                    - offset_y;
                for name in &tile_names {
                    if let Some(texture) = textures.texture(name)? {
                        texture.composite_into(image, pixel_x, pixel_y);
                    }
                }
            }
        }
    }
    Ok(())
}

fn collect_files(path: &Path, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let child = entry.path();
        paths.push(child.clone());
        if child.is_dir() {
            collect_files(&child, paths);
        }
    }
}

fn safe_name(name: &str) -> String {
    super::sanitize_component(name)
}

fn discover_saves(root: &Path) -> Vec<(String, PathBuf)> {
    let mut saves = Vec::new();
    let Ok(modes) = fs::read_dir(root) else {
        return saves;
    };
    for mode in modes
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
    {
        let mode_path = mode.path();
        let mode_name = mode.file_name().to_string_lossy().to_string();
        if !scan_chunks(&mode_path).is_empty() {
            saves.push((mode_name, mode_path));
            continue;
        }
        if let Ok(children) = fs::read_dir(&mode_path) {
            for save in children
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_dir())
            {
                let path = save.path();
                if scan_chunks(&path).is_empty() {
                    continue;
                }
                let save_name = save.file_name().to_string_lossy().to_string();
                saves.push((format!("{mode_name}/{save_name}"), path));
            }
        }
    }
    saves
}

fn inspect_save(
    name: &str,
    path: &Path,
    pz_root: Option<&Path>,
    mod_root: Option<&Path>,
    output_html: &Path,
    dump_failed_chunks: bool,
) -> SaveInfo {
    let chunks = scan_chunks(path);
    let world_version = chunks
        .first()
        .and_then(|chunk| read_world_version(&chunk.path));
    let block_size = if world_version.is_some_and(|version| version <= 195) {
        10
    } else {
        8
    };
    let mut tile_defs = pz_root
        .map(|root| load_tile_defs(root, block_size == 10, mod_root))
        .unwrap_or_default();
    let world_dictionary_sprite_count = find_world_dictionary(path)
        .and_then(|dictionary| world_dictionary::load_sprites(&dictionary, block_size == 10).ok())
        .map(|sprites| {
            let count = sprites.len();
            tile_defs.extend(sprites);
            count
        })
        .unwrap_or_default();
    let mut parsed_squares = 0;
    let mut sprite_count = 0;
    let mut parse_failures = 0;
    let mut failed_chunk_dumps = 0;
    let mut parse_error_details = Vec::new();
    let mut square_coordinate_checksum = 0u64;
    let mut parsed_layer_span = 0i32;
    let mut parsed_min_layer = None;
    let mut parsed_max_layer = None;
    for chunk in &chunks {
        match save_chunk::parse_file(&chunk.path) {
            Ok(parsed) => {
                if parsed.block_size != block_size
                    || parsed.world_version != world_version.unwrap_or(parsed.world_version)
                {
                    parse_failures += 1;
                }
                parsed_squares += parsed.squares.len();
                parsed_layer_span = parsed_layer_span.max(parsed.max_layer - parsed.min_layer);
                parsed_min_layer = Some(
                    parsed_min_layer
                        .unwrap_or(parsed.min_layer)
                        .min(parsed.min_layer),
                );
                parsed_max_layer = Some(
                    parsed_max_layer
                        .unwrap_or(parsed.max_layer)
                        .max(parsed.max_layer),
                );
                square_coordinate_checksum =
                    parsed
                        .squares
                        .iter()
                        .fold(square_coordinate_checksum, |checksum, square| {
                            checksum.wrapping_add((square.x as u64) << 32 | square.y as u64)
                        });
                sprite_count += parsed
                    .squares
                    .iter()
                    .flat_map(|square| square.layers.iter())
                    .map(|(_, sprites)| sprites.len())
                    .sum::<usize>();
            }
            Err(error) => {
                parse_failures += 1;
                if parse_error_details.len() < 64 {
                    parse_error_details.push(format!("chunk ({}, {}): {error}", chunk.x, chunk.y));
                }
                if dump_failed_chunks && dump_failed_chunk(output_html, name, chunk).is_ok() {
                    failed_chunk_dumps += 1;
                }
            }
        }
    }
    SaveInfo {
        name: name.to_string(),
        path: path.to_path_buf(),
        world_version,
        block_size,
        chunks,
        tile_defs,
        parsed_squares,
        sprite_count,
        parse_failures,
        failed_chunk_dumps,
        parse_error_details,
        square_coordinate_checksum,
        parsed_layer_span,
        parsed_min_layer,
        parsed_max_layer,
        world_dictionary_sprite_count,
    }
}

fn config_bool(config: &Value, key: &str) -> bool {
    config
        .get(key)
        .and_then(Value::as_bool)
        .or_else(|| {
            config
                .get("render_conf")
                .and_then(|render| render.get(key))
                .and_then(Value::as_bool)
        })
        .unwrap_or(false)
}

fn parser_metadata(config: &Value) -> Value {
    let render = config.get("render_conf");
    json!({
        "implementation": "native-rust",
        "requested_tag": render.and_then(|value| value.get("save_game_parser_tag")),
        "requested_path": render.and_then(|value| value.get("save_game_parser_path")),
        "external_parser_used": false,
        "note": "The native Rust parser is authoritative; requested Python parser settings are retained for compatibility diagnostics."
    })
}

fn dump_failed_chunk(output_html: &Path, save_name: &str, chunk: &SaveChunk) -> Result<(), String> {
    let safe_save = safe_name(save_name);
    let directory = output_html
        .join("map_data/saves")
        .join(safe_save)
        .join("failed_chunks");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let destination = directory.join(format!("{}_{}.bin", chunk.x, chunk.y));
    fs::copy(&chunk.path, destination).map_err(|error| error.to_string())?;
    Ok(())
}

fn find_world_dictionary(save_path: &Path) -> Option<PathBuf> {
    [
        save_path.to_path_buf(),
        save_path.parent()?.to_path_buf(),
        save_path.parent()?.parent()?.to_path_buf(),
    ]
    .into_iter()
    .map(|root| root.join("WorldDictionary.bin"))
    .find(|path| path.is_file())
}

fn write_index(output_html: &Path, saves: Vec<Value>, parser: &Value) -> Result<(), String> {
    let path = output_html.join("map_data/saves/index.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&json!({
            "renderer": "rust-pzmap2dzi-save-source",
            "parser": parser,
            "saves": saves
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn write_save_metadata(output_html: &Path, name: &str, info: &SaveInfo) -> Result<(), String> {
    let safe_name = name.replace(['\\', '/'], "_");
    let path = output_html
        .join("map_data/saves")
        .join(safe_name)
        .join("source.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&info.json()).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn scan_chunks(path: &Path) -> Vec<SaveChunk> {
    let map = path.join("map");
    let mut chunks = Vec::new();
    if map.is_dir() {
        for folder in fs::read_dir(&map)
            .ok()
            .into_iter()
            .flat_map(|entries| entries.filter_map(Result::ok))
        {
            if !folder.path().is_dir()
                || folder.file_name().to_string_lossy().parse::<i32>().is_err()
            {
                continue;
            }
            let Ok(x) = folder.file_name().to_string_lossy().parse::<i32>() else {
                continue;
            };
            for file in fs::read_dir(folder.path())
                .ok()
                .into_iter()
                .flat_map(|entries| entries.filter_map(Result::ok))
            {
                if file.path().extension().is_some_and(|ext| ext == "bin") {
                    let Ok(y) = file
                        .file_name()
                        .to_string_lossy()
                        .trim_end_matches(".bin")
                        .parse::<i32>()
                    else {
                        continue;
                    };
                    chunks.push(chunk(x, y, file.path()));
                }
            }
        }
    }
    let legacy_root = if map.is_dir() { &map } else { path };
    if let Ok(entries) = fs::read_dir(legacy_root) {
        for file in entries.filter_map(Result::ok) {
            let name = file.file_name().to_string_lossy().to_string();
            if let Some((x, y)) = parse_old_chunk_name(&name) {
                chunks.push(chunk(x, y, file.path()));
            }
        }
    }
    chunks.sort_by_key(|chunk| (chunk.x, chunk.y));
    chunks
}

fn chunk(x: i32, y: i32, path: PathBuf) -> SaveChunk {
    let bytes = fs::metadata(&path)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    SaveChunk { x, y, path, bytes }
}

fn parse_old_chunk_name(name: &str) -> Option<(i32, i32)> {
    let stem = name.strip_prefix("map_")?.strip_suffix(".bin")?;
    let (x, y) = stem.split_once('_')?;
    Some((x.parse().ok()?, y.parse().ok()?))
}

fn read_world_version(path: &Path) -> Option<u32> {
    let data = fs::read(path).ok()?;
    if data.len() < 5 {
        return None;
    }
    Some(u32::from_be_bytes(data[1..5].try_into().ok()?))
}

fn load_tile_defs(pz_root: &Path, b41: bool, mod_root: Option<&Path>) -> HashMap<i32, String> {
    let files_b41 = [
        Some("tiledefinitions.tiles"),
        Some("newtiledefinitions.tiles"),
        Some("tiledefinitions_erosion.tiles"),
        Some("tiledefinitions_apcom.tiles"),
        Some("tiledefinitions_overlays.tiles"),
        None,
    ];
    let files_b42 = [
        None,
        Some("newtiledefinitions.tiles"),
        Some("tiledefinitions_erosion.tiles"),
        None,
        Some("tiledefinitions_overlays.tiles"),
        Some("tiledefinitions_b42chunkcaching.tiles"),
    ];
    let files = if b41 { files_b41 } else { files_b42 };
    let mut defs = HashMap::new();
    for (file_number, file_name) in files.into_iter().enumerate() {
        let Some(file_name) = file_name else { continue };
        let path = pz_root.join("media").join(file_name);
        read_tile_definition_file(&path, file_number as i32, &mut defs);
    }
    if let Some(mod_root) = mod_root {
        load_mod_tile_defs(mod_root, b41, &mut defs);
    }
    load_jumbo_tree_defs(if b41 { 5 } else { 6 }, &mut defs);
    defs
}

fn load_jumbo_tree_defs(file_number: i32, defs: &mut HashMap<i32, String>) {
    const TREES: [(&str, u32, bool); 11] = [
        ("americanholly", 1, true),
        ("americanlinden", 2, false),
        ("canadianhemlock", 3, true),
        ("carolinasilverbell", 4, false),
        ("cockspurhawthorn", 5, false),
        ("dogwood", 6, false),
        ("easternredbud", 7, false),
        ("redmaple", 8, false),
        ("riverbirch", 9, false),
        ("virginiapine", 10, true),
        ("yellowwood", 11, false),
    ];
    let file_offset = file_number * 512 * 512;
    defs.insert(file_offset + 12 * 512, "jumbo_tree_01_0".into());
    for (name, tileset, evergreen) in TREES {
        let rows = if evergreen { 2 } else { 6 };
        for row in 0..rows {
            for column in 0..2 {
                let tile_number = row * 2 + column;
                let id = file_offset + tileset as i32 * 512 + tile_number;
                defs.insert(id, format!("e_{name}JUMBO_1_{tile_number}"));
            }
        }
    }
}

fn read_tile_definition_file(path: &Path, file_number: i32, defs: &mut HashMap<i32, String>) {
    let Ok(data) = fs::read(path) else { return };
    let mut reader = LittleReader::new(&data);
    if reader.bytes(4).as_deref() != Some(b"tdef") {
        return;
    }
    let _version = reader.u32();
    let Some(sheet_count) = reader.u32() else {
        return;
    };
    let (index_offset, page_size) = if file_number == 1 {
        (110_000_i64, 1_000_i64)
    } else {
        (i64::from(file_number) * 512 * 512, 512_i64)
    };
    for _ in 0..sheet_count {
        let Some(sheet_name) = reader.line() else {
            return;
        };
        let Some(_image_name) = reader.line() else {
            return;
        };
        let _w = reader.u32();
        let _h = reader.u32();
        let Some(sheet_number) = reader.u32() else {
            return;
        };
        let Some(tile_count) = reader.u32() else {
            return;
        };
        for tile_index in 0..tile_count {
            let Some(property_count) = reader.u32() else {
                return;
            };
            for _ in 0..property_count {
                let _ = reader.line();
                let _ = reader.line();
            }
            let name = format!(
                "{}_{}",
                String::from_utf8_lossy(&sheet_name).trim(),
                tile_index
            );
            let Some(id) = index_offset
                .checked_add(i64::from(sheet_number).saturating_mul(page_size))
                .and_then(|value| value.checked_add(i64::from(tile_index)))
                .and_then(|value| i32::try_from(value).ok())
            else {
                continue;
            };
            defs.insert(id, name);
        }
    }
}

fn load_mod_tile_defs(mod_root: &Path, b41: bool, defs: &mut HashMap<i32, String>) {
    let Ok(entries) = fs::read_dir(mod_root) else {
        return;
    };
    for workshop in entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
    {
        let mods = workshop.path().join("mods");
        let Ok(mod_entries) = fs::read_dir(mods) else {
            continue;
        };
        for mod_entry in mod_entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
        {
            let info = mod_entry.path().join("mod.info");
            let Ok(text) = fs::read_to_string(&info) else {
                continue;
            };
            let Some(tiledef) = text
                .lines()
                .find_map(|line| line.trim().strip_prefix("tiledef="))
            else {
                continue;
            };
            let mut parts = tiledef.split_whitespace();
            let Some(name) = parts.next() else { continue };
            let Some(file_number) = parts.next().and_then(|value| value.parse::<i32>().ok()) else {
                continue;
            };
            let path = mod_entry.path().join("media").join(format!("{name}.tiles"));
            if path.is_file() {
                read_tile_definition_file(&path, file_number, defs);
            }
            let _ = b41;
        }
    }
}

struct LittleReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> LittleReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn bytes(&mut self, count: usize) -> Option<Vec<u8>> {
        let end = self.pos.checked_add(count)?;
        let result = self.data.get(self.pos..end)?.to_vec();
        self.pos = end;
        Some(result)
    }
    fn u32(&mut self) -> Option<u32> {
        Some(u32::from_le_bytes(self.bytes(4)?.try_into().ok()?))
    }
    fn line(&mut self) -> Option<Vec<u8>> {
        let end = self
            .data
            .get(self.pos..)?
            .iter()
            .position(|byte| *byte == b'\n')?
            + self.pos;
        let line = self.data.get(self.pos..end)?.to_vec();
        self.pos = end + 1;
        Some(line)
    }
}

fn config_string(config: &Value, key: &str) -> Option<String> {
    config.get(key).and_then(Value::as_str).map(str::to_string)
}

fn config_string_nested(config: &Value, key: &str) -> Option<String> {
    config_string(config, key).or_else(|| {
        config
            .get("render_conf")
            .and_then(|render| render.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

fn render_number(config: &Value, key: &str) -> Option<usize> {
    config
        .get("render_conf")
        .and_then(|render| render.get(key))
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
}

fn render_tile_size(config: &Value, fallback: usize) -> usize {
    render_number(config, "tile_size")
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn render_tile_align_levels(config: &Value, fallback: usize) -> usize {
    render_number(config, "tile_align_levels").unwrap_or(fallback)
}

fn render_omit_levels(config: &Value, fallback: usize) -> usize {
    render_number(config, "omit_levels").unwrap_or(fallback)
}

fn render_output_format(config: &Value, fallback: OutputFormat) -> OutputFormat {
    config_string_nested(config, "output_format")
        .or_else(|| config_string_nested(config, "image_fmt"))
        .map(|value| OutputFormat::from_name(Some(&value)))
        .unwrap_or(fallback)
}

fn render_image_options(config: &Value, fallback: ImageSaveOptions) -> ImageSaveOptions {
    let has_options = config
        .get("render_conf")
        .and_then(|render| render.get("image_save_options"))
        .is_some()
        || config.get("save_empty_tile").is_some()
        || config
            .get("render_conf")
            .and_then(|render| render.get("save_empty_tile"))
            .is_some();
    has_options
        .then(|| ImageSaveOptions::from_config(config))
        .unwrap_or(fallback)
}

fn save_texture_config(config: &Value) -> Value {
    let mut config = config.clone();
    let Some(render) = config.get_mut("render_conf").and_then(Value::as_object_mut) else {
        return config;
    };
    let plants = render
        .entry("plants_conf".to_string())
        .or_insert_with(|| json!({}));
    if let Some(plants) = plants.as_object_mut() {
        plants
            .entry("jumbo_tree_size".to_string())
            .or_insert_with(|| Value::from(4));
    }
    config
}

fn expand_environment(value: &str) -> String {
    let mut output = value.to_string();
    for (key, value) in std::env::vars() {
        output = output.replace(&format!("%{key}%"), &value);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_legacy_chunk_names() {
        assert_eq!(parse_old_chunk_name("map_-12_34.bin"), Some((-12, 34)));
        assert_eq!(parse_old_chunk_name("chunk_1_2.bin"), None);
    }

    #[test]
    fn scans_legacy_chunks_inside_a_map_directory() {
        let root =
            std::env::temp_dir().join(format!("pz-honus-hub-legacy-save-{}", std::process::id()));
        let map = root.join("map");
        fs::create_dir_all(&map).expect("create legacy map directory");
        let path = map.join("map_-3_7.bin");
        fs::write(&path, [0u8; 5]).expect("write legacy chunk");

        let chunks = scan_chunks(&root);
        assert_eq!(chunks.len(), 1);
        assert_eq!((chunks[0].x, chunks[0].y), (-3, 7));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn leaves_literal_paths_unchanged() {
        assert_eq!(expand_environment("D:/pz/Saves"), "D:/pz/Saves");
    }

    #[test]
    fn sanitizes_save_output_components_like_python() {
        assert_eq!(
            safe_name("Sandbox/2026:02:27_20-30-00"),
            "Sandbox_2026_02_27_20-30-00"
        );
    }

    #[test]
    fn matches_save_generation_to_static_map_generation() {
        assert!(versions_match(0, Some(195)));
        assert!(versions_match(42, Some(196)));
        assert!(!versions_match(0, Some(196)));
        assert!(!versions_match(42, Some(195)));
        assert!(!versions_match(42, None));
    }

    #[test]
    fn accepts_string_and_array_save_game_selections() {
        let string_config = json!({"save_games": "Sandbox/one\nSandbox/two"});
        assert_eq!(
            requested_save_names(&string_config),
            (
                false,
                vec!["Sandbox/one".to_string(), "Sandbox/two".to_string()]
            )
        );
        let array_config = json!({"save_games": ["Sandbox/one", "Sandbox/two"]});
        assert_eq!(
            requested_save_names(&array_config),
            (
                false,
                vec!["Sandbox/one".to_string(), "Sandbox/two".to_string()]
            )
        );
        assert_eq!(
            requested_save_names(&json!({"save_games": "all"})),
            (true, Vec::new())
        );
    }

    #[test]
    fn adds_build_specific_jumbo_tree_definitions() {
        let mut defs = HashMap::new();
        load_jumbo_tree_defs(6, &mut defs);
        assert_eq!(
            defs.get(&(6 * 512 * 512 + 12 * 512)),
            Some(&"jumbo_tree_01_0".to_string())
        );
        assert_eq!(
            defs.get(&(6 * 512 * 512 + 2 * 512 + 11)),
            Some(&"e_americanlindenJUMBO_1_11".to_string())
        );
        assert!(!defs.contains_key(&(6 * 512 * 512 + 1 * 512 + 8)));
    }

    #[test]
    fn ignores_tile_definition_ids_that_do_not_fit_in_the_renderer_index() {
        let root = std::env::temp_dir().join(format!(
            "pz-honus-hub-tiledefs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create tile definition directory");
        let path = root.join("invalid.tiles");
        let mut data = b"tdef".to_vec();
        data.extend(0_u32.to_le_bytes());
        data.extend(1_u32.to_le_bytes());
        data.extend(b"sheet\nimage\n");
        data.extend(0_u32.to_le_bytes());
        data.extend(0_u32.to_le_bytes());
        data.extend(0_u32.to_le_bytes());
        data.extend(1_u32.to_le_bytes());
        data.extend(0_u32.to_le_bytes());
        fs::write(&path, data).expect("write tile definition");

        let mut defs = HashMap::new();
        read_tile_definition_file(&path, i32::MAX, &mut defs);
        assert!(defs.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_command_specific_save_render_settings() {
        let config = json!({
            "render_conf": {
                "tile_size": 512,
                "omit_levels": 1,
                "output_format": "webp",
                "top_view_color_mode": "avg",
                "tile_size(save)": 1024,
                "omit_levels(save)": 2,
                "output_format(save)": "png",
                "render_cell_range(save)": [3, 4],
                "tile_size(save_top)": 2048,
                "top_view_color_mode(save_top)": "base+water",
                "output_format(save_top)": "jpg"
            }
        });
        let base = super::super::effective_render_config(&config, "Muldraugh", "base");
        let save = super::super::effective_command_config(&base, "save");
        let save_top = super::super::effective_command_config(&base, "save_top");

        assert_eq!(render_tile_size(&save, 256), 1024);
        assert_eq!(render_omit_levels(&save, 0), 2);
        assert_eq!(
            render_output_format(&save, OutputFormat::Webp),
            OutputFormat::Png
        );
        assert_eq!(
            super::super::configured_cell_ranges(&save, "render_cell_range")
                .expect("save render range should parse")
                .expect("save render range should be configured")[0],
            CellRect {
                x: 3,
                y: 4,
                width: 1,
                height: 1
            }
        );
        assert_eq!(render_tile_size(&save_top, 256), 2048);
        assert_eq!(
            render_output_format(&save_top, OutputFormat::Webp),
            OutputFormat::Jpeg
        );
        assert_eq!(
            config_string_nested(&save_top, "top_view_color_mode"),
            Some("base+water".to_string())
        );
        let python_style = json!({
            "render_conf": {
                "image_fmt": "webp",
                "image_fmt(save)": "png"
            }
        });
        let python_save = super::super::effective_command_config(
            &super::super::effective_render_config(&python_style, "Muldraugh", "base"),
            "save",
        );
        assert_eq!(
            render_output_format(&python_save, OutputFormat::Jpeg),
            OutputFormat::Png
        );
    }

    #[test]
    fn save_textures_default_to_large_jumbo_trees_without_overriding_config() {
        let defaulted = save_texture_config(&json!({"render_conf": {}}));
        assert_eq!(
            defaulted["render_conf"]["plants_conf"]["jumbo_tree_size"].as_i64(),
            Some(4)
        );
        let configured = save_texture_config(&json!({
            "render_conf": {"plants_conf": {"jumbo_tree_size": 2}}
        }));
        assert_eq!(
            configured["render_conf"]["plants_conf"]["jumbo_tree_size"].as_i64(),
            Some(2)
        );
    }
}
