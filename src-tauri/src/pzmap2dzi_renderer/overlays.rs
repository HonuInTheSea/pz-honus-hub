//! Native feature layers that are consumed by the Angular map viewer.
//!
//! The base image renderer stays focused on pixels. This module owns the
//! mark-producing layers so rooms, objects, zombies, foraging, and streets can
//! be enabled or extended independently.

use super::LotHeader;
use image::GenericImageView;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

type OverlayResult<T> = Result<T, String>;

pub(crate) fn generate(
    config: &Value,
    map_path: &Path,
    pz_root: &Path,
    headers: &HashMap<(i32, i32), LotHeader>,
    map_data_root: &Path,
    emit: &mut impl FnMut(f32, &str, &str),
) -> OverlayResult<()> {
    let rooms_config = super::effective_command_config(config, "rooms");
    let zombie_config = super::effective_command_config(config, "zombie");
    let streets_config = super::effective_command_config(config, "streets");
    let objects_config = super::effective_command_config(config, "objects");
    let foraging_config = super::effective_command_config(config, "foraging");
    let rooms_use_marks = config_bool(&rooms_config, &["render_conf", "use_mark"]).unwrap_or(true);
    let zombie_use_marks =
        config_bool(&zombie_config, &["render_conf", "use_mark"]).unwrap_or(true);
    let zombie_counts =
        config_bool(&zombie_config, &["render_conf", "zombie_count"]).unwrap_or(true);
    let objects_use_marks =
        config_bool(&objects_config, &["render_conf", "use_mark"]).unwrap_or(true);
    let rooms_headers = filtered_headers(
        headers,
        super::configured_cell_ranges(&rooms_config, "render_cell_range")?.as_deref(),
    );
    let zombie_headers = filtered_headers(
        headers,
        super::configured_cell_ranges(&zombie_config, "render_cell_range")?.as_deref(),
    );
    emit(
        63.0,
        "overlays",
        &format!(
            "Generating overlay metadata for {} selected map cells",
            headers.len()
        ),
    );
    emit(63.1, "overlays", "Generating room marks");
    write_marks(
        &map_data_root.join("rooms/marks.json"),
        if rooms_use_marks {
            room_marks(&rooms_headers)
        } else {
            Vec::new()
        },
    )?;
    emit(63.2, "overlays", "Generating zombie marks");
    write_marks(
        &map_data_root.join("zombie/marks.json"),
        if zombie_use_marks && zombie_counts {
            zombie_marks(&zombie_headers)
        } else {
            Vec::new()
        },
    )?;
    emit(63.3, "overlays", "Generating street marks");
    write_marks(
        &map_data_root.join("streets/marks.json"),
        street_marks(map_path, &streets_config),
    )?;
    emit(63.4, "overlays", "Generating object marks");
    write_marks(
        &map_data_root.join("objects/marks.json"),
        if objects_use_marks {
            object_marks(map_path, &objects_config)
        } else {
            Vec::new()
        },
    )?;
    emit(63.5, "overlays", "Generating foraging marks");
    write_marks(
        &map_data_root.join("foraging/marks.json"),
        foraging_marks(map_path, pz_root, &foraging_config),
    )?;
    emit(63.6, "overlays", "Overlay metadata complete");
    Ok(())
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

fn write_marks(path: &Path, marks: Vec<Value>) -> OverlayResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(&marks).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn room_marks(headers: &HashMap<(i32, i32), LotHeader>) -> Vec<Value> {
    let mut marks = Vec::new();
    for header in headers.values() {
        let dx = header.x * header.cell_size;
        let dy = header.y * header.cell_size;
        for (index, room) in header.rooms.iter().enumerate() {
            let rects = room
                .rects
                .iter()
                .map(|(x, y, width, height)| {
                    json!({
                        "x": x + dx,
                        "y": y + dy,
                        "width": width,
                        "height": height
                    })
                })
                .collect::<Vec<_>>();
            marks.push(json!({
                "id": format!("room-{}-{}-{}", header.x, header.y, index),
                "type": "area",
                "color": room_color(&room.name),
                "name": room.name,
                "layer": room.layer,
                "rects": rects
            }));
        }
    }
    marks
}

fn zombie_marks(headers: &HashMap<(i32, i32), LotHeader>) -> Vec<Value> {
    let mut marks = Vec::new();
    for header in headers.values() {
        for (bx, row) in header.zpop.iter().enumerate() {
            for (by, count) in row.iter().enumerate() {
                if *count == 0 {
                    continue;
                }
                let x = header.x * header.cell_size
                    + bx as i32 * header.block_size as i32
                    + header.block_size as i32 / 2;
                let y = header.y * header.cell_size
                    + by as i32 * header.block_size as i32
                    + header.block_size as i32 / 2;
                marks.push(json!({
                    "id": format!("zombie-{}-{}-{}-{}", header.x, header.y, bx, by),
                    "type": "text",
                    "x": x,
                    "y": y,
                    "name": count.to_string(),
                    "color": zombie_color(*count)
                }));
            }
        }
    }
    marks
}

fn zombie_color(value: u8) -> String {
    let (r, g, b) = if value >= 128 {
        (
            ((value as i32 - 128) * 2).min(255),
            255 - ((value as i32 - 128) * 2).min(255),
            0,
        )
    } else {
        (
            0,
            (value as i32 * 2).min(255),
            255 - (value as i32 * 2).min(255),
        )
    };
    format!("#{r:02x}{g:02x}{b:02x}")
}

pub(crate) fn room_color(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "gym" => "lime",
        "garagestorage" | "storage" | "garage" | "warehouse" | "closet" | "construction"
        | "factory" | "firestorage" | "shed" | "pawnshop" | "pawnshopstorage" => "orange",
        "toolstore" | "storageunit" | "farmstorage" | "loggingfactory" => "magenta",
        "toolstorage" => "blue",
        "empty" | "emptyoutside" => "silver",
        _ => "cyan",
    }
}

