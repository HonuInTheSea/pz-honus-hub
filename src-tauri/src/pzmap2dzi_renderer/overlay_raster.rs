//! Raster overlays for the layers that are represented as image tiles.

use super::cache;
use super::output::{ImageSaveOptions, OutputFormat, RgbaImage};
use super::{Geometry, LotHeader, RenderResult, pyramid_levels};
use fontdue::{Font, FontSettings};
use image::GenericImageView;
use rayon::prelude::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone, Copy)]
enum Kind {
    Rooms,
    Objects,
    Zombie,
    Foraging,
}

#[derive(Debug, Clone)]
struct BiomeMap {
    x: i32,
    y: i32,
    width: usize,
    height: usize,
    values: Vec<u8>,
}

#[derive(Debug, Clone, Copy)]
struct ForagingZone {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    color: [u8; 4],
}

#[derive(Debug, Clone, Copy)]
struct RasterEdge {
    x: i32,
    y: i32,
    layer: i32,
    direction: u8,
    color: [u8; 4],
}

#[derive(Debug, Clone, Copy)]
enum LabelFont {
    Room,
    Object,
    Zombie,
}

#[derive(Debug, Clone)]
struct RasterLabel {
    x: i32,
    y: i32,
    layer: i32,
    text: String,
    color: [u8; 4],
    font: LabelFont,
}

#[derive(Default)]
struct FontSet {
    room: Option<Font>,
    object: Option<Font>,
    zombie: Option<Font>,
    room_size: f32,
    object_size: f32,
    zombie_size: f32,
}