fn street_marks(path: &Path, config: &Value) -> Vec<Value> {
    let source = path.join("streets.xml");
    let Ok(text) = fs::read_to_string(source) else {
        return Vec::new();
    };
    let colors = [
        config_string(config, &["render_conf", "streets_large"]).unwrap_or_else(|| "Orange".into()),
        config_string(config, &["render_conf", "streets_medium"]).unwrap_or_else(|| "Coral".into()),
        config_string(config, &["render_conf", "streets_small"]).unwrap_or_else(|| "Cyan".into()),
    ];
    let mut result = Vec::new();
    let mut cursor = 0;
    while let Some(start) = text[cursor..].find("<street") {
        let start = cursor + start;
        if text
            .as_bytes()
            .get(start + "<street".len())
            .is_some_and(|byte| byte.is_ascii_alphabetic())
        {
            cursor = start + "<street".len();
            continue;
        }
        let end = text[start..]
            .find('>')
            .map(|offset| start + offset)
            .unwrap_or(text.len());
        let tag = &text[start..end];
        let name = attribute(tag, "name").unwrap_or_default();
        let width = attribute(tag, "width")
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(0);
        let close = text[end..]
            .find("</street>")
            .map(|offset| end + offset)
            .unwrap_or(text.len());
        let body = &text[end..close];
        let mut points = Vec::new();
        let mut point_cursor = 0;
        while let Some(point_start) = body[point_cursor..].find("<point") {
            let point_start = point_cursor + point_start;
            let point_end = body[point_start..]
                .find('>')
                .map(|offset| point_start + offset)
                .unwrap_or(body.len());
            let point = &body[point_start..point_end];
            if let (Some(x), Some(y)) = (
                attribute(point, "x").and_then(|v| v.parse::<f64>().ok()),
                attribute(point, "y").and_then(|v| v.parse::<f64>().ok()),
            ) {
                points.push(json!({"x": x, "y": y}));
            }
            point_cursor = point_end.saturating_add(1);
        }
        let span = span(&points);
        let level = if span > 512.0 || width > 12 {
            0
        } else if span > 256.0 || width > 8 {
            1
        } else {
            2
        };
        result.push(json!({
            "id": format!("street-{}", result.len()),
            "type": "polyline",
            "name": name,
            "width": width,
            "points": points,
            "visible_zoom_level": level,
            "color": css_color(&colors[level], 0.5),
            "text_color": colors[level]
        }));
        cursor = close.saturating_add("</street>".len());
    }
    result
}