impl FontSet {
    fn get(&self, font: LabelFont) -> Option<(&Font, f32)> {
        match font {
            LabelFont::Room => self.room.as_ref().map(|font| (font, self.room_size)),
            LabelFont::Object => self.object.as_ref().map(|font| (font, self.object_size)),
            LabelFont::Zombie => self.zombie.as_ref().map(|font| (font, self.zombie_size)),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn render(
    config: &Value,
    map_path: &Path,
    pz_root: &Path,
    geometry: &Geometry,
    headers: &HashMap<(i32, i32), LotHeader>,
    map_data_root: &Path,
    stop_path: &Path,
    tile_size: usize,
    omit_levels: usize,
    format: OutputFormat,
    image_save_options: ImageSaveOptions,
    cell_rects: &[super::CellRect],
    source_signature: &str,
    emit: &mut impl FnMut(f32, &str, &str),
) -> RenderResult<()> {
    let rooms_config = super::effective_command_config(config, "rooms");
    let objects_config = super::effective_command_config(config, "objects");
    let zombie_config = super::effective_command_config(config, "zombie");
    let zombie_top_config = super::effective_command_config(config, "zombie_top");
    let foraging_config = super::effective_command_config(config, "foraging");
    let foraging_top_config = super::effective_command_config(config, "foraging_top");
    let rooms_signature = cache::scoped_signature(&rooms_config, source_signature);
    let objects_signature = cache::scoped_signature(&objects_config, source_signature);
    let zombie_signature = cache::scoped_signature(&zombie_config, source_signature);
    let zombie_top_signature = cache::scoped_signature(&zombie_top_config, source_signature);
    let foraging_signature = cache::scoped_signature(&foraging_config, source_signature);
    let foraging_top_signature = cache::scoped_signature(&foraging_top_config, source_signature);
    let pyramid_cache_limit_mb = super::configured_pyramid_cache_limit_mb(config);
    let rooms_render_ranges = super::configured_cell_ranges(&rooms_config, "render_cell_range")?;
    let zombie_render_ranges = super::configured_cell_ranges(&zombie_config, "render_cell_range")?;
    let zombie_top_render_ranges =
        super::configured_cell_ranges(&zombie_top_config, "render_cell_range")?;
    let objects_render_ranges =
        super::configured_cell_ranges(&objects_config, "render_cell_range")?;
    let foraging_render_ranges =
        super::configured_cell_ranges(&foraging_config, "render_cell_range")?;
    let foraging_top_render_ranges =
        super::configured_cell_ranges(&foraging_top_config, "render_cell_range")?;
    emit(
        63.7,
        "overlay_raster",
        &format!(
            "Preparing raster overlays for {} selected map cells",
            headers.len()
        ),
    );
    let rooms_headers = filtered_headers(headers, rooms_render_ranges.as_deref());
    let zombie_headers = filtered_headers(headers, zombie_render_ranges.as_deref());
    let zombie_top_headers = filtered_headers(headers, zombie_top_render_ranges.as_deref());
    let rooms_tile_size = tile_size_for(&rooms_config, tile_size);
    let objects_tile_size = tile_size_for(&objects_config, tile_size);
    let zombie_tile_size = tile_size_for(&zombie_config, tile_size);
    let zombie_top_tile_size = tile_size_for(&zombie_top_config, tile_size);
    let foraging_tile_size = tile_size_for(&foraging_config, tile_size);
    let foraging_top_tile_size = tile_size_for(&foraging_top_config, tile_size);
    // Overlay tiles are independent files, so the raster loop can use every
    // logical CPU available to the process. Keep this separate from the
    // decoded-texture cache budget: limiting workers by tile size left large
    // Low-preset overlays using only a fraction of the machine's CPU.
    let parallel_workers = available_overlay_workers();
    let rooms_workers = parallel_workers;
    let objects_workers = parallel_workers;
    let zombie_workers = parallel_workers;
    let zombie_top_workers = parallel_workers;
    let foraging_workers = parallel_workers;
    let foraging_top_workers = parallel_workers;
    emit(
        63.75,
        "overlay_raster",
        &format!(
            "Overlay tile sizes: rooms={} objects={} zombie={} zombie_top={} foraging={} foraging_top={}",
            rooms_tile_size,
            objects_tile_size,
            zombie_tile_size,
            zombie_top_tile_size,
            foraging_tile_size,
            foraging_top_tile_size
        ),
    );
    emit(
        63.76,
        "overlay_raster",
        &format!(
            "Raster overlays using {parallel_workers} CPU workers (all available logical cores)"
        ),
    );
    let rooms_geometry =
        geometry.with_layout(rooms_tile_size, tile_align_levels_for(&rooms_config, 1));
    let objects_geometry =
        geometry.with_layout(objects_tile_size, tile_align_levels_for(&objects_config, 1));
    let zombie_geometry =
        geometry.with_layout(zombie_tile_size, tile_align_levels_for(&zombie_config, 1));
    let zombie_top_geometry = geometry.with_layout(
        zombie_top_tile_size,
        tile_align_levels_for(&zombie_top_config, 1),
    );
    let foraging_geometry = geometry.with_layout(
        foraging_tile_size,
        tile_align_levels_for(&foraging_config, 1),
    );
    let foraging_top_geometry = geometry.with_layout(
        foraging_top_tile_size,
        tile_align_levels_for(&foraging_top_config, 1),
    );
    let biomaps = load_biomaps(map_path);
    let foraging_biomaps = filtered_biomaps(&biomaps, foraging_render_ranges.as_deref());
    let foraging_top_biomaps = filtered_biomaps(&biomaps, foraging_top_render_ranges.as_deref());
    let foraging_colors = load_b42_foraging_colors(pz_root, &foraging_config);
    let foraging_top_colors = load_b42_foraging_colors(pz_root, &foraging_top_config);
    let b41_foraging = if biomaps.is_empty() {
        load_b41_foraging_zones(map_path, &foraging_config)
    } else {
        Vec::new()
    };
    let b41_foraging_top = if biomaps.is_empty() {
        load_b41_foraging_zones(map_path, &foraging_top_config)
    } else {
        Vec::new()
    };
    let foraging_b41 = filtered_foraging_zones(
        &b41_foraging,
        geometry.cell_size,
        foraging_render_ranges.as_deref(),
    );
    let foraging_b41_top = filtered_foraging_zones(
        &b41_foraging_top,
        geometry.cell_size,
        foraging_top_render_ranges.as_deref(),
    );
    let rooms_use_marks = config_bool(&rooms_config, &["render_conf", "use_mark"]).unwrap_or(true);
    let objects_use_marks =
        config_bool(&objects_config, &["render_conf", "use_mark"]).unwrap_or(true);
    let room_edges = if rooms_use_marks {
        Vec::new()
    } else {
        load_room_edges(&rooms_headers)
    };
    let object_edges = if objects_use_marks {
        Vec::new()
    } else {
        load_object_edges(map_path, &objects_config)
            .into_iter()
            .filter(|edge| {
                in_world_ranges(
                    edge.x,
                    edge.y,
                    geometry.cell_size,
                    objects_render_ranges.as_deref(),
                )
            })
            .collect()
    };
    let fonts = load_fonts(pz_root, &rooms_config, &objects_config, &zombie_config);
    let room_labels = if rooms_use_marks {
        Vec::new()
    } else {
        load_room_labels(&rooms_headers)
    };
    let object_labels = if object_edges.is_empty() {
        Vec::new()
    } else {
        load_object_labels(map_path, &objects_config)
            .into_iter()
            .filter(|label| {
                in_world_ranges(
                    label.x,
                    label.y,
                    geometry.cell_size,
                    objects_render_ranges.as_deref(),
                )
            })
            .collect()
    };
    let zombie_labels = if config_bool(&zombie_config, &["render_conf", "use_mark"]).unwrap_or(true)
        || !config_bool(&zombie_config, &["render_conf", "zombie_count"]).unwrap_or(true)
    {
        Vec::new()
    } else {
        load_zombie_labels(headers)
    };
    let source_min = headers
        .values()
        .map(|header| header.min_layer)
        .chain(room_edges.iter().map(|edge| edge.layer))
        .chain(object_edges.iter().map(|edge| edge.layer))
        .min()
        .unwrap_or(0);
    let source_max = headers
        .values()
        .map(|header| header.max_layer)
        .chain(room_edges.iter().map(|edge| edge.layer + 1))
        .chain(object_edges.iter().map(|edge| edge.layer + 1))
        .max()
        .unwrap_or(source_min + 1)
        .max(source_min + 1);
    let rooms_layer_range = overlay_layer_range(&rooms_config, source_min, source_max)?;
    let objects_layer_range = overlay_layer_range(&objects_config, source_min, source_max)?;
    if rooms_use_marks {
        write_mark_map_info(
            "rooms",
            &rooms_geometry,
            rooms_tile_size,
            omit_levels_for(&rooms_config, omit_levels),
            &rooms_layer_range,
            headers,
            cell_rects,
            map_data_root,
        )?;
    }
    if objects_use_marks {
        write_mark_map_info(
            "objects",
            &objects_geometry,
            objects_tile_size,
            omit_levels_for(&objects_config, omit_levels),
            &objects_layer_range,
            headers,
            cell_rects,
            map_data_root,
        )?;
    }
    if !rooms_use_marks {
        for layer in rooms_layer_range.clone() {
            render_kind(
                "rooms",
                Kind::Rooms,
                layer,
                &rooms_geometry,
                &rooms_headers,
                &[],
                &[],
                &foraging_colors,
                &room_edges,
                &room_labels,
                &fonts,
                map_data_root,
                stop_path,
                rooms_tile_size,
                omit_levels_for(&rooms_config, omit_levels),
                format_for(&rooms_config, format),
                image_options_for(&rooms_config, image_save_options),
                &rooms_signature,
                cell_rects,
                rooms_layer_range.start,
                64.0,
                rooms_workers,
                super::configured_pyramid_backend(&rooms_config),
                pyramid_cache_limit_mb,
                emit,
            )?;
        }
    }
    if !objects_use_marks {
        for layer in objects_layer_range.clone() {
            render_kind(
                "objects",
                Kind::Objects,
                layer,
                &objects_geometry,
                headers,
                &[],
                &[],
                &foraging_colors,
                &object_edges,
                &object_labels,
                &fonts,
                map_data_root,
                stop_path,
                objects_tile_size,
                omit_levels_for(&objects_config, omit_levels),
                format_for(&objects_config, format),
                image_options_for(&objects_config, image_save_options),
                &objects_signature,
                cell_rects,
                objects_layer_range.start,
                64.5,
                objects_workers,
                super::configured_pyramid_backend(&objects_config),
                pyramid_cache_limit_mb,
                emit,
            )?;
        }
    }
    render_kind(
        "zombie",
        Kind::Zombie,
        0,
        &zombie_geometry,
        &zombie_headers,
        &[],
        &[],
        &foraging_colors,
        &[],
        &zombie_labels,
        &fonts,
        map_data_root,
        stop_path,
        zombie_tile_size,
        omit_levels_for(&zombie_config, omit_levels),
        format_for(&zombie_config, format),
        image_options_for(&zombie_config, image_save_options),
        &zombie_signature,
        cell_rects,
        0,
        65.0,
        zombie_workers,
        super::configured_pyramid_backend(&zombie_config),
        pyramid_cache_limit_mb,
        emit,
    )?;
    render_kind(
        "zombie_top",
        Kind::Zombie,
        0,
        &zombie_top_geometry,
        &zombie_top_headers,
        &[],
        &[],
        &foraging_colors,
        &[],
        &[],
        &fonts,
        map_data_root,
        stop_path,
        zombie_top_tile_size,
        omit_levels_for(&zombie_top_config, omit_levels),
        format_for(&zombie_top_config, format),
        image_options_for(&zombie_top_config, image_save_options),
        &zombie_top_signature,
        cell_rects,
        0,
        65.3,
        zombie_top_workers,
        super::configured_pyramid_backend(&zombie_top_config),
        pyramid_cache_limit_mb,
        emit,
    )?;
    render_kind(
        "foraging",
        Kind::Foraging,
        0,
        &foraging_geometry,
        headers,
        &foraging_biomaps,
        &foraging_b41,
        &foraging_colors,
        &[],
        &[],
        &fonts,
        map_data_root,
        stop_path,
        foraging_tile_size,
        omit_levels_for(&foraging_config, omit_levels),
        format_for(&foraging_config, format),
        image_options_for(&foraging_config, image_save_options),
        &foraging_signature,
        cell_rects,
        0,
        65.6,
        foraging_workers,
        super::configured_pyramid_backend(&foraging_config),
        pyramid_cache_limit_mb,
        emit,
    )?;
    render_kind(
        "foraging_top",
        Kind::Foraging,
        0,
        &foraging_top_geometry,
        headers,
        &foraging_top_biomaps,
        &foraging_b41_top,
        &foraging_top_colors,
        &[],
        &[],
        &fonts,
        map_data_root,
        stop_path,
        foraging_top_tile_size,
        omit_levels_for(&foraging_top_config, omit_levels),
        format_for(&foraging_top_config, format),
        image_options_for(&foraging_top_config, image_save_options),
        &foraging_top_signature,
        cell_rects,
        0,
        65.9,
        foraging_top_workers,
        super::configured_pyramid_backend(&foraging_top_config),
        pyramid_cache_limit_mb,
        emit,
    )?;
    emit(66.2, "overlay_raster", "Raster overlay generation complete");
    Ok(())
}

fn tile_size_for(config: &Value, fallback: usize) -> usize {
    config_number(config, &["render_conf", "tile_size"])
        .unwrap_or(fallback as f64)
        .max(128.0) as usize
}

fn available_overlay_workers() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
}

fn overlay_layer_range(
    config: &Value,
    source_min: i32,
    source_max: i32,
) -> RenderResult<std::ops::Range<i32>> {
    let configured = super::configured_layer_range(config, source_min, source_max)?;
    let start = configured.start.max(0);
    let end = configured.end.min(1);
    Ok(start..end)
}

fn tile_align_levels_for(config: &Value, fallback: usize) -> usize {
    config_number(config, &["render_conf", "tile_align_levels"])
        .unwrap_or(fallback as f64)
        .max(1.0) as usize
}

fn omit_levels_for(config: &Value, fallback: usize) -> usize {
    config_number(config, &["render_conf", "omit_levels"])
        .unwrap_or(fallback as f64)
        .max(0.0) as usize
}

fn format_for(config: &Value, fallback: OutputFormat) -> OutputFormat {
    config_string(config, &["render_conf", "image_fmt"])
        .as_deref()
        .map(|name| OutputFormat::from_name(Some(name)))
        .unwrap_or(fallback)
}

fn image_options_for(config: &Value, fallback: ImageSaveOptions) -> ImageSaveOptions {
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

fn filtered_headers(
    headers: &HashMap<(i32, i32), LotHeader>,
    ranges: Option<&[super::CellRect]>,
) -> HashMap<(i32, i32), LotHeader> {
    headers
        .iter()
        .filter(|((x, y), _)| super::in_ranges(ranges, *x, *y))
        .map(|(coordinate, header)| (*coordinate, header.clone()))
        .collect()
}

fn filtered_biomaps(biomaps: &[BiomeMap], ranges: Option<&[super::CellRect]>) -> Vec<BiomeMap> {
    biomaps
        .iter()
        .filter(|biome| super::in_ranges(ranges, biome.x, biome.y))
        .cloned()
        .collect()
}

fn filtered_foraging_zones(
    zones: &[ForagingZone],
    cell_size: i32,
    ranges: Option<&[super::CellRect]>,
) -> Vec<ForagingZone> {
    zones
        .iter()
        .copied()
        .filter(|zone| in_world_ranges(zone.x, zone.y, cell_size, ranges))
        .collect()
}

fn in_world_ranges(x: i32, y: i32, cell_size: i32, ranges: Option<&[super::CellRect]>) -> bool {
    super::in_ranges(
        ranges,
        x.div_euclid(cell_size.max(1)),
        y.div_euclid(cell_size.max(1)),
    )
}

fn write_mark_map_info(
    name: &str,
    geometry: &Geometry,
    tile_size: usize,
    omit_levels: usize,
    layer_range: &std::ops::Range<i32>,
    headers: &HashMap<(i32, i32), LotHeader>,
    cell_rects: &[super::CellRect],
    map_data_root: &Path,
) -> RenderResult<()> {
    let levels = pyramid_levels(geometry.iso_width.max(1), geometry.iso_height.max(1));
    let visible = super::retained_pyramid_levels(&levels, omit_levels);
    let (width, height) = visible
        .last()
        .copied()
        .unwrap_or((geometry.iso_width, geometry.iso_height));
    let header = headers.values().next();
    let base = map_data_root.join(name);
    fs::create_dir_all(&base).map_err(|error| error.to_string())?;
    fs::write(
        base.join("map_info.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "w": width,
            "h": height,
            "skip": omit_levels,
            "x0": super::map_info_origin(geometry, false).0,
            "y0": super::map_info_origin(geometry, false).1,
            "sqr": 128,
            "cell_size": geometry.cell_size,
            "tile_size": tile_size,
            "block_size": header.map(|value| value.block_size),
            "minlayer": layer_range.start,
            "maxlayer": layer_range.end,
            "pz_version": header.map(|value| if value.version == 0 { "B41" } else { "B42" }),
            "pzmap2dzi_version": "rust-pzmap2dzi",
            "cell_rects": cell_rects
                .iter()
                .map(|range| serde_json::json!([range.x, range.y, range.width, range.height]))
                .collect::<Vec<_>>(),
            "renderer": "pzmap2dzi-rust-mark"
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
fn render_kind(
    name: &str,
    kind: Kind,
    layer: i32,
    geometry: &Geometry,
    headers: &HashMap<(i32, i32), LotHeader>,
    biomaps: &[BiomeMap],
    b41_foraging: &[ForagingZone],
    foraging_colors: &[Option<[u8; 4]>; 256],
    edges: &[RasterEdge],
    labels: &[RasterLabel],
    fonts: &FontSet,
    map_data_root: &Path,
    stop_path: &Path,
    tile_size: usize,
    omit_levels: usize,
    format: OutputFormat,
    image_save_options: ImageSaveOptions,
    source_signature: &str,
    cell_rects: &[super::CellRect],
    render_min_layer: i32,
    progress_start: f32,
    parallel_workers: usize,
    pyramid_backend: super::PyramidBackend,
    pyramid_cache_limit_mb: usize,
    emit: &mut impl FnMut(f32, &str, &str),
) -> RenderResult<()> {
    let top_view = name.ends_with("_top");
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
    emit(
        progress_start,
        "overlay_raster",
        &format!(
            "Starting {name} raster layer {layer}: {}x{} pixels, tile_size={}, {} tile(s)",
            width,
            height,
            tile_size,
            width.div_ceil(tile_size) * height.div_ceil(tile_size)
        ),
    );
    let levels = pyramid_levels(width.max(1), height.max(1));
    let visible_levels = super::retained_pyramid_levels(&levels, omit_levels);
    let max_level = levels.len() - 1;
    let visible_width = visible_levels.last().map(|(w, _)| *w).unwrap_or(width);
    let visible_height = visible_levels.last().map(|(_, h)| *h).unwrap_or(height);
    let base = map_data_root.join(name);
    let map_info = serde_json::json!({
        "w": visible_width, "h": visible_height, "skip": omit_levels,
        "x0": super::map_info_origin(geometry, top_view).0,
        "y0": super::map_info_origin(geometry, top_view).1,
        "sqr": if top_view { geometry.top_square_size } else { 128 },
        "cell_size": geometry.cell_size,
        "block_size": headers.values().next().map(|header| header.block_size),
        "minlayer": headers.values().map(|header| header.min_layer).min(),
        "maxlayer": headers.values().map(|header| header.max_layer).max(),
        "pz_version": headers.values().next().map(|header| if header.version == 0 { "B41" } else { "B42" }),
        "pzmap2dzi_version": "rust-pzmap2dzi",
        "cell_rects": cell_rects
            .iter()
            .map(|range| serde_json::json!([range.x, range.y, range.width, range.height]))
            .collect::<Vec<_>>(),
        "renderer": "pzmap2dzi-rust-overlay"
    });
    super::ensure_map_info_compatible(&base, &map_info)?;
    let cache_path = base.join(format!("layer{layer}.rust-cache"));
    if cache::is_current(&cache_path, source_signature)
        && super::pyramid_outputs_exist(&base, layer, visible_levels, tile_size, format)
    {
        emit(
            progress_start + 0.25,
            "overlay_raster",
            &format!("{name} layer {layer} is already cached"),
        );
        return Ok(());
    }
    fs::create_dir_all(base.join(format!("layer{layer}_files/{max_level}")))
        .map_err(|error| error.to_string())?;
    let tiles_x = width.div_ceil(tile_size);
    let tiles_y = height.div_ceil(tile_size);
    let total_tiles = (tiles_x * tiles_y).max(1);
    let tile_coordinates = (0..tiles_y)
        .flat_map(|tile_y| (0..tiles_x).map(move |tile_x| (tile_x, tile_y)))
        .collect::<Vec<_>>();
    let batch_size = parallel_workers.saturating_mul(2).clamp(8, 64);
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(parallel_workers.max(1))
        .build()
        .map_err(|error| format!("Could not create overlay worker pool: {error}"))?;
    let mut completed_tiles = 0;
    for batch in tile_coordinates.chunks(batch_size) {
        emit(
            progress_start + 0.25 * (completed_tiles as f32 / total_tiles as f32),
            "overlay_raster",
            &format!(
                "Rendering {name} layer {layer} tiles {}-{} ({} CPU workers)",
                completed_tiles + 1,
                (completed_tiles + batch.len()).min(total_tiles),
                parallel_workers
            ),
        );
        pool.install(|| {
            batch.par_iter().try_for_each(|&(tile_x, tile_y)| {
                super::ensure_not_stopped(stop_path)?;
                let tile_output = base.join(format!(
                    "layer{layer}_files/{max_level}/{tile_x}_{tile_y}.{}",
                    format.extension()
                ));
                let tile_cache = tile_output.with_extension("rust-cache");
                if cache::is_current(&tile_cache, source_signature)
                    && super::tile_output_exists(&tile_output)
                {
                    return Ok(());
                }
                render_overlay_tile(
                    &base,
                    tile_x,
                    tile_y,
                    width,
                    height,
                    tile_size,
                    top_view,
                    kind,
                    layer,
                    geometry,
                    headers,
                    biomaps,
                    b41_foraging,
                    foraging_colors,
                    edges,
                    labels,
                    fonts,
                    render_min_layer,
                    max_level,
                    format,
                    image_save_options,
                )?;
                cache::write(&tile_cache, source_signature)
            })
        })?;
        completed_tiles += batch.len();
        emit(
            progress_start + 0.25 * (completed_tiles as f32 / total_tiles as f32),
            "overlay_raster",
            &format!("Rendered {name} layer {layer} tile {completed_tiles}/{total_tiles}"),
        );
    }
    super::ensure_not_stopped(stop_path)?;
    let pyramid_start = progress_start + 0.25;
    emit(
        pyramid_start,
        "overlay_pyramid",
        &format!(
            "Building {name} layer {layer} Deep Zoom pyramid: {} source level(s); {} CPU workers; {} MB RAM budget; backend={}",
            max_level,
            super::pyramid_worker_count(tile_size).0,
            super::pyramid_worker_count(tile_size).2 / (1024 * 1024),
            pyramid_backend.label()
        ),
    );
    let pyramid_started = Instant::now();
    let mut last_pyramid_report = Instant::now();
    super::build_pyramid_with_progress(
        stop_path,
        &base,
        layer,
        &levels,
        tile_size,
        format,
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
                let fraction = complete as f32 / total.max(1) as f32;
                emit(
                    pyramid_start + fraction * 0.05,
                    "overlay_pyramid",
                    &format!(
                        "Building {name} layer {layer} pyramid: level {level}/{max_level} tile {level_complete}/{level_total} ({complete}/{total}), elapsed {:.1}s",
                        pyramid_started.elapsed().as_secs_f64()
                    ),
                );
                last_pyramid_report = Instant::now();
            }
            Ok(())
        },
    )?;
    emit(
        pyramid_start + 0.05,
        "overlay_pyramid",
        &format!("Completed {name} layer {layer} Deep Zoom pyramid"),
    );
    super::prune_pyramid_levels(&base, layer, levels.len(), visible_levels.len())?;
    let dzi = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Image TileSize=\"{tile_size}\" Overlap=\"0\" Format=\"{}\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"{visible_width}\" Height=\"{visible_height}\"/></Image>",
        format.dzi_name()
    );
    fs::write(base.join(format!("layer{layer}.dzi")), dzi).map_err(|error| error.to_string())?;
    fs::write(
        base.join("map_info.json"),
        serde_json::to_vec_pretty(&map_info).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let result = cache::write(&cache_path, source_signature);
    if result.is_ok() {
        emit(
            progress_start + 0.3,
            "overlay_raster",
            &format!("Completed {name} raster layer {layer}"),
        );
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn render_overlay_tile(
    base: &Path,
    tile_x: usize,
    tile_y: usize,
    width: usize,
    height: usize,
    tile_size: usize,
    top_view: bool,
    kind: Kind,
    layer: i32,
    geometry: &Geometry,
    headers: &HashMap<(i32, i32), LotHeader>,
    biomaps: &[BiomeMap],
    b41_foraging: &[ForagingZone],
    foraging_colors: &[Option<[u8; 4]>; 256],
    edges: &[RasterEdge],
    labels: &[RasterLabel],
    fonts: &FontSet,
    render_min_layer: i32,
    max_level: usize,
    format: OutputFormat,
    image_save_options: ImageSaveOptions,
) -> RenderResult<()> {
    let tile_width = tile_size
        .min(width.saturating_sub(tile_x * tile_size))
        .max(1);
    let tile_height = tile_size
        .min(height.saturating_sub(tile_y * tile_size))
        .max(1);
    let tile_has_content = tile_has_content(
        kind,
        geometry,
        tile_x,
        tile_y,
        tile_size,
        top_view,
        headers,
        biomaps,
        b41_foraging,
    );
    // A transparent overlay tile does not need a full RGBA allocation. This
    // matters for large heatmap pyramids where most tiles contain no marks.
    let mut image = if tile_has_content {
        RgbaImage::new(tile_width, tile_height)
    } else {
        RgbaImage::new(1, 1)
    };
    if tile_has_content {
        render_tile(
            &mut image,
            tile_x,
            tile_y,
            tile_size,
            top_view,
            kind,
            layer,
            geometry,
            headers,
            biomaps,
            b41_foraging,
            foraging_colors,
            edges,
            labels,
            fonts,
        );
        super::composite_lower_layers(
            base,
            &mut image,
            layer,
            render_min_layer,
            max_level,
            tile_x,
            tile_y,
            format,
        )?;
    }
    super::write_optional_tile(
        &image,
        &base.join(format!(
            "layer{layer}_files/{max_level}/{tile_x}_{tile_y}.{}",
            format.extension()
        )),
        format,
        image_save_options,
        layer == 0,
    )?;
    Ok(())
}

fn tile_has_content(
    kind: Kind,
    geometry: &Geometry,
    tile_x: usize,
    tile_y: usize,
    tile_size: usize,
    top_view: bool,
    headers: &HashMap<(i32, i32), LotHeader>,
    biomaps: &[BiomeMap],
    b41_foraging: &[ForagingZone],
) -> bool {
    match kind {
        Kind::Zombie => {
            !candidate_headers(headers, geometry, tile_x, tile_y, tile_size, top_view).is_empty()
        }
        Kind::Foraging => {
            let bounds = tile_world_bounds(geometry, tile_x, tile_y, tile_size, top_view);
            if biomaps.is_empty() {
                b41_foraging.iter().any(|zone| {
                    world_rect_intersects(zone.x, zone.y, zone.width, zone.height, bounds)
                })
            } else {
                biomaps.iter().any(|biome| {
                    world_rect_intersects(
                        biome
                            .x
                            .saturating_mul(biome.width.min(i32::MAX as usize) as i32),
                        biome
                            .y
                            .saturating_mul(biome.height.min(i32::MAX as usize) as i32),
                        biome.width.min(i32::MAX as usize) as i32,
                        biome.height.min(i32::MAX as usize) as i32,
                        bounds,
                    )
                })
            }
        }
        Kind::Rooms | Kind::Objects => true,
    }
}

fn candidate_headers<'a>(
    headers: &'a HashMap<(i32, i32), LotHeader>,
    geometry: &Geometry,
    tile_x: usize,
    tile_y: usize,
    tile_size: usize,
    top_view: bool,
) -> Vec<&'a LotHeader> {
    let (world_min_x, world_max_x, world_min_y, world_max_y) =
        tile_world_bounds(geometry, tile_x, tile_y, tile_size, top_view);
    let cell_size = i64::from(geometry.cell_size.max(1));
    let min_cell_x = clamp_i64_to_i32(world_min_x.div_euclid(cell_size) - 1);
    let max_cell_x = clamp_i64_to_i32(world_max_x.div_euclid(cell_size) + 1);
    let min_cell_y = clamp_i64_to_i32(world_min_y.div_euclid(cell_size) - 1);
    let max_cell_y = clamp_i64_to_i32(world_max_y.div_euclid(cell_size) + 1);
    let mut result = Vec::new();
    for cell_x in min_cell_x..=max_cell_x {
        for cell_y in min_cell_y..=max_cell_y {
            if let Some(header) = headers.get(&(cell_x, cell_y)) {
                result.push(header);
            }
        }
    }
    result
}

fn tile_world_bounds(
    geometry: &Geometry,
    tile_x: usize,
    tile_y: usize,
    tile_size: usize,
    top_view: bool,
) -> (i64, i64, i64, i64) {
    let pixel_x0 = tile_x as i64 * tile_size as i64;
    let pixel_y0 = tile_y as i64 * tile_size as i64;
    let pixel_x1 = pixel_x0 + tile_size.max(1) as i64 - 1;
    let pixel_y1 = pixel_y0 + tile_size.max(1) as i64 - 1;
    if top_view {
        let scale = geometry.top_square_size.max(1) as i64;
        let origin_x = i64::from(geometry.min_cell_x) * i64::from(geometry.cell_size);
        let origin_y = i64::from(geometry.min_cell_y) * i64::from(geometry.cell_size);
        (
            origin_x + pixel_x0.div_euclid(scale) - i64::from(geometry.cell_size),
            origin_x + pixel_x1.div_euclid(scale) + i64::from(geometry.cell_size),
            origin_y + pixel_y0.div_euclid(scale) - i64::from(geometry.cell_size),
            origin_y + pixel_y1.div_euclid(scale) + i64::from(geometry.cell_size),
        )
    } else {
        let gx0 = i64::from(geometry.min_x) + pixel_x0.div_euclid(64) - 2;
        let gx1 = i64::from(geometry.min_x) + pixel_x1.div_euclid(64) + 2;
        let gy0 = i64::from(geometry.min_y) + pixel_y0.div_euclid(32) - 2;
        let gy1 = i64::from(geometry.min_y) + pixel_y1.div_euclid(32) + 2;
        let cell_margin = i64::from(geometry.cell_size);
        (
            (gx0 + gy0).div_euclid(2) - cell_margin,
            (gx1 + gy1).div_euclid(2) + cell_margin,
            (gy0 - gx1).div_euclid(2) - cell_margin,
            (gy1 - gx0).div_euclid(2) + cell_margin,
        )
    }
}

fn clamp_i64_to_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn world_rect_intersects(
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    bounds: (i64, i64, i64, i64),
) -> bool {
    let (min_x, max_x, min_y, max_y) = bounds;
    let rect_min_x = i64::from(x);
    let rect_min_y = i64::from(y);
    let rect_max_x = rect_min_x + i64::from(width.max(0)) - 1;
    let rect_max_y = rect_min_y + i64::from(height.max(0)) - 1;
    rect_min_x <= max_x && rect_max_x >= min_x && rect_min_y <= max_y && rect_max_y >= min_y
}

#[allow(clippy::too_many_arguments)]
fn render_tile(
    image: &mut RgbaImage,
    tile_x: usize,
    tile_y: usize,
    tile_size: usize,
    top_view: bool,
    kind: Kind,
    layer: i32,
    geometry: &Geometry,
    headers: &HashMap<(i32, i32), LotHeader>,
    biomaps: &[BiomeMap],
    b41_foraging: &[ForagingZone],
    foraging_colors: &[Option<[u8; 4]>; 256],
    edges: &[RasterEdge],
    labels: &[RasterLabel],
    fonts: &FontSet,
) {
    let offset_x = (tile_x * tile_size) as i32;
    let offset_y = (tile_y * tile_size) as i32;
    match kind {
        Kind::Rooms | Kind::Objects => {
            if !top_view {
                for edge in edges {
                    if edge.layer == layer {
                        render_edge(image, edge, geometry, offset_x, offset_y);
                    }
                }
            }
        }
        Kind::Zombie => {
            for header in candidate_headers(headers, geometry, tile_x, tile_y, tile_size, top_view)
            {
                for (bx, row) in header.zpop.iter().enumerate() {
                    for (by, count) in row.iter().enumerate() {
                        if *count == 0 {
                            continue;
                        }
                        let sx = header.x * header.cell_size + bx as i32 * header.block_size as i32;
                        let sy = header.y * header.cell_size + by as i32 * header.block_size as i32;
                        if top_view {
                            let x = (sx - geometry.min_cell_x * header.cell_size)
                                * geometry.top_square_size as i32
                                - offset_x;
                            let y = (sy - geometry.min_cell_y * header.cell_size)
                                * geometry.top_square_size as i32
                                - offset_y;
                            fill_rect(
                                image,
                                x,
                                y,
                                header.block_size as i32 * geometry.top_square_size as i32,
                                header.block_size as i32 * geometry.top_square_size as i32,
                                zombie_color(*count),
                            );
                        } else {
                            let gx = sx - sy;
                            let gy = sx + sy;
                            let x = (gx - geometry.min_x) * 64 - offset_x;
                            let y = (gy - geometry.min_y) * 32 - offset_y;
                            fill_iso_diamond(
                                image,
                                x,
                                y,
                                header.block_size as i32,
                                zombie_color(*count),
                            );
                        }
                    }
                }
            }
        }
        Kind::Foraging => {
            let tile_bounds = tile_world_bounds(geometry, tile_x, tile_y, tile_size, top_view);
            if biomaps.is_empty() {
                for zone in b41_foraging.iter().filter(|zone| {
                    world_rect_intersects(zone.x, zone.y, zone.width, zone.height, tile_bounds)
                }) {
                    render_b41_zone(image, zone, top_view, geometry, offset_x, offset_y);
                }
            } else {
                for biome in biomaps.iter().filter(|biome| {
                    world_rect_intersects(
                        biome
                            .x
                            .saturating_mul(biome.width.min(i32::MAX as usize) as i32),
                        biome
                            .y
                            .saturating_mul(biome.height.min(i32::MAX as usize) as i32),
                        biome.width.min(i32::MAX as usize) as i32,
                        biome.height.min(i32::MAX as usize) as i32,
                        tile_bounds,
                    )
                }) {
                    for y in 0..biome.height {
                        for x in 0..biome.width {
                            let value = biome.values[y * biome.width + x];
                            if value == 0 {
                                continue;
                            }
                            let Some(color) = foraging_colors[value as usize] else {
                                continue;
                            };
                            let sx = biome.x * biome.width as i32 + x as i32;
                            let sy = biome.y * biome.height as i32 + y as i32;
                            if top_view {
                                let px = (sx - geometry.min_cell_x * geometry.cell_size)
                                    * geometry.top_square_size as i32
                                    - offset_x;
                                let py = (sy - geometry.min_cell_y * geometry.cell_size)
                                    * geometry.top_square_size as i32
                                    - offset_y;
                                fill_rect(
                                    image,
                                    px,
                                    py,
                                    geometry.top_square_size as i32,
                                    geometry.top_square_size as i32,
                                    color,
                                );
                            } else {
                                let gx = sx - sy;
                                let gy = sx + sy;
                                let px = (gx - geometry.min_x) * 64 - offset_x;
                                let py = (gy - geometry.min_y) * 32 - offset_y;
                                fill_iso_diamond(image, px, py, 1, color);
                            }
                        }
                    }
                }
            }
        }
    }
    if !top_view {
        for label in labels.iter().filter(|label| label.layer == layer) {
            let x = (label.x - label.y - geometry.min_x) * 64 - offset_x;
            let y = (label.x + label.y - geometry.min_y) * 32 + label.layer.saturating_mul(6) * 32
                - offset_y;
            draw_label(image, x, y, label, fonts);
        }
    }
}

fn render_b41_zone(
    image: &mut RgbaImage,
    zone: &ForagingZone,
    top_view: bool,
    geometry: &Geometry,
    offset_x: i32,
    offset_y: i32,
) {
    for sy in zone.y..zone.y.saturating_add(zone.height.max(0)) {
        for sx in zone.x..zone.x.saturating_add(zone.width.max(0)) {
            if top_view {
                let px = (sx - geometry.min_cell_x * geometry.cell_size)
                    * geometry.top_square_size as i32
                    - offset_x;
                let py = (sy - geometry.min_cell_y * geometry.cell_size)
                    * geometry.top_square_size as i32
                    - offset_y;
                fill_rect(
                    image,
                    px,
                    py,
                    geometry.top_square_size as i32,
                    geometry.top_square_size as i32,
                    zone.color,
                );
            } else {
                let gx = sx - sy;
                let gy = sx + sy;
                let px = (gx - geometry.min_x) * 64 - offset_x;
                let py = (gy - geometry.min_y) * 32 - offset_y;
                fill_iso_diamond(image, px, py, 1, zone.color);
            }
        }
    }
}

fn load_fonts(
    pz_root: &Path,
    rooms_config: &Value,
    objects_config: &Value,
    zombie_config: &Value,
) -> FontSet {
    let default_name = config_string(rooms_config, &["render_conf", "default_font"])
        .or_else(|| config_string(objects_config, &["render_conf", "default_font"]))
        .or_else(|| config_string(zombie_config, &["render_conf", "default_font"]))
        .unwrap_or_else(|| "arial.ttf".to_string());
    let room_name = config_string(rooms_config, &["render_conf", "room_font"])
        .or_else(|| config_string(rooms_config, &["render_conf", "default_font"]))
        .unwrap_or_else(|| default_name.clone());
    let object_name = config_string(objects_config, &["render_conf", "objects_font"])
        .or_else(|| config_string(objects_config, &["render_conf", "default_font"]))
        .unwrap_or_else(|| default_name.clone());
    let zombie_name = config_string(zombie_config, &["render_conf", "zombie_count_font"])
        .or_else(|| config_string(zombie_config, &["render_conf", "default_font"]))
        .unwrap_or(default_name);
    FontSet {
        room: load_font(pz_root, &room_name),
        object: load_font(pz_root, &object_name),
        zombie: load_font(pz_root, &zombie_name),
        room_size: config_number(rooms_config, &["render_conf", "room_font_size"]).unwrap_or(20.0)
            as f32,
        object_size: config_number(objects_config, &["render_conf", "objects_font_size"])
            .unwrap_or(20.0) as f32,
        zombie_size: config_number(zombie_config, &["render_conf", "zombie_count_font_size"])
            .unwrap_or(40.0) as f32,
    }
}

fn load_font(pz_root: &Path, name: &str) -> Option<Font> {
    let requested = super::filesystem_path(name);
    let mut candidates = Vec::new();
    if requested.is_absolute() {
        candidates.push(requested);
    } else {
        candidates.push(requested.clone());
        candidates.push(pz_root.join("media/fonts").join(&requested));
        candidates.push(pz_root.join(&requested));
        if let Some(windir) = std::env::var_os("WINDIR") {
            candidates.push(PathBuf::from(windir).join("Fonts").join(&requested));
        }
    }
    candidates
        .into_iter()
        .find_map(|path| fs::read(path).ok())
        .and_then(|bytes| Font::from_bytes(bytes, FontSettings::default()).ok())
}

fn load_room_labels(headers: &HashMap<(i32, i32), LotHeader>) -> Vec<RasterLabel> {
    let mut labels = Vec::new();
    for header in headers.values() {
        for room in &header.rooms {
            let Some((x, y)) = room_label_square(room, header) else {
                continue;
            };
            labels.push(RasterLabel {
                x,
                y,
                layer: room.layer,
                text: room.name.clone(),
                color: opaque_color(super::overlays::room_color(&room.name)),
                font: LabelFont::Room,
            });
        }
    }
    labels
}

fn room_label_square(room: &super::Room, header: &LotHeader) -> Option<(i32, i32)> {
    room.rects
        .iter()
        .filter(|(_, _, width, height)| *width > 0 && *height > 0)
        .map(|&(x, y, _, _)| {
            (
                x + header.x * header.cell_size,
                y + header.y * header.cell_size,
            )
        })
        .min_by_key(|&(x, y)| (x + y, x))
}

fn load_object_labels(path: &Path, config: &Value) -> Vec<RasterLabel> {
    let source = path.join("objects.lua");
    let Ok(text) = fs::read_to_string(source) else {
        return Vec::new();
    };
    let Some(colors) = config
        .get("render_conf")
        .and_then(|value| value.get("objects_color"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut labels = Vec::new();
    for entry in super::overlays::lua_records(&text) {
        let Some(object_type) = lua_string(entry, "type") else {
            continue;
        };
        let Some(color_name) = colors.get(&object_type).and_then(Value::as_str) else {
            continue;
        };
        let Some(name) = lua_string(entry, "name") else {
            continue;
        };
        if name.is_empty() || color_name.eq_ignore_ascii_case("skip") {
            continue;
        }
        let rects = super::overlays::object_rects(entry);
        let Some((x, y)) = rects
            .iter()
            .map(|&(x, y, _, _)| (x, y))
            .min_by_key(|&(x, y)| (x + y, x))
        else {
            continue;
        };
        labels.push(RasterLabel {
            x,
            y,
            layer: lua_number(entry, "z").unwrap_or(0.0) as i32,
            text: name,
            color: opaque_color(color_name),
            font: LabelFont::Object,
        });
    }
    labels
}

fn load_zombie_labels(headers: &HashMap<(i32, i32), LotHeader>) -> Vec<RasterLabel> {
    let mut labels = Vec::new();
    for header in headers.values() {
        for (block_x, row) in header.zpop.iter().enumerate() {
            for (block_y, count) in row.iter().enumerate() {
                if *count == 0 {
                    continue;
                }
                let x = header.x * header.cell_size
                    + block_x as i32 * header.block_size as i32
                    + header.block_size as i32
                    - 1;
                let y = header.y * header.cell_size
                    + block_y as i32 * header.block_size as i32
                    + header.block_size as i32
                    - 1;
                let mut color = zombie_color(*count);
                color[3] = 255;
                labels.push(RasterLabel {
                    x,
                    y,
                    layer: 0,
                    text: format!("z:{count}"),
                    color,
                    font: LabelFont::Zombie,
                });
            }
        }
    }
    labels
}

fn draw_label(
    image: &mut RgbaImage,
    center_x: i32,
    center_y: i32,
    label: &RasterLabel,
    fonts: &FontSet,
) {
    let Some((font, size)) = fonts.get(label.font) else {
        return;
    };
    let text = if text_width(font, &label.text, size) >= 128.0 {
        break_long_text(&label.text)
    } else {
        label.text.clone()
    };
    let lines = text.split('\n').collect::<Vec<_>>();
    let line_height = (size * 1.15).ceil().max(1.0) as i32;
    let total_height = line_height * lines.len() as i32;
    let top = center_y - total_height / 2;
    for (line_index, line) in lines.into_iter().enumerate() {
        let width = text_width(font, line, size).round() as i32;
        let mut pen_x = center_x - width / 2;
        let baseline = top + (line_index as i32 + 1) * line_height;
        for character in line.chars() {
            let (metrics, bitmap) = font.rasterize(character, size);
            let glyph_x = pen_x + metrics.xmin;
            let glyph_y = baseline - metrics.height as i32 - metrics.ymin;
            for y in 0..metrics.height {
                for x in 0..metrics.width {
                    let coverage = bitmap[y * metrics.width + x];
                    if coverage == 0 {
                        continue;
                    }
                    let alpha = (u16::from(label.color[3]) * u16::from(coverage) / 255) as u8;
                    image.blend_pixel(
                        glyph_x + x as i32,
                        glyph_y + y as i32,
                        [label.color[0], label.color[1], label.color[2], alpha],
                    );
                }
            }
            pen_x += metrics.advance_width.round() as i32;
        }
    }
}

fn text_width(font: &Font, text: &str, size: f32) -> f32 {
    text.chars()
        .map(|character| font.metrics(character, size).advance_width)
        .sum()
}

fn break_long_text(text: &str) -> String {
    for suffix in [
        "store",
        "storage",
        "kitchen",
        "bathroom",
        "room",
        "rooms",
        "factory",
        "occupied",
        "dining",
        "warehouse",
        "restaurant",
        "clothes",
        "station",
        "game",
        "stand",
        "shipping",
        "cooking",
        "office",
        "print",
        "bottling",
    ] {
        if let Some(prefix) = text.strip_suffix(suffix) {
            return format!("{prefix}\n{suffix}");
        }
    }
    let midpoint = text.chars().count() / 2;
    let mut result = String::new();
    for (index, character) in text.chars().enumerate() {
        if index == midpoint {
            result.push('\n');
        }
        result.push(character);
    }
    result
}

fn opaque_color(value: &str) -> [u8; 4] {
    super::overlays::parse_css_color(value, 255)
}

fn load_room_edges(headers: &HashMap<(i32, i32), LotHeader>) -> Vec<RasterEdge> {
    let mut edges = Vec::new();
    for header in headers.values() {
        let offset_x = header.x * header.cell_size;
        let offset_y = header.y * header.cell_size;
        for room in &header.rooms {
            let rects = room
                .rects
                .iter()
                .map(|&(x, y, width, height)| (x + offset_x, y + offset_y, width, height))
                .collect::<Vec<_>>();
            let color =
                super::overlays::parse_css_color(super::overlays::room_color(&room.name), 255);
            edges.extend(edges_from_rects(&rects, room.layer, color));
        }
    }
    edges
}

fn load_object_edges(path: &Path, config: &Value) -> Vec<RasterEdge> {
    let source = path.join("objects.lua");
    let Ok(text) = fs::read_to_string(source) else {
        return Vec::new();
    };
    let Some(colors) = config
        .get("render_conf")
        .and_then(|value| value.get("objects_color"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut edges = Vec::new();
    for entry in super::overlays::lua_records(&text) {
        let Some(object_type) = lua_string(entry, "type") else {
            continue;
        };
        let Some(color_name) = colors.get(&object_type).and_then(Value::as_str) else {
            continue;
        };
        if color_name.eq_ignore_ascii_case("skip") {
            continue;
        }
        let rects = super::overlays::object_rects(entry);
        let color = super::overlays::parse_css_color(color_name, 255);
        let layer = lua_number(entry, "z").unwrap_or(0.0) as i32;
        edges.extend(edges_from_rects(&rects, layer, color));
    }
    edges
}

fn edges_from_rects(rects: &[(i32, i32, i32, i32)], layer: i32, color: [u8; 4]) -> Vec<RasterEdge> {
    let mut cells = HashSet::new();
    for &(x, y, width, height) in rects {
        for cell_y in y..y.saturating_add(height.max(0)) {
            for cell_x in x..x.saturating_add(width.max(0)) {
                cells.insert((cell_x, cell_y));
            }
        }
    }
    let directions = [(0, -1), (1, 0), (0, 1), (-1, 0)];
    let mut edges = Vec::new();
    for &(x, y) in &cells {
        for (direction, (dx, dy)) in directions.iter().enumerate() {
            if !cells.contains(&(x + dx, y + dy)) {
                edges.push(RasterEdge {
                    x,
                    y,
                    layer,
                    direction: direction as u8,
                    color,
                });
            }
        }
    }
    edges
}

fn render_edge(
    image: &mut RgbaImage,
    edge: &RasterEdge,
    geometry: &Geometry,
    offset_x: i32,
    offset_y: i32,
) {
    let center_x = (edge.x - edge.y - geometry.min_x) * 64 - offset_x;
    let center_y =
        (edge.x + edge.y - geometry.min_y) * 32 + edge.layer.saturating_mul(6) * 32 - offset_y;
    let points = [
        (center_x, center_y - 32),
        (center_x + 64, center_y),
        (center_x, center_y + 32),
        (center_x - 64, center_y),
    ];
    let start = points[edge.direction as usize % 4];
    let end = points[(edge.direction as usize + 1) % 4];
    draw_line(image, start, end, edge.color, 3);
}

fn draw_line(
    image: &mut RgbaImage,
    start: (i32, i32),
    end: (i32, i32),
    color: [u8; 4],
    width: i32,
) {
    let mut x = start.0;
    let mut y = start.1;
    let dx = (end.0 - start.0).abs();
    let sx = if start.0 < end.0 { 1 } else { -1 };
    let dy = -(end.1 - start.1).abs();
    let sy = if start.1 < end.1 { 1 } else { -1 };
    let mut error = dx + dy;
    loop {
        let radius = width.max(1) / 2;
        for offset_y in -radius..=radius {
            for offset_x in -radius..=radius {
                image.blend_pixel(x + offset_x, y + offset_y, color);
            }
        }
        if x == end.0 && y == end.1 {
            break;
        }
        let double_error = 2 * error;
        if double_error >= dy {
            error += dy;
            x += sx;
        }
        if double_error <= dx {
            error += dx;
            y += sy;
        }
    }
}

fn fill_iso_diamond(
    image: &mut RgbaImage,
    center_x: i32,
    center_y: i32,
    size: i32,
    color: [u8; 4],
) {
    let size = size.max(1);
    let half_width = 64 * size;
    let half_height = 32 * size;
    let diamond_center_y = center_y + (size - 1) * 32;
    for y in (diamond_center_y - half_height)..=(diamond_center_y + half_height) {
        let distance = (y - diamond_center_y).abs();
        let width = half_width * (half_height - distance) / half_height;
        for x in (center_x - width)..=(center_x + width) {
            image.blend_pixel(x, y, color);
        }
    }
}

fn fill_rect(image: &mut RgbaImage, x: i32, y: i32, width: i32, height: i32, color: [u8; 4]) {
    for dy in 0..height.max(0) {
        for dx in 0..width.max(0) {
            image.blend_pixel(x + dx, y + dy, color);
        }
    }
}

fn zombie_color(value: u8) -> [u8; 4] {
    let (r, g, b) = if value >= 128 {
        let r = ((value - 128) as u16 * 2).min(255) as u8;
        (r, 255 - r, 0)
    } else {
        let g = (value as u16 * 2).min(255) as u8;
        (0, g, 255 - g)
    };
    [r, g, b, 128]
}

fn load_biomaps(path: &Path) -> Vec<BiomeMap> {
    let mut maps = Vec::new();
    let Ok(entries) = fs::read_dir(path.join("maps")) else {
        return maps;
    };
    for entry in entries.filter_map(Result::ok) {
        let file = entry.path();
        let Some(name) = file.file_name().and_then(|v| v.to_str()) else {
            continue;
        };
        let Some(stem) = name
            .strip_prefix("biomemap_")
            .and_then(|v| v.strip_suffix(".png"))
        else {
            continue;
        };
        let Some((x, y)) = stem
            .split_once('_')
            .and_then(|(x, y)| Some((x.parse().ok()?, y.parse().ok()?)))
        else {
            continue;
        };
        let Ok(image) = image::open(&file) else {
            continue;
        };
        let (width, height) = image.dimensions();
        let mut values = Vec::with_capacity((width * height) as usize);
        for py in 0..height {
            for px in 0..width {
                values.push(grayscale_value(image.get_pixel(px, py).0));
            }
        }
        maps.push(BiomeMap {
            x,
            y,
            width: width as usize,
            height: height as usize,
            values,
        });
    }
    maps
}

fn grayscale_value(pixel: [u8; 4]) -> u8 {
    ((u32::from(pixel[0]) * 299 + u32::from(pixel[1]) * 587 + u32::from(pixel[2]) * 114 + 500)
        / 1000) as u8
}

fn load_b42_foraging_colors(pz_root: &Path, config: &Value) -> [Option<[u8; 4]>; 256] {
    let mut colors = [None; 256];
    let Some(legend) = config
        .get("render_conf")
        .and_then(|value| value.get("foraging_color"))
        .and_then(Value::as_object)
    else {
        return colors;
    };
    for (pixel, biome_name) in super::overlays::load_biome_mapping(pz_root) {
        let Some(color_name) = legend.get(&biome_name).and_then(Value::as_str) else {
            continue;
        };
        if color_name.eq_ignore_ascii_case("skip") {
            continue;
        }
        colors[pixel as usize] = Some(overlay_color(color_name));
    }
    colors
}

fn load_b41_foraging_zones(path: &Path, config: &Value) -> Vec<ForagingZone> {
    let source = path.join("objects.lua");
    let Ok(text) = fs::read_to_string(source) else {
        return Vec::new();
    };
    let Some(colors) = config
        .get("render_conf")
        .and_then(|value| value.get("foraging_color"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut zones = Vec::new();
    for entry in super::overlays::lua_records(&text) {
        let Some(object_type) = lua_string(entry, "type") else {
            continue;
        };
        let Some(color_name) = colors.get(&object_type).and_then(Value::as_str) else {
            continue;
        };
        if color_name.eq_ignore_ascii_case("skip") {
            continue;
        }
        if lua_number(entry, "z").unwrap_or(0.0) != 0.0 {
            continue;
        }
        let color = overlay_color(color_name);
        for (x, y, width, height) in super::overlays::object_rects(entry) {
            if width <= 0 || height <= 0 {
                continue;
            }
            zones.push(ForagingZone {
                x,
                y,
                width,
                height,
                color,
            });
        }
    }
    zones
}

fn lua_string(entry: &str, key: &str) -> Option<String> {
    let value = lua_value(entry, key)?;
    let quote = value.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let end = value[1..].find(quote)? + 1;
    Some(value[1..end].to_string())
}

fn lua_number(entry: &str, key: &str) -> Option<f64> {
    let value = lua_value(entry, key)?;
    let token = value
        .split(|character: char| character == ',' || character == '}' || character.is_whitespace())
        .next()?;
    token.parse().ok()
}

fn lua_value<'a>(entry: &'a str, key: &str) -> Option<&'a str> {
    entry.split(',').find_map(|field| {
        let (name, value) = field.split_once('=')?;
        (name.trim() == key).then_some(value.trim())
    })
}

fn overlay_color(value: &str) -> [u8; 4] {
    super::overlays::parse_css_color(value, 128)
}

fn config_bool(config: &Value, path: &[&str]) -> Option<bool> {
    let mut value = config;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_bool()
}

fn config_string(config: &Value, path: &[&str]) -> Option<String> {
    let mut value = config;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_str().map(ToOwned::to_owned)
}

fn config_number(config: &Value, path: &[&str]) -> Option<f64> {
    let mut value = config;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_f64()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rasterizes_an_isometric_cell_as_a_full_diamond() {
        let mut image = RgbaImage::new(200, 120);
        fill_iso_diamond(&mut image, 100, 60, 1, [255, 0, 0, 128]);
        let center = (60 * image.width + 100) * 4;
        let outside = (60 * image.width + 30) * 4;
        assert_eq!(image.pixels[center + 3], 128);
        assert_eq!(image.pixels[outside + 3], 0);
    }

    #[test]
    fn selects_only_headers_near_an_overlay_tile() {
        let geometry = Geometry::from_cell_bounds(0, 0, 0, 0, 300, 1, 256, 1, 0, 1);
        let mut headers = HashMap::new();
        headers.insert(
            (0, 0),
            LotHeader {
                x: 0,
                y: 0,
                version: 0,
                cell_blocks: 1,
                block_size: 10,
                cell_size: 300,
                min_layer: 0,
                max_layer: 1,
                tiles: Vec::new(),
                rooms: Vec::new(),
                zpop: Vec::new(),
            },
        );
        headers.insert(
            (100, 100),
            LotHeader {
                x: 100,
                y: 100,
                version: 0,
                cell_blocks: 1,
                block_size: 10,
                cell_size: 300,
                min_layer: 0,
                max_layer: 1,
                tiles: Vec::new(),
                rooms: Vec::new(),
                zpop: Vec::new(),
            },
        );
        let tile = (0..200)
            .flat_map(|tile_y| (0..200).map(move |tile_x| (tile_x, tile_y)))
            .find(|&(tile_x, tile_y)| {
                candidate_headers(&headers, &geometry, tile_x, tile_y, 256, false)
                    .iter()
                    .any(|header| header.x == 0 && header.y == 0)
            })
            .expect("the map cell should intersect an output tile");
        let candidates = candidate_headers(&headers, &geometry, tile.0, tile.1, 256, false);
        assert!(
            candidates
                .iter()
                .any(|header| header.x == 0 && header.y == 0)
        );
        assert!(
            !candidates
                .iter()
                .any(|header| header.x == 100 && header.y == 100)
        );
    }

    #[test]
    fn resolves_room_and_object_command_output_settings() {
        let config = json!({
            "render_conf": {
                "tile_size": 512,
                "image_fmt": "webp",
                "tile_size(rooms)": 1024,
                "image_fmt(rooms)": "png",
                "tile_size(objects)": 2048,
                "image_fmt(objects)": "jpg",
                "tile_size(zombie_top)": 4096,
                "tile_size(foraging_top)": 8192
            }
        });
        let base = super::super::effective_render_config(&config, "Muldraugh", "base");
        let rooms = super::super::effective_command_config(&base, "rooms");
        let objects = super::super::effective_command_config(&base, "objects");

        assert_eq!(tile_size_for(&rooms, 256), 1024);
        assert_eq!(format_for(&rooms, OutputFormat::Webp), OutputFormat::Png);
        assert_eq!(tile_size_for(&objects, 256), 2048);
        assert_eq!(format_for(&objects, OutputFormat::Webp), OutputFormat::Jpeg);
        let zombie_top = super::super::effective_command_config(&base, "zombie_top");
        let foraging_top = super::super::effective_command_config(&base, "foraging_top");
        assert_eq!(tile_size_for(&zombie_top, 256), 4096);
        assert_eq!(tile_size_for(&foraging_top, 256), 8192);
    }

    #[test]
    fn room_and_object_raster_layers_match_python_overlay_limits() {
        assert_eq!(
            overlay_layer_range(&json!({}), -32, 32).expect("default overlay range"),
            0..1
        );
        assert_eq!(
            overlay_layer_range(&json!({"render_conf": {"layer_range": [-32, 8]}}), -32, 32)
                .expect("configured overlay range"),
            0..1
        );
    }

    #[test]
    fn marker_only_layers_write_viewer_metadata() {
        let root = temp_root("marker-map-info");
        let geometry = Geometry::from_cell_bounds(0, 0, 0, 0, 300, 1, 256, 1, 0, 1);
        write_mark_map_info(
            "rooms",
            &geometry,
            256,
            0,
            &(0..1),
            &HashMap::new(),
            &[],
            &root,
        )
        .expect("write marker metadata");
        let info: Value = serde_json::from_slice(
            &fs::read(root.join("rooms/map_info.json")).expect("read marker metadata"),
        )
        .expect("parse marker metadata");
        assert_eq!(info["pzmap2dzi_version"], "rust-pzmap2dzi");
        assert_eq!(info["minlayer"], 0);
        assert_eq!(info["maxlayer"], 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn derives_only_outer_edges_for_a_rectangular_region() {
        let edges = edges_from_rects(&[(10, 20, 2, 2)], 2, [1, 2, 3, 255]);
        assert_eq!(edges.len(), 8);
        assert!(
            edges
                .iter()
                .all(|edge| edge.color == [1, 2, 3, 255] && edge.layer == 2)
        );
    }

    fn temp_root(label: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "pz-honus-hub-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    #[test]
    fn loads_b41_foraging_zones_with_configured_colors_and_layers() {
        let root = temp_root("b41-foraging");
        fs::create_dir_all(&root).expect("create map root");
        fs::write(
            root.join("objects.lua"),
            r#"objects = {
                { type = "Forest", x = 1, y = 2, width = 3, height = 4, z = 0 },
                { type = "Forest", geometry = "polygon", points = {10, 10, 13, 10, 13, 13, 10, 13}, z = 0 },
                { type = "Forest", x = 5, y = 6, width = 3, height = 4, z = 1 },
                { type = "Hidden", x = 9, y = 9, width = 1, height = 1, z = 0 }
            }"#,
        )
        .expect("write objects");
        let config = json!({
            "render_conf": {
                "foraging_color": { "Forest": "#102030", "Hidden": "skip" }
            }
        });

        let zones = load_b41_foraging_zones(&root, &config);
        assert_eq!(zones.len(), 2);
        assert_eq!(zones[0].x, 1);
        assert_eq!(zones[0].y, 2);
        assert_eq!(zones[0].width, 3);
        assert_eq!(zones[0].height, 4);
        assert_eq!(zones[0].color, [16, 32, 48, 128]);
        assert_eq!((zones[1].x, zones[1].y), (10, 10));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn maps_b42_pixels_to_configured_colors_and_skips_unconfigured() {
        let root = temp_root("b42-foraging");
        let mapping_path = root.join("media/lua/server/metazones/BiomeMapConfig.lua");
        fs::create_dir_all(mapping_path.parent().expect("mapping parent"))
            .expect("create mapping parent");
        fs::write(
            mapping_path,
            r#"biome_map_config = {
                { pixel = 1, zone = "Forest" },
                { pixel = 2, zone = "Hidden" }
            }"#,
        )
        .expect("write mapping");
        let config = json!({
            "render_conf": {
                "foraging_color": { "Forest": "#102030", "Hidden": "skip" }
            }
        });

        let colors = load_b42_foraging_colors(&root, &config);
        assert_eq!(colors[1], Some([16, 32, 48, 128]));
        assert_eq!(colors[2], None);
        assert_eq!(colors[3], None);
        let _ = fs::remove_dir_all(root);
    }
}