fn object_marks(path: &Path, config: &Value) -> Vec<Value> {
    let source = path.join("objects.lua");
    let Ok(text) = fs::read_to_string(source) else {
        return Vec::new();
    };
    let default_color = config_string(config, &["render_conf", "objects_color_default"])
        .unwrap_or_else(|| "White".into());
    let allowed_types: HashSet<String> = config
        .get("render_conf")
        .and_then(|value| value.get("objects_color"))
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|colors| colors.iter())
        .filter(|(_, color)| color.as_str() != Some("skip"))
        .map(|(object_type, _)| object_type.clone())
        .collect();
    let mut marks = Vec::new();
    for entry in lua_records(&text) {
        let Some(object_type) = lua_string(entry, "type") else {
            continue;
        };
        if !allowed_types.contains(&object_type) {
            continue;
        }
        let rects = object_rects(entry);
        if rects.is_empty() {
            continue;
        }
        let rect_values = rects
            .iter()
            .map(|(x, y, width, height)| json!({"x": x, "y": y, "width": width, "height": height}))
            .collect::<Vec<_>>();
        marks.push(json!({
            "id": format!("object-{}", marks.len()),
            "type": "area",
            "color": config_string(config, &["render_conf", "objects_color", &object_type]).unwrap_or_else(|| default_color.clone()),
            "name": lua_string(entry, "name").unwrap_or_default(),
            "layer": lua_number(entry, "z").unwrap_or(0.0),
            "rects": rect_values
        }));
    }
    marks
}

pub(crate) fn object_rects(entry: &str) -> Vec<(i32, i32, i32, i32)> {
    let geometry = lua_string(entry, "geometry").unwrap_or_else(|| "rect".into());
    if geometry.eq_ignore_ascii_case("rect") {
        let (Some(x), Some(y), Some(width), Some(height)) = (
            lua_number(entry, "x"),
            lua_number(entry, "y"),
            lua_number(entry, "width"),
            lua_number(entry, "height"),
        ) else {
            return Vec::new();
        };
        let rect = (x as i32, y as i32, width as i32, height as i32);
        return (rect.2 > 0 && rect.3 > 0)
            .then_some(rect)
            .into_iter()
            .collect();
    }

    if !geometry.eq_ignore_ascii_case("polygon") && !geometry.eq_ignore_ascii_case("polyline") {
        return Vec::new();
    }
    let points = lua_array_numbers(entry, "points")
        .chunks_exact(2)
        .map(|pair| (pair[0], pair[1]))
        .collect::<Vec<_>>();
    if points.len() < 2 || (geometry.eq_ignore_ascii_case("polygon") && points.len() < 3) {
        return Vec::new();
    }
    let line_width = lua_number(entry, "lineWidth").unwrap_or(0.0).max(0.0);
    let padding = if geometry.eq_ignore_ascii_case("polyline") {
        line_width / 2.0
    } else {
        0.0
    };
    let min_x = points.iter().map(|(x, _)| *x).fold(f64::INFINITY, f64::min) - padding;
    let max_x = points
        .iter()
        .map(|(x, _)| *x)
        .fold(f64::NEG_INFINITY, f64::max)
        + padding;
    let min_y = points.iter().map(|(_, y)| *y).fold(f64::INFINITY, f64::min) - padding;
    let max_y = points
        .iter()
        .map(|(_, y)| *y)
        .fold(f64::NEG_INFINITY, f64::max)
        + padding;
    let x_start = min_x.floor() as i32;
    let x_end = max_x.ceil() as i32;
    let y_start = min_y.floor() as i32;
    let y_end = max_y.ceil() as i32;
    let mut cells = Vec::new();
    for y in y_start..y_end {
        for x in x_start..x_end {
            let center = (x as f64 + 0.5, y as f64 + 0.5);
            let inside = if geometry.eq_ignore_ascii_case("polygon") {
                point_in_polygon(&points, center.0, center.1)
            } else {
                line_width > 0.0 && point_near_polyline(&points, center.0, center.1, line_width)
            };
            if inside {
                cells.push((x, y));
            }
        }
    }
    rect_cover(&cells)
}

fn point_in_polygon(points: &[(f64, f64)], x: f64, y: f64) -> bool {
    let mut winding = 0;
    for (first, second) in points
        .iter()
        .zip(points.iter().cycle().skip(1))
        .take(points.len())
    {
        if first.1 <= y && second.1 > y {
            if (second.0 - first.0) * (y - first.1) - (x - first.0) * (second.1 - first.1) > 0.0 {
                winding += 1;
            }
        } else if second.1 <= y
            && first.1 > y
            && (second.0 - first.0) * (y - first.1) - (x - first.0) * (second.1 - first.1) < 0.0
        {
            winding -= 1;
        }
    }
    winding != 0
}

fn point_near_polyline(points: &[(f64, f64)], x: f64, y: f64, line_width: f64) -> bool {
    points.windows(2).any(|segment| {
        let (x1, y1) = segment[0];
        let (x2, y2) = segment[1];
        let dx = x2 - x1;
        let dy = y2 - y1;
        let length_squared = dx * dx + dy * dy;
        let t = if length_squared == 0.0 {
            0.0
        } else {
            (((x - x1) * dx + (y - y1) * dy) / length_squared).clamp(0.0, 1.0)
        };
        let nearest_x = x1 + t * dx;
        let nearest_y = y1 + t * dy;
        (x - nearest_x).hypot(y - nearest_y) <= line_width / 2.0 + 0.5
    })
}

fn rect_cover(cells: &[(i32, i32)]) -> Vec<(i32, i32, i32, i32)> {
    let mut rows = HashMap::<i32, Vec<(i32, i32)>>::new();
    for &(x, y) in cells {
        rows.entry(y).or_default().push((x, x));
    }
    for runs in rows.values_mut() {
        runs.sort_unstable();
        let mut merged: Vec<(i32, i32)> = Vec::new();
        for (start, end) in runs.drain(..) {
            if let Some(last) = merged.last_mut() {
                if start <= last.1 + 1 {
                    last.1 = last.1.max(end);
                    continue;
                }
            }
            merged.push((start, end));
        }
        *runs = merged;
    }
    let mut rects = Vec::new();
    let mut active: Vec<(i32, i32, i32, i32)> = Vec::new();
    let mut ys = rows.keys().copied().collect::<Vec<_>>();
    ys.sort_unstable();
    for y in ys {
        let runs = rows.remove(&y).unwrap_or_default();
        let mut next = Vec::new();
        for (start, end) in runs {
            if let Some(index) = active.iter().position(|(x, width, _, last_y)| {
                *x == start && *width == end - start + 1 && *last_y + 1 == y
            }) {
                let mut rect = active.swap_remove(index);
                rect.3 = y;
                next.push(rect);
            } else {
                next.push((start, end - start + 1, y, y));
            }
        }
        rects.extend(
            active
                .into_iter()
                .map(|(x, width, start_y, end_y)| (x, start_y, width, end_y - start_y + 1)),
        );
        active = next;
    }
    rects.extend(
        active
            .into_iter()
            .map(|(x, width, start_y, end_y)| (x, start_y, width, end_y - start_y + 1)),
    );
    rects
}

fn foraging_marks(path: &Path, pz_root: &Path, config: &Value) -> Vec<Value> {
    let map_dir = path.join("maps");
    let Ok(entries) = fs::read_dir(&map_dir) else {
        return Vec::new();
    };
    let default_color = config_string(config, &["render_conf", "foraging_color_default"])
        .unwrap_or_else(|| "Gray".into());
    let biome_mapping = load_biome_mapping(pz_root);
    let mut result = Vec::new();
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
        let Some((cx, cy)) = stem
            .split_once('_')
            .and_then(|(x, y)| Some((x.parse::<i32>().ok()?, y.parse::<i32>().ok()?)))
        else {
            continue;
        };
        let Ok(image) = image::open(&file) else {
            continue;
        };
        let (width, height) = image.dimensions();
        let mut values = vec![0u8; (width * height) as usize];
        for y in 0..height {
            for x in 0..width {
                values[(y * width + x) as usize] = image.get_pixel(x, y).0[0];
            }
        }
        for y in 0..height {
            let mut x = 0;
            while x < width {
                let value = values[(y * width + x) as usize];
                let mut end = x + 1;
                while end < width && values[(y * width + end) as usize] == value {
                    end += 1;
                }
                if value != 0 {
                    let biome_name = biome_mapping
                        .get(&value)
                        .cloned()
                        .unwrap_or_else(|| format!("biome-{value}"));
                    let color = config_string(
                        config,
                        &["render_conf", "foraging_color", biome_name.as_str()],
                    )
                    .unwrap_or_else(|| default_color.clone());
                    if color.eq_ignore_ascii_case("skip") {
                        x = end;
                        continue;
                    }
                    result.push(json!({
                        "id": format!("foraging-{}-{}-{}-{}", cx, cy, x, y),
                        "type": "area",
                        "color": color,
                        "name": biome_name,
                        "layer": 0,
                        "rects": [{"x": cx * width as i32 + x as i32, "y": cy * height as i32 + y as i32, "width": end - x, "height": 1}]
                    }));
                }
                x = end;
            }
        }
    }
    result
}

pub(crate) fn load_biome_mapping(pz_root: &Path) -> HashMap<u8, String> {
    let path = pz_root
        .join("media/lua/server/metazones")
        .join("BiomeMapConfig.lua");
    let Ok(source) = fs::read_to_string(path) else {
        return HashMap::new();
    };

    // The upstream file is a Lua table of records such as
    // `{ pixel = 1, zone = "Nav" }`.  We intentionally parse only these
    // declarative fields so the renderer does not need an embedded Lua VM.
    let mut mapping = HashMap::new();
    for record in source
        .split('{')
        .skip(1)
        .filter_map(|part| part.split('}').next())
    {
        let Some(pixel) = lua_field_number(record, "pixel") else {
            continue;
        };
        let Some(zone) = lua_field_string(record, "zone") else {
            continue;
        };
        if (0..=u8::MAX as i32).contains(&pixel) && !zone.is_empty() {
            mapping.insert(pixel as u8, zone);
        }
    }
    mapping
}

fn lua_field_number(record: &str, key: &str) -> Option<i32> {
    let start = record.find(key)? + key.len();
    let value = record[start..].trim_start_matches(|character: char| {
        character.is_whitespace() || character == '=' || character == '[' || character == ']'
    });
    let end = value
        .find(|character: char| !character.is_ascii_digit() && character != '-')
        .unwrap_or(value.len());
    value[..end].parse().ok()
}

fn lua_field_string(record: &str, key: &str) -> Option<String> {
    let start = record.find(key)? + key.len();
    let value = record[start..].trim_start_matches(|character: char| {
        character.is_whitespace() || character == '=' || character == '[' || character == ']'
    });
    let quote = value.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let end = value[1..].find(quote)? + 1;
    Some(value[1..end].to_string())
}

fn config_string(config: &Value, path: &[&str]) -> Option<String> {
    let mut value = config;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_str().map(str::to_string)
}

fn config_bool(config: &Value, path: &[&str]) -> Option<bool> {
    let mut value = config;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_bool()
}

fn attribute(tag: &str, key: &str) -> Option<String> {
    let marker = format!("{key}=");
    let start = tag.find(&marker)? + marker.len();
    let remainder = tag[start..].trim_start();
    let quote = remainder.chars().next()?;
    if quote == '\"' || quote == '\'' {
        let end = remainder[1..].find(quote)? + 1;
        Some(remainder[1..end].to_string())
    } else {
        Some(
            remainder
                .split_whitespace()
                .next()?
                .trim_end_matches('>')
                .to_string(),
        )
    }
}

fn css_color(name: &str, alpha: f32) -> String {
    let [r, g, b, _] = parse_css_color(name, 255);
    format!("rgba({r},{g},{b},{alpha})")
}

pub(crate) fn parse_css_color(value: &str, default_alpha: u8) -> [u8; 4] {
    let normalized = normalize_legacy_alpha(value);
    let Ok(color) = csscolorparser::parse(&normalized) else {
        return [128, 128, 128, default_alpha];
    };
    let mut rgba = color.to_rgba8();
    if !has_explicit_alpha(value) {
        rgba[3] = default_alpha;
    }
    rgba
}

fn has_explicit_alpha(value: &str) -> bool {
    let value = value.trim();
    if value.eq_ignore_ascii_case("transparent") {
        return true;
    }
    if let Some(hex) = value.strip_prefix('#') {
        return hex.len() == 4 || hex.len() == 8;
    }
    let Some(open) = value.find('(') else {
        return false;
    };
    let Some(inner) = value[open + 1..].strip_suffix(')') else {
        return false;
    };
    inner.contains('/') || inner.split(',').count() >= 4
}

fn normalize_legacy_alpha(value: &str) -> String {
    let trimmed = value.trim();
    let Some(open) = trimmed.find('(') else {
        return trimmed.to_string();
    };
    let Some(inner) = trimmed[open + 1..].strip_suffix(')') else {
        return trimmed.to_string();
    };
    let values = inner.split(',').map(str::trim).collect::<Vec<_>>();
    if values.len() != 4 {
        return trimmed.to_string();
    }
    let Ok(alpha) = values[3].parse::<f64>() else {
        return trimmed.to_string();
    };
    if !(1.0..=255.0).contains(&alpha) {
        return trimmed.to_string();
    }
    format!(
        "{}({},{},{},{})",
        &trimmed[..open],
        values[0],
        values[1],
        values[2],
        alpha / 255.0
    )
}

fn span(points: &[Value]) -> f64 {
    let mut min_x = f64::MAX;
    let mut max_x = f64::MIN;
    let mut min_y = f64::MAX;
    let mut max_y = f64::MIN;
    for point in points {
        let x = point.get("x").and_then(Value::as_f64).unwrap_or(0.0);
        let y = point.get("y").and_then(Value::as_f64).unwrap_or(0.0);
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    (max_x - min_x).max(max_y - min_y)
}

fn lua_string(entry: &str, key: &str) -> Option<String> {
    let remainder = lua_value(entry, key)?;
    let quote = remainder.chars().next()?;
    if quote != '\"' && quote != '\'' {
        return None;
    }
    let end = remainder[1..].find(quote)? + 1;
    Some(remainder[1..end].to_string())
}

fn lua_number(entry: &str, key: &str) -> Option<f64> {
    let value = lua_value(entry, key)?;
    let token = value
        .split(|c: char| c == ',' || c == '}' || c.is_whitespace())
        .next()?;
    token.parse().ok()
}

fn lua_array_numbers(entry: &str, key: &str) -> Vec<f64> {
    let Some(start) = entry.find(key) else {
        return Vec::new();
    };
    let Some(open_offset) = entry[start + key.len()..].find('{') else {
        return Vec::new();
    };
    let open = start + key.len() + open_offset;
    let Some(close_offset) = entry[open + 1..].find('}') else {
        return Vec::new();
    };
    entry[open + 1..open + 1 + close_offset]
        .split(',')
        .filter_map(|value| value.trim().parse().ok())
        .collect()
}

pub(crate) fn lua_records(text: &str) -> Vec<&str> {
    let mut records = Vec::new();
    let mut depth = 0usize;
    let mut record_start = None;
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in text.char_indices() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == active_quote {
                quote = None;
            }
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
            continue;
        }
        match character {
            '{' => {
                if depth == 1 {
                    record_start = Some(index + character.len_utf8());
                }
                depth += 1;
            }
            '}' => {
                if depth == 0 {
                    continue;
                }
                depth -= 1;
                if depth == 1 {
                    if let Some(start) = record_start.take() {
                        records.push(&text[start..index]);
                    }
                }
            }
            _ => {}
        }
    }
    records
}

fn lua_value<'a>(entry: &'a str, key: &str) -> Option<&'a str> {
    entry.split(',').find_map(|field| {
        let (name, value) = field.split_once('=')?;
        (name.trim() == key).then_some(value.trim())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_object_records_and_covers_polygon_cells() {
        let source = r#"objects = {
            { type = "Polygon", geometry = "polygon", points = {0, 0, 3, 0, 3, 3, 0, 3}, z = 0 },
            { type = "Line", geometry = "polyline", points = {0, 0, 4, 0}, lineWidth = 2, z = 0 }
        }"#;
        let records = lua_records(source);
        assert_eq!(records.len(), 2);
        assert_eq!(
            lua_string(records[0], "geometry").as_deref(),
            Some("polygon")
        );
        assert_eq!(lua_array_numbers(records[0], "points").len(), 8);
        assert_eq!(object_rects(records[0]), vec![(0, 0, 3, 3)]);
        assert!(!object_rects(records[1]).is_empty());
    }

    #[test]
    fn loads_b42_biome_pixel_mapping_without_lua_runtime() {
        let root = std::env::temp_dir().join(format!("pz-honus-hub-biome-{}", std::process::id()));
        let path = root.join("media/lua/server/metazones/BiomeMapConfig.lua");
        fs::create_dir_all(path.parent().expect("biome parent")).expect("create biome parent");
        fs::write(
            &path,
            r#"
                biome_map_config = {
                    { pixel = 1, zone = "Nav" },
                    { pixel=2, zone='Forest' },
                }
            "#,
        )
        .expect("write biome config");

        let mapping = load_biome_mapping(&root);
        assert_eq!(mapping.get(&1).map(String::as_str), Some("Nav"));
        assert_eq!(mapping.get(&2).map(String::as_str), Some("Forest"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preserves_python_street_marks_with_empty_or_single_point_paths() {
        let root =
            std::env::temp_dir().join(format!("pz-honus-hub-street-marks-{}", std::process::id()));
        fs::create_dir_all(&root).expect("create street source directory");
        fs::write(
            root.join("streets.xml"),
            r#"<streets>
                <street name="single" width="4">
                    <points><point x="1" y="2" /></points>
                </street>
                <street name="empty" width="0"><points /></street>
            </streets>"#,
        )
        .expect("write street source");

        let marks = street_marks(&root, &serde_json::json!({}));
        assert_eq!(marks.len(), 2);
        assert_eq!(marks[0]["points"].as_array().map(Vec::len), Some(1));
        assert_eq!(marks[1]["points"].as_array().map(Vec::len), Some(0));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_css_color_forms_with_configured_default_alpha() {
        assert_eq!(parse_css_color("DeepSkyBlue", 128), [0, 191, 255, 128]);
        assert_eq!(parse_css_color("#abcd", 128), [170, 187, 204, 221]);
        assert_eq!(
            parse_css_color("rgba(255, 0, 0, 128)", 255),
            [255, 0, 0, 128]
        );
        assert_eq!(
            parse_css_color("hsl(120, 100%, 50%)", 128),
            [0, 255, 0, 128]
        );
    }
}
