//! Native renderer core for the map builder.
//!
//! The renderer deliberately keeps the format readers, texture cache, geometry,
//! and DZI writer independent. New render layers can implement the same
//! `RenderView` shape without changing the process or Tauri integration.

use encoding_rs::{EUC_KR, WINDOWS_1252};
use png::{ColorType, Decoder, Transformations};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;
use sysinfo::System;
use walkdir::WalkDir;

mod cache;
mod gpu_pyramid;
mod map_config;
mod output;
mod overlay_raster;
mod overlays;
mod save_chunk;
mod save_game;
mod world_dictionary;

use map_config::{MapCatalog, TextureSource};
use output::{ImageSaveOptions, OutputFormat, RgbaImage};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PyramidBackend {
    Cpu,
    Gpu,
    Auto,
}

impl PyramidBackend {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Cpu => "CPU",
            Self::Gpu => "GPU (required)",
            Self::Auto => "CPU parallel (GPU opt-in)",
        }
    }
}

const ISO_GRID_WIDTH: i32 = 64;
const ISO_GRID_HEIGHT: i32 = 32;
const ISO_SQUARE_WIDTH: i32 = 128;
const ISO_SQUARE_HEIGHT: i32 = 64;

type RenderResult<T> = Result<T, String>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct ConfiguredAdditionalMap {
    name: String,
    folder: Option<String>,
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn at(data: &'a [u8], pos: usize) -> Self {
        Self { data, pos }
    }

    fn ensure(&self, count: usize) -> RenderResult<()> {
        self.data
            .get(self.pos..self.pos.saturating_add(count))
            .filter(|slice| slice.len() == count)
            .map(|_| ())
            .ok_or_else(|| "Unexpected end of Project Zomboid map data.".to_string())
    }

    fn u32(&mut self) -> RenderResult<u32> {
        self.ensure(4)?;
        let value = u32::from_le_bytes(self.data[self.pos..self.pos + 4].try_into().unwrap());
        self.pos += 4;
        Ok(value)
    }

    fn u8(&mut self) -> RenderResult<u8> {
        self.ensure(1)?;
        let value = self.data[self.pos];
        self.pos += 1;
        Ok(value)
    }

    fn i32(&mut self) -> RenderResult<i32> {
        Ok(self.u32()? as i32)
    }

    fn bytes(&mut self) -> RenderResult<Vec<u8>> {
        let length = self.u32()? as usize;
        self.ensure(length)?;
        let value = self.data[self.pos..self.pos + length].to_vec();
        self.pos += length;
        Ok(value)
    }

    fn line(&mut self) -> RenderResult<Vec<u8>> {
        let start = self.pos;
        let end = self.data[start..]
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|offset| start + offset)
            .ok_or_else(|| "Project Zomboid map line has no terminator.".to_string())?;
        self.pos = end + 1;
        Ok(self.data[start..end].to_vec())
    }

    fn skip(&mut self, count: usize) -> RenderResult<()> {
        self.ensure(count)?;
        self.pos += count;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Room {
    pub(crate) name: String,
    pub(crate) layer: i32,
    pub(crate) rects: Vec<(i32, i32, i32, i32)>,
}

#[derive(Debug, Clone)]
pub(crate) struct LotHeader {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) version: u32,
    pub(crate) cell_blocks: usize,
    pub(crate) block_size: usize,
    pub(crate) cell_size: i32,
    pub(crate) min_layer: i32,
    pub(crate) max_layer: i32,
    pub(crate) tiles: Vec<String>,
    pub(crate) rooms: Vec<Room>,
    pub(crate) zpop: Vec<Vec<u8>>,
}

#[derive(Debug, Clone)]
struct Cell {
    tiles: HashMap<(i32, usize, usize), Vec<String>>,
}

impl Cell {
    fn tile_names(&self, sub_x: usize, sub_y: usize, layer: i32) -> Option<&[String]> {
        self.tiles.get(&(layer, sub_x, sub_y)).map(Vec::as_slice)
    }
}

/// Bounded cell reader matching the Python renderer's `load_cell_cached`
/// behavior.  A map can contain tens of thousands of cells, so keeping every
/// decoded cell alive defeats incremental rendering and needlessly increases
/// peak memory.  Rendering is single-threaded at this boundary, which keeps
/// the cache small and deterministic without synchronization overhead.
struct CellCache {
    map_path: PathBuf,
    headers: HashMap<(i32, i32), LotHeader>,
    coordinates: Vec<(i32, i32)>,
    cells: HashMap<(i32, i32), Cell>,
    order: VecDeque<(i32, i32)>,
    capacity: usize,
}

impl CellCache {
    const DEFAULT_CAPACITY: usize = 16;

    fn new(map_path: PathBuf, headers: HashMap<(i32, i32), LotHeader>) -> Self {
        let mut coordinates = headers.keys().copied().collect::<Vec<_>>();
        coordinates.sort_unstable();
        Self {
            map_path,
            headers,
            coordinates,
            cells: HashMap::new(),
            order: VecDeque::new(),
            capacity: Self::DEFAULT_CAPACITY,
        }
    }

    fn get(&mut self, coordinate: (i32, i32)) -> RenderResult<Option<&Cell>> {
        if !self.cells.contains_key(&coordinate) {
            let Some(header) = self.headers.get(&coordinate) else {
                return Ok(None);
            };
            let cell = load_cell(&self.map_path, header)?;
            self.cells.insert(coordinate, cell);
        }

        self.order.retain(|entry| *entry != coordinate);
        self.order.push_back(coordinate);
        while self.order.len() > self.capacity {
            if let Some(evicted) = self.order.pop_front() {
                self.cells.remove(&evicted);
            }
        }
        Ok(self.cells.get(&coordinate))
    }
}

#[derive(Debug, Clone)]
struct Texture {
    width: usize,
    height: usize,
    offset_x: i32,
    offset_y: i32,
    pixels: Vec<u8>,
}

impl Texture {
    fn from_rgba(pixels: Vec<u8>, width: usize, height: usize) -> Self {
        let mut texture = Self {
            width,
            height,
            offset_x: 0,
            offset_y: 0,
            pixels,
        };
        texture.trim_transparent_bounds();
        texture
    }

    fn crop(
        page: &[u8],
        page_width: usize,
        x: usize,
        y: usize,
        width: usize,
        height: usize,
    ) -> Self {
        let mut pixels = vec![0; width * height * 4];
        for row in 0..height {
            let source_start = ((y + row) * page_width + x) * 4;
            let target_start = row * width * 4;
            let source_end = source_start.saturating_add(width * 4);
            if source_end <= page.len() && target_start + width * 4 <= pixels.len() {
                pixels[target_start..target_start + width * 4]
                    .copy_from_slice(&page[source_start..source_end]);
            }
        }
        let mut texture = Self {
            width,
            height,
            offset_x: 0,
            offset_y: 0,
            pixels,
        };
        texture.trim_transparent_bounds();
        texture
    }

    fn trim_transparent_bounds(&mut self) {
        let Some((min_x, min_y, max_x, max_y)) = self
            .pixels
            .chunks_exact(4)
            .enumerate()
            .filter(|(_, pixel)| pixel[3] != 0)
            .map(|(index, _)| (index % self.width.max(1), index / self.width.max(1)))
            .fold(None::<(usize, usize, usize, usize)>, |bounds, (x, y)| {
                Some(match bounds {
                    Some((min_x, min_y, max_x, max_y)) => {
                        (min_x.min(x), min_y.min(y), max_x.max(x), max_y.max(y))
                    }
                    None => (x, y, x, y),
                })
            })
        else {
            self.width = 0;
            self.height = 0;
            self.offset_x = 0;
            self.offset_y = 0;
            self.pixels.clear();
            return;
        };

        if min_x == 0 && min_y == 0 && max_x + 1 == self.width && max_y + 1 == self.height {
            return;
        }

        let width = max_x - min_x + 1;
        let height = max_y - min_y + 1;
        let mut pixels = vec![0; width * height * 4];
        for y in 0..height {
            let source_start = ((min_y + y) * self.width + min_x) * 4;
            let target_start = y * width * 4;
            pixels[target_start..target_start + width * 4]
                .copy_from_slice(&self.pixels[source_start..source_start + width * 4]);
        }
        self.width = width;
        self.height = height;
        self.offset_x += min_x as i32;
        self.offset_y += min_y as i32;
        self.pixels = pixels;
    }

    fn composite_into(&self, target: &mut RgbaImage, x: i32, y: i32) {
        let origin_x = x + self.offset_x;
        let origin_y = y + self.offset_y;
        for source_y in 0..self.height as i32 {
            for source_x in 0..self.width as i32 {
                let target_x = origin_x + source_x;
                let target_y = origin_y + source_y;
                if target_x < 0
                    || target_y < 0
                    || target_x >= target.width as i32
                    || target_y >= target.height as i32
                {
                    continue;
                }
                let source_index =
                    ((source_y as usize * self.width + source_x as usize) * 4) as usize;
                target.blend_pixel(
                    target_x,
                    target_y,
                    self.pixels[source_index..source_index + 4]
                        .try_into()
                        .expect("texture pixels are RGBA"),
                );
            }
        }
    }

    fn opaque_color_sum(&self) -> ([u64; 3], u64) {
        let mut sum = [0u64; 3];
        let mut count = 0u64;
        for pixel in self.pixels.chunks_exact(4) {
            if pixel[3] == 255 {
                sum[0] += pixel[0] as u64;
                sum[1] += pixel[1] as u64;
                sum[2] += pixel[2] as u64;
                count += 1;
            }
        }
        (sum, count)
    }
}

#[derive(Clone)]
struct TextureLocator {
    pack: PathBuf,
    png_offset: usize,
    png_length: usize,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    offset_x: i32,
    offset_y: i32,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct TexturePageKey {
    pack: PathBuf,
    offset: usize,
    length: usize,
}

struct DecodedTexturePage {
    pixels: Vec<u8>,
    width: usize,
}

const DEFAULT_DECODED_PAGE_CACHE_BYTES: usize = 256 * 1024 * 1024;
const MAX_DECODED_PAGE_CACHE_PAGES: usize = 64;

#[derive(Default)]
pub(crate) struct TextureLibrary {
    textures: HashMap<String, Texture>,
    locators: HashMap<String, TextureLocator>,
    raw_paths: Vec<PathBuf>,
    pack_data: HashMap<PathBuf, Vec<u8>>,
    decoded_pages: HashMap<TexturePageKey, DecodedTexturePage>,
    decoded_page_order: VecDeque<TexturePageKey>,
    decoded_page_bytes: usize,
    decoded_page_cache_limit_bytes: usize,
    indexed_pack_count: usize,
    pack_read_count: usize,
    decoded_page_count: usize,
}

impl TextureLibrary {
    fn configure_decoded_page_cache(&mut self, config: &Value) {
        let configured_mb = config
            .get("render_conf")
            .and_then(|render| render.get("cache_limit_mb"))
            .and_then(Value::as_u64);
        let limit_mb = configured_mb
            .filter(|value| *value > 0)
            .unwrap_or(256)
            .min(16 * 1024);
        self.decoded_page_cache_limit_bytes = (limit_mb as usize).saturating_mul(1024 * 1024);
        self.evict_decoded_pages();
    }

    fn evict_decoded_pages(&mut self) {
        while (self.decoded_page_bytes > self.decoded_page_cache_limit_bytes
            || self.decoded_page_order.len() > MAX_DECODED_PAGE_CACHE_PAGES)
            && self.decoded_page_order.len() > 1
        {
            if let Some(evicted) = self.decoded_page_order.pop_front()
                && let Some(page) = self.decoded_pages.remove(&evicted)
            {
                self.decoded_page_bytes = self.decoded_page_bytes.saturating_sub(page.pixels.len());
            }
        }
    }

    fn load_directories_with_progress<F>(paths: &[PathBuf], progress: F) -> RenderResult<Self>
    where
        F: FnMut(String),
    {
        let sources = paths
            .iter()
            .cloned()
            .map(|path| TextureSource {
                path,
                patterns: Vec::new(),
            })
            .collect::<Vec<_>>();
        Self::load_sources_with_progress(&sources, progress)
    }

    fn load_sources_with_progress<F>(
        sources: &[TextureSource],
        mut progress: F,
    ) -> RenderResult<Self>
    where
        F: FnMut(String),
    {
        let mut library = Self::default();
        let mut packs_to_index = Vec::new();
        for source in sources {
            let path = &source.path;
            if !path.is_dir() {
                continue;
            }
            if !library.raw_paths.contains(path) {
                library.raw_paths.push(path.clone());
            }
            let mut packs = fs::read_dir(path)
                .map_err(|error| error.to_string())?
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|entry| {
                    entry
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("pack"))
                })
                .collect::<Vec<_>>();
            packs.sort();
            let patterns = source
                .patterns
                .iter()
                .map(|pattern| {
                    regex::Regex::new(pattern).map_err(|error| {
                        format!("Invalid texture pack pattern {pattern:?}: {error}")
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            for pack in packs {
                let include = patterns.is_empty()
                    || pack
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| {
                            patterns.iter().any(|pattern| {
                                pattern
                                    .find(name)
                                    .is_some_and(|matched| matched.start() == 0)
                            })
                        });
                if include {
                    if !packs_to_index.contains(&pack) {
                        packs_to_index.push(pack);
                    }
                }
            }
        }
        let total = packs_to_index.len();
        for (index, pack) in packs_to_index.into_iter().enumerate() {
            library.index_pack(&pack)?;
            library.indexed_pack_count = index + 1;
            progress(format!(
                "Indexed texture pack {}/{}: {} ({} texture names)",
                index + 1,
                total,
                pack.display(),
                library.locators.len()
            ));
        }
        Ok(library)
    }

    fn configure_plants_with_progress<F>(
        &mut self,
        config: &Value,
        mut progress: F,
    ) -> RenderResult<()>
    where
        F: FnMut(String),
    {
        let Some(plant_config) = config
            .get("render_conf")
            .and_then(|value| value.get("plants_conf"))
        else {
            return Ok(());
        };
        let mapping = plant_texture_mapping(plant_config);
        let total = mapping.len();
        for (index, (name, textures)) in mapping.into_iter().enumerate() {
            let source_count = textures.len();
            progress(format!(
                "Preparing plant texture {}/{}: {} ({} source texture(s))",
                index + 1,
                total,
                name,
                source_count
            ));
            let mut composite = RgbaImage::new(384, 512);
            for (source_index, texture_name) in textures.into_iter().enumerate() {
                progress(format!(
                    "Loading plant source {}/{} for {}: {}",
                    source_index + 1,
                    source_count,
                    name,
                    texture_name
                ));
                if let Some(texture) = self.texture(&texture_name)? {
                    texture.composite_into(&mut composite, 192, 512);
                }
            }
            self.textures.insert(
                name,
                Texture {
                    width: composite.width,
                    height: composite.height,
                    offset_x: -192,
                    offset_y: -512,
                    pixels: composite.pixels,
                },
            );
        }
        Ok(())
    }

    fn cache_summary(&self) -> String {
        let cache_limit_mb = if self.decoded_page_cache_limit_bytes == 0 {
            DEFAULT_DECODED_PAGE_CACHE_BYTES / (1024 * 1024)
        } else {
            self.decoded_page_cache_limit_bytes / (1024 * 1024)
        };
        format!(
            "{} pack(s) indexed; {} pack read(s); {} PNG page(s) decoded; {} texture(s) cached; decoded page RAM cache {} MB",
            self.indexed_pack_count,
            self.pack_read_count,
            self.decoded_page_count,
            self.textures.len(),
            cache_limit_mb
        )
    }

    fn index_pack(&mut self, path: &Path) -> RenderResult<()> {
        let data = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let mut reader = Reader::new(&data);
        let version = if data.starts_with(b"PZPK") {
            reader.skip(4)?;
            reader.u32()?
        } else {
            0
        };
        let page_count = reader.u32()? as usize;
        for _ in 0..page_count {
            let _page_name = reader.bytes()?;
            let texture_count = reader.u32()? as usize;
            let _has_alpha = reader.u32()?;
            let mut records = Vec::with_capacity(texture_count);
            for _ in 0..texture_count {
                let name = String::from_utf8_lossy(&reader.bytes()?).trim().to_string();
                let x = reader.u32()? as usize;
                let y = reader.u32()? as usize;
                let width = reader.u32()? as usize;
                let height = reader.u32()? as usize;
                let mut offset_x = reader.i32()?;
                let mut offset_y = reader.i32()?;
                let origin_width = reader.i32()?;
                let origin_height = reader.i32()?;
                offset_x -= origin_width >> 1;
                offset_y -= origin_height;
                records.push((name, x, y, width, height, offset_x, offset_y));
            }
            let (png_offset, png_length) = if version == 0 {
                let marker = b"\xef\xbe\xad\xde";
                let relative = data[reader.pos..]
                    .windows(marker.len())
                    .position(|window| window == marker)
                    .ok_or_else(|| format!("{}: missing PZPK page marker", path.display()))?;
                let end = reader.pos + relative;
                let offset = reader.pos;
                reader.pos = end + marker.len();
                (offset, relative)
            } else {
                let length = reader.u32()? as usize;
                let offset = reader.pos;
                reader.skip(length)?;
                (offset, length)
            };
            for (name, x, y, width, height, offset_x, offset_y) in records {
                self.locators.insert(
                    name,
                    TextureLocator {
                        pack: path.to_path_buf(),
                        png_offset,
                        png_length,
                        x,
                        y,
                        width,
                        height,
                        offset_x,
                        offset_y,
                    },
                );
            }
        }
        Ok(())
    }

    fn texture(&mut self, name: &str) -> RenderResult<Option<&Texture>> {
        if !self.textures.contains_key(name) {
            if let Some(locator) = self.locators.get(name).cloned() {
                if !self.pack_data.contains_key(&locator.pack) {
                    let data = fs::read(&locator.pack)
                        .map_err(|error| format!("{}: {error}", locator.pack.display()))?;
                    self.pack_data.insert(locator.pack.clone(), data);
                    self.pack_read_count = self.pack_read_count.saturating_add(1);
                }
                let data = self.pack_data.get(&locator.pack).ok_or_else(|| {
                    format!(
                        "{}: texture pack cache is unavailable",
                        locator.pack.display()
                    )
                })?;
                let end = locator
                    .png_offset
                    .saturating_add(locator.png_length)
                    .min(data.len());
                let png = data.get(locator.png_offset..end).ok_or_else(|| {
                    format!("{}: invalid indexed texture page", locator.pack.display())
                })?;
                let page_key = TexturePageKey {
                    pack: locator.pack.clone(),
                    offset: locator.png_offset,
                    length: locator.png_length,
                };
                if !self.decoded_pages.contains_key(&page_key) {
                    let (pixels, width) = decode_png(png)?;
                    self.decoded_page_bytes = self.decoded_page_bytes.saturating_add(pixels.len());
                    self.decoded_pages
                        .insert(page_key.clone(), DecodedTexturePage { pixels, width });
                    self.decoded_page_order.push_back(page_key.clone());
                    if self.decoded_page_cache_limit_bytes == 0 {
                        self.decoded_page_cache_limit_bytes = DEFAULT_DECODED_PAGE_CACHE_BYTES;
                    }
                    self.evict_decoded_pages();
                    self.decoded_page_count = self.decoded_page_count.saturating_add(1);
                }
                if let Some(position) = self
                    .decoded_page_order
                    .iter()
                    .position(|key| key == &page_key)
                {
                    let key = self
                        .decoded_page_order
                        .remove(position)
                        .expect("page exists");
                    self.decoded_page_order.push_back(key);
                }
                let page = self
                    .decoded_pages
                    .get(&page_key)
                    .ok_or_else(|| "Decoded texture page cache is unavailable".to_string())?;
                let mut texture = Texture::crop(
                    &page.pixels,
                    page.width,
                    locator.x,
                    locator.y,
                    locator.width,
                    locator.height,
                );
                texture.offset_x += locator.offset_x;
                texture.offset_y += locator.offset_y;
                self.textures.insert(name.to_string(), texture);
            } else {
                for root in &self.raw_paths {
                    let path = root.join(format!("{name}.png"));
                    if !path.is_file() {
                        continue;
                    }
                    let data =
                        fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
                    let (pixels, width, height, offset_x, offset_y) =
                        decode_png_with_offsets(&data)?;
                    let mut texture = Texture::from_rgba(pixels, width, height);
                    texture.offset_x += offset_x;
                    texture.offset_y += offset_y;
                    self.textures.insert(name.to_string(), texture);
                    break;
                }
            }
        }
        Ok(self.textures.get(name))
    }
}

const TREE_DEFS: [(&str, bool); 11] = [
    ("americanholly", true),
    ("americanlinden", false),
    ("canadianhemlock", true),
    ("carolinasilverbell", false),
    ("cockspurhawthorn", false),
    ("dogwood", false),
    ("easternredbud", false),
    ("redmaple", false),
    ("riverbirch", false),
    ("virginiapine", true),
    ("yellowwood", false),
];

fn plant_texture_mapping(config: &Value) -> HashMap<String, Vec<String>> {
    let season = config
        .get("season")
        .and_then(Value::as_str)
        .unwrap_or("summer2");
    let snow = config.get("snow").and_then(Value::as_bool).unwrap_or(false);
    let flower = config
        .get("flower")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let large_bush = config
        .get("large_bush")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tree_size = config
        .get("tree_size")
        .and_then(Value::as_i64)
        .unwrap_or(2)
        .clamp(0, 3) as usize;
    let jumbo_size = config
        .get("jumbo_tree_size")
        .and_then(Value::as_i64)
        .unwrap_or(3)
        .clamp(0, 5) as usize;
    let jumbo_type = config
        .get("jumbo_tree_type")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 11) as usize;
    let no_ground_cover = config
        .get("no_ground_cover")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let unify_tree = config
        .get("unify_tree_type")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .clamp(0, 11) as usize;
    let mut mapping = HashMap::new();

    for i in 0..16 {
        let trunk = i % 8;
        let (offset1, offset2) = if large_bush { (8, 32) } else { (0, 0) };
        let mut textures = if snow {
            vec![format!("f_bushes_1_{}", trunk + offset1 + 16)]
        } else {
            let mut values = vec![format!("f_bushes_1_{}", trunk + offset1)];
            match season {
                "spring" => values.push(format!("f_bushes_1_{}", trunk + offset1 + 32)),
                "summer" | "summer2" => values.push(format!("f_bushes_1_{}", i + offset2 + 64)),
                "autumn" => values.push(format!("f_bushes_1_{}", trunk + offset1 + 48)),
                _ => {}
            }
            if flower {
                values.push(format!("f_bushes_1_{}", i + offset2 + 80));
            }
            values
        };
        if no_ground_cover {
            textures.clear();
        }
        mapping.insert(format!("vegetation_foliage_01_{i}"), textures);
    }

    for i in 0..48 {
        let textures = if no_ground_cover {
            Vec::new()
        } else {
            plant_grass_textures(i % 24, season, flower)
        };
        mapping.insert(format!("vegetation_groundcover_01_{i}"), textures);
    }

    let tree_textures = TREE_DEFS
        .iter()
        .map(|(name, evergreen)| tree_textures(name, season, snow, tree_size, *evergreen))
        .collect::<Vec<_>>();
    for i in 0..33 {
        let index = if unify_tree == 0 {
            i % tree_textures.len()
        } else {
            unify_tree - 1
        };
        mapping.insert(
            format!("vegetation_trees_01_{i}"),
            tree_textures[index].clone(),
        );
    }
    let jumbo_size = jumbo_size.max(tree_size);
    let (jumbo_name, jumbo_evergreen) = TREE_DEFS[jumbo_type - 1];
    let jumbo_index = if unify_tree == 0 {
        jumbo_type - 1
    } else {
        unify_tree - 1
    };
    let (jumbo_name, jumbo_evergreen) = if unify_tree == 0 {
        (jumbo_name, jumbo_evergreen)
    } else {
        TREE_DEFS[jumbo_index]
    };
    mapping.insert(
        "jumbo_tree_01_0".to_string(),
        tree_textures_for_size(jumbo_name, season, snow, jumbo_size, jumbo_evergreen),
    );
    mapping
}

fn plant_grass_textures(index: usize, season: &str, flower: bool) -> Vec<String> {
    let mut textures = Vec::new();
    let offset = (index / 8) * 16 + 16;
    let modulo = index % 8;
    match season {
        "spring" => textures.push(format!("d_plants_1_{modulo}")),
        "summer" | "summer2" => textures.push(format!("d_plants_1_{}", offset + modulo)),
        "autumn" => textures.push(format!("d_plants_1_{}", 8 + modulo)),
        _ => {}
    }
    if flower {
        textures.push(format!("d_plants_1_{}", offset + 8 + modulo));
    }
    textures
}

fn tree_textures(
    name: &str,
    season: &str,
    snow: bool,
    size: usize,
    evergreen: bool,
) -> Vec<String> {
    tree_textures_for_size(name, season, snow, size, evergreen)
}

fn tree_textures_for_size(
    name: &str,
    season: &str,
    snow: bool,
    size: usize,
    evergreen: bool,
) -> Vec<String> {
    let is_jumbo = size >= 4;
    let index = size % 4;
    let prefix = if is_jumbo {
        format!("e_{name}JUMBO_1_")
    } else {
        format!("e_{name}_1_")
    };
    let step = if is_jumbo { 2 } else { 4 };
    if snow {
        return vec![format!("{}{index_plus}", prefix, index_plus = index + step)];
    }
    let mut textures = vec![format!("{prefix}{index}")];
    if !evergreen {
        let offset = match season {
            "spring" => Some(step * 2),
            "summer" => Some(step * 3),
            "summer2" => Some(step * 4),
            "autumn" => Some(step * 5),
            _ => None,
        };
        if let Some(offset) = offset {
            textures.push(format!("{prefix}{}", index + offset));
        }
    }
    textures
}

fn decode_png(bytes: &[u8]) -> RenderResult<(Vec<u8>, usize)> {
    let (pixels, width, _, _, _) = decode_png_with_offsets(bytes)?;
    Ok((pixels, width))
}

fn decode_png_with_offsets(bytes: &[u8]) -> RenderResult<(Vec<u8>, usize, usize, i32, i32)> {
    let mut decoder = Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(Transformations::EXPAND | Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
    let offset = |keyword: &str| {
        reader
            .info()
            .uncompressed_latin1_text
            .iter()
            .find(|chunk| chunk.keyword == keyword)
            .and_then(|chunk| chunk.text.parse::<i32>().ok())
            .unwrap_or(0)
    };
    let offset_x = offset("ox");
    let offset_y = offset("oy");
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buffer)
        .map_err(|error| error.to_string())?;
    let raw = &buffer[..info.buffer_size()];
    let width = info.width as usize;
    let height = info.height as usize;
    let rgba = match info.color_type {
        ColorType::Rgba => raw.to_vec(),
        ColorType::Rgb => raw
            .chunks_exact(3)
            .flat_map(|pixel| [pixel[0], pixel[1], pixel[2], 255])
            .collect(),
        ColorType::Grayscale => raw
            .iter()
            .flat_map(|value| [*value, *value, *value, 255])
            .collect(),
        ColorType::GrayscaleAlpha => raw
            .chunks_exact(2)
            .flat_map(|pixel| [pixel[0], pixel[0], pixel[0], pixel[1]])
            .collect(),
        other => return Err(format!("Unsupported PZPK PNG color type: {other:?}")),
    };
    if rgba.len() != width * height * 4 {
        return Err("Decoded PZPK PNG has an invalid pixel buffer.".to_string());
    }
    Ok((rgba, width, height, offset_x, offset_y))
}

fn decode_map_text(bytes: &[u8], encoding: &str) -> String {
    let normalized = encoding
        .trim()
        .to_ascii_lowercase()
        .replace(['_', ' '], "-");
    let text = match normalized.as_str() {
        "cp1252" | "windows-1252" | "latin-1" | "latin1" => {
            WINDOWS_1252.decode(bytes).0.into_owned()
        }
        "euc-kr" | "euckr" => EUC_KR.decode(bytes).0.into_owned(),
        _ => String::from_utf8_lossy(bytes).into_owned(),
    };
    text.trim().to_string()
}

fn parse_header(path: &Path, x: i32, y: i32, encoding: &str) -> RenderResult<LotHeader> {
    let data = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let mut reader = Reader::new(&data);
    let version = if data.starts_with(b"LOTH") {
        reader.skip(4)?;
        reader.u32()?
    } else {
        reader.u32()?
    };
    let tiles = read_tile_names(&mut reader)?;
    if version == 0 {
        reader.skip(1)?;
    }
    let _width = reader.u32()?;
    let _height = reader.u32()?;
    let (min_layer, max_layer) = if version == 0 {
        clamped_layer_bounds(version, 0, reader.i32()?)
    } else {
        let raw_min = reader.i32()?;
        let raw_max = reader.i32()?;
        clamped_layer_bounds(version, raw_min, raw_max)
    };
    let rooms = read_rooms(&mut reader, encoding)?;
    skip_buildings(&mut reader)?;
    let cell_blocks = if version == 0 { 30 } else { 32 };
    let block_size = if version == 0 { 10 } else { 8 };
    let mut zpop = vec![vec![0; cell_blocks]; cell_blocks];
    for row in &mut zpop {
        for value in row {
            *value = reader.u8()?;
        }
    }
    Ok(LotHeader {
        x,
        y,
        version,
        cell_blocks,
        block_size,
        cell_size: (cell_blocks * block_size) as i32,
        min_layer: min_layer.max(if version == 0 { 0 } else { -32 }),
        max_layer: max_layer.min(if version == 0 { 8 } else { 32 }),
        tiles,
        rooms,
        zpop,
    })
}

fn read_tile_names(reader: &mut Reader<'_>) -> RenderResult<Vec<String>> {
    let count = reader.u32()? as usize;
    (0..count)
        .map(|_| Ok(String::from_utf8_lossy(&reader.line()?).trim().to_string()))
        .collect()
}

fn read_rooms(reader: &mut Reader<'_>, encoding: &str) -> RenderResult<Vec<Room>> {
    let count = reader.u32()? as usize;
    let mut rooms = Vec::with_capacity(count);
    for _ in 0..count {
        let name = decode_map_text(&reader.line()?, encoding);
        let layer = reader.i32()?;
        let rectangles = reader.u32()? as usize;
        let mut rects = Vec::with_capacity(rectangles);
        for _ in 0..rectangles {
            rects.push((reader.i32()?, reader.i32()?, reader.i32()?, reader.i32()?));
        }
        let metadata = reader.u32()? as usize;
        reader.skip(metadata * 12)?;
        rooms.push(Room { name, layer, rects });
    }
    Ok(rooms)
}

fn clamped_layer_bounds(version: u32, raw_min: i32, raw_max: i32) -> (i32, i32) {
    if version == 0 {
        (0, raw_max.min(8))
    } else {
        (raw_min.max(-32), raw_max.saturating_add(1).min(32))
    }
}

fn skip_buildings(reader: &mut Reader<'_>) -> RenderResult<()> {
    let count = reader.u32()? as usize;
    for _ in 0..count {
        let rooms = reader.u32()? as usize;
        reader.skip(rooms * 4)?;
    }
    Ok(())
}

fn load_cell(path: &Path, header: &LotHeader) -> RenderResult<Cell> {
    let lotpack = cell_source_path(path, header.x, header.y);
    let data = fs::read(&lotpack).map_err(|error| format!("{}: {error}", lotpack.display()))?;
    let mut reader = Reader::new(&data);
    let version = if data.starts_with(b"LOTP") {
        reader.skip(4)?;
        reader.u32()?
    } else {
        0
    };
    if version != header.version {
        return Err(format!(
            "Inconsistent map cell version for {}: header B{}, lotpack B{}.",
            lotpack.display(),
            if header.version == 0 { 41 } else { 42 },
            if version == 0 { 41 } else { 42 },
        ));
    }
    let block_count = reader.u32()? as usize;
    let table = reader.pos;
    let mut blocks = Vec::with_capacity(block_count);
    for index in 0..block_count {
        let mut table_reader = Reader::at(&data, table + index * 8);
        let offset = table_reader.u32()? as usize;
        let (block, _) = read_block(&data, offset, header)?;
        blocks.push(block);
    }
    let mut cell = Cell {
        tiles: HashMap::new(),
    };
    for block_x in 0..header.cell_blocks {
        for block_y in 0..header.cell_blocks {
            let block = blocks
                .get(block_x * header.cell_blocks + block_y)
                .ok_or_else(|| "Lotpack block table is incomplete.".to_string())?;
            for (layer_index, layer) in block.iter().enumerate() {
                for x in 0..header.block_size {
                    for y in 0..header.block_size {
                        let target_x = block_x * header.block_size + x;
                        let target_y = block_y * header.block_size + y;
                        if let Some(names) = layer
                            .get(x)
                            .and_then(|row| row.get(y))
                            .and_then(Option::as_ref)
                        {
                            let resolved = names
                                .iter()
                                .filter_map(|index| header.tiles.get(*index as usize).cloned())
                                .collect::<Vec<_>>();
                            let layer = header.min_layer + layer_index as i32;
                            cell.tiles.insert((layer, target_x, target_y), resolved);
                        }
                    }
                }
            }
        }
    }
    Ok(cell)
}

fn read_block(
    data: &[u8],
    offset: usize,
    header: &LotHeader,
) -> RenderResult<(Vec<Vec<Vec<Option<Vec<i32>>>>>, usize)> {
    let mut reader = Reader::at(data, offset);
    let layer_count = header.max_layer.saturating_sub(header.min_layer) as usize;
    let squares_per_layer = header.block_size * header.block_size;
    let mut skip = 0i32;
    let mut block = vec![vec![vec![None; header.block_size]; header.block_size]; layer_count];
    for layer_index in 0..layer_count {
        if skip >= squares_per_layer as i32 {
            skip -= squares_per_layer as i32;
            continue;
        }
        for x in 0..header.block_size {
            if skip >= header.block_size as i32 {
                skip -= header.block_size as i32;
                continue;
            }
            for y in 0..header.block_size {
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                let count = reader.i32()?;
                if count == -1 {
                    skip = reader.i32()?;
                    if skip > 0 {
                        skip -= 1;
                        continue;
                    }
                }
                if count > 1 {
                    let mut tiles = Vec::with_capacity(count as usize - 1);
                    for _ in 0..count - 1 {
                        tiles.push(reader.i32()?);
                    }
                    block[layer_index][x][y] = Some(tiles);
                }
            }
        }
    }
    Ok((block, reader.pos))
}

pub fn render_map_views(
    config: &Value,
    output_html: &Path,
    stop_path: &Path,
    mut emit: impl FnMut(f32, &str, &str),
) -> RenderResult<()> {
    let pz_root = filesystem_path(&config_string(config, "pz_root").unwrap_or_default());
    let map_name = config_string(config, "base_map").unwrap_or_else(|| "default".to_string());
    let effective_config = effective_render_config(config, &map_name, "base");
    let config = &effective_config;
    let base_top_config = effective_command_config(config, "base_top");
    let map_catalog = MapCatalog::load(config)?;
    let map_path = configured_map_path(config, &map_catalog, &map_name);
    let map_encoding = map_catalog.encoding(&map_name);
    let headers = scan_headers(&map_path, &map_encoding)?;
    if headers.is_empty() {
        return Err(format!(
            "No Project Zomboid map cells were found at {}. Set Project Zomboid root to a valid installation.",
            map_path.display()
        ));
    }
    let first = headers.values().next().expect("headers is not empty");
    let sample_build = config
        .get("sample_build")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let dzi_ranges = configured_cell_ranges(config, "dzi_cell_range")?;
    let render_ranges = configured_cell_ranges(config, "render_cell_range")?;
    let base_top_render_ranges = configured_cell_ranges(&base_top_config, "render_cell_range")?;
    let mut selected_entries = headers
        .iter()
        .filter(|((x, y), _)| sample_build || in_ranges(dzi_ranges.as_deref(), *x, *y))
        .map(|(coordinate, header)| (*coordinate, header.clone()))
        .collect::<Vec<_>>();
    if sample_build {
        selected_entries.sort_by_key(|((x, y), _)| (*x, *y));
        let sample_cells = config
            .get("sample_cells")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .clamp(1, 16) as usize;
        selected_entries.truncate(sample_cells);
    }
    let selected_headers = selected_entries.into_iter().collect::<HashMap<_, _>>();
    if selected_headers.is_empty() {
        return Err("No map cells matched the configured render range.".to_string());
    }
    let map_bounds = if sample_build {
        Some((
            selected_headers.keys().map(|(x, _)| *x).min(),
            selected_headers.keys().map(|(_, y)| *y).min(),
            selected_headers.keys().map(|(x, _)| *x).max(),
            selected_headers.keys().map(|(_, y)| *y).max(),
        ))
        .and_then(|(min_x, min_y, max_x, max_y)| Some((min_x?, min_y?, max_x?, max_y?)))
    } else {
        dzi_bounds(
            config,
            &map_catalog,
            &map_name,
            &map_path,
            &headers,
            dzi_ranges.as_deref(),
        )?
    }
    .ok_or_else(|| "Unable to determine map cell bounds.".to_string())?;
    let cell_rects = if sample_build {
        Vec::new()
    } else {
        dzi_cell_rects(
            config,
            &map_catalog,
            &map_name,
            &map_path,
            &headers,
            dzi_ranges.as_deref(),
        )?
    };
    let dependency_only = config
        .get("use_depend_texture_only")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let texture_sources = if sample_build {
        Vec::new()
    } else {
        map_catalog.texture_sources(
            config,
            &["default".to_string(), map_name.clone()],
            dependency_only,
        )
    };
    let texture_paths = if sample_build {
        Vec::new()
    } else if texture_sources.is_empty() {
        discover_texture_paths(config)
    } else {
        texture_sources
            .iter()
            .map(|source| source.path.clone())
            .collect::<Vec<_>>()
    };
    emit(62.0, "textures", "rust-pzmap2dzi textures --decode-pzpk");
    let mut textures = if sample_build {
        emit(
            62.0,
            "textures",
            "rust-pzmap2dzi textures --sample-skip-pack-decode",
        );
        TextureLibrary::default()
    } else if texture_sources.is_empty() {
        TextureLibrary::load_directories_with_progress(&texture_paths, |message| {
            emit(62.0, "textures", &message)
        })?
    } else {
        TextureLibrary::load_sources_with_progress(&texture_sources, |message| {
            emit(62.0, "textures", &message)
        })?
    };
    textures.configure_decoded_page_cache(config);
    textures.configure_plants_with_progress(config, |message| emit(62.0, "textures", &message))?;
    emit(
        63.0,
        "textures",
        &format!("Texture cache ready: {}", textures.cache_summary()),
    );
    ensure_not_stopped(stop_path)?;
    let mut cell_cache = CellCache::new(map_path.clone(), selected_headers.clone());
    let tile_size = if sample_build {
        4096
    } else {
        config_number(config, &["render_conf", "tile_size"])
            .unwrap_or(1024.0)
            .max(128.0) as usize
    };
    let top_square_size = config_number(config, &["render_conf", "top_view_square_size"])
        .unwrap_or(1.0)
        .max(1.0) as usize;
    let top_view_color_mode = config_string_nested(config, &["render_conf", "top_view_color_mode"])
        .unwrap_or("avg")
        .to_string();
    let tile_align_levels = config_number(config, &["render_conf", "tile_align_levels"])
        .unwrap_or(3.0)
        .max(1.0) as usize;
    let layer_range = if sample_build {
        first.min_layer..first.min_layer.saturating_add(1)
    } else {
        configured_layer_range(config, first.min_layer, first.max_layer)?
    };
    let base_top_layer_range = if sample_build {
        layer_range.clone()
    } else {
        configured_layer_range(&base_top_config, first.min_layer, first.max_layer)?
    };
    let geometry = Geometry::from_cell_bounds(
        map_bounds.0,
        map_bounds.1,
        map_bounds.2,
        map_bounds.3,
        first.cell_size,
        top_square_size,
        tile_size,
        tile_align_levels,
        layer_range.start,
        layer_range.end,
    );
    let base_top_tile_size = if sample_build {
        tile_size
    } else {
        config_number(&base_top_config, &["render_conf", "tile_size"])
            .unwrap_or(tile_size as f64)
            .max(128.0) as usize
    };
    let base_top_square_size =
        config_number(&base_top_config, &["render_conf", "top_view_square_size"])
            .unwrap_or(top_square_size as f64)
            .max(1.0) as usize;
    let base_top_tile_align_levels =
        config_number(&base_top_config, &["render_conf", "tile_align_levels"])
            .unwrap_or(tile_align_levels as f64)
            .max(1.0) as usize;
    let base_top_geometry = Geometry::from_cell_bounds(
        map_bounds.0,
        map_bounds.1,
        map_bounds.2,
        map_bounds.3,
        first.cell_size,
        base_top_square_size,
        base_top_tile_size,
        base_top_tile_align_levels,
        base_top_layer_range.start,
        base_top_layer_range.end,
    );
    let output_format =
        OutputFormat::from_name(config_string_nested(config, &["render_conf", "image_fmt"]));
    let image_save_options = ImageSaveOptions::from_config(config);
    let omit_levels = config_number(config, &["render_conf", "omit_levels"])
        .unwrap_or(0.0)
        .max(0.0) as usize;
    let base_layer0_format = OutputFormat::from_name(config_string_nested(
        config,
        &["render_conf", "image_fmt_base_layer0"],
    ));
    let base_top_output_format = OutputFormat::from_name(config_string_nested(
        &base_top_config,
        &["render_conf", "image_fmt"],
    ));
    let base_top_image_save_options = ImageSaveOptions::from_config(&base_top_config);
    let base_top_omit_levels = config_number(&base_top_config, &["render_conf", "omit_levels"])
        .unwrap_or(omit_levels as f64)
        .max(0.0) as usize;
    let base_top_color_mode =
        config_string_nested(&base_top_config, &["render_conf", "top_view_color_mode"])
            .unwrap_or(&top_view_color_mode)
            .to_string();
    let all_source_paths = source_paths(&map_path, &texture_paths);
    let texture_signature = if cache::enabled(config) {
        cache::signature(config, texture_source_paths(&texture_paths))
    } else {
        cache::disabled_signature().to_string()
    };
    let source_signature = if cache::enabled(config) {
        cache::signature(config, all_source_paths)
    } else {
        cache::disabled_signature().to_string()
    };
    let map_data_root = output_html.join("map_data");
    if sample_build {
        write_sample_overlay_metadata(&map_data_root)?;
        emit(
            63.0,
            "overlays",
            "rust-pzmap2dzi overlays --sample-skip-global-scans",
        );
    } else {
        overlays::generate(
            config,
            &map_path,
            pz_root.as_path(),
            &selected_headers,
            &map_data_root,
            &mut emit,
        )?;
    }
    let save_infos = {
        emit(63.7, "saves", "Scanning configured save games");
        let started = std::time::Instant::now();
        let infos = if sample_build {
            save_game::render_inventory(
                &sample_without_saves(config),
                output_html,
                None,
                &mut emit,
            )?
        } else {
            save_game::render_inventory(config, output_html, Some(first.version), &mut emit)?
        };
        emit(
            63.8,
            "saves",
            &format!(
                "Save inventory complete: {} compatible save(s) in {:.1}s",
                infos.len(),
                started.elapsed().as_secs_f64()
            ),
        );
        infos
    };
    if !sample_build {
        emit(63.9, "overlay_raster", "Starting raster overlay generation");
        overlay_raster::render(
            config,
            &map_path,
            pz_root.as_path(),
            &geometry,
            &selected_headers,
            &map_data_root,
            stop_path,
            tile_size,
            omit_levels,
            output_format,
            image_save_options,
            &cell_rects,
            &source_signature,
            &mut emit,
        )?;
        emit(64.0, "overlay_raster", "Raster overlays complete");
    }
    for layer in layer_range.clone() {
        emit(
            66.3,
            "render",
            &format!("Starting base isometric layer {layer}"),
        );
        let layer_format = if layer == 0 {
            base_layer0_format
        } else {
            output_format
        };
        if sample_build {
            render_sample_view(
                "base",
                layer,
                &geometry,
                &mut cell_cache,
                &mut textures,
                first,
                false,
                layer_format,
                image_save_options,
                &map_data_root,
            )?;
        } else {
            render_view(
                "base",
                config,
                layer,
                &geometry,
                &mut cell_cache,
                &mut textures,
                first,
                &map_path,
                stop_path,
                tile_size,
                false,
                omit_levels,
                &top_view_color_mode,
                layer_format,
                image_save_options,
                &map_data_root,
                &source_signature,
                &texture_signature,
                render_ranges.as_deref(),
                &cell_rects,
                layer_range.start,
                &mut emit,
            )?;
        }
    }
    textures.configure_plants_with_progress(&base_top_config, |message| {
        emit(68.0, "textures", &message)
    })?;
    emit(
        68.0,
        "textures",
        &format!(
            "Top-view texture configuration ready: {}",
            textures.cache_summary()
        ),
    );
    for layer in base_top_layer_range.clone() {
        emit(
            80.0,
            "render",
            &format!("Starting base top-view layer {layer}"),
        );
        ensure_not_stopped(stop_path)?;
        let layer_format = base_top_output_format;
        if sample_build {
            render_sample_view(
                "base_top",
                layer,
                &base_top_geometry,
                &mut cell_cache,
                &mut textures,
                first,
                true,
                layer_format,
                base_top_image_save_options,
                &map_data_root,
            )?;
        } else {
            render_view(
                "base_top",
                &base_top_config,
                layer,
                &base_top_geometry,
                &mut cell_cache,
                &mut textures,
                first,
                &map_path,
                stop_path,
                base_top_tile_size,
                true,
                base_top_omit_levels,
                &base_top_color_mode,
                layer_format,
                base_top_image_save_options,
                &map_data_root,
                &source_signature,
                &texture_signature,
                base_top_render_ranges.as_deref(),
                &cell_rects,
                base_top_layer_range.start,
                &mut emit,
            )?;
        }
    }
    emit(94.0, "save", "Rendering compatible save-game views");
    save_game::render_views(
        &save_infos,
        output_html,
        stop_path,
        &geometry,
        render_ranges.as_deref(),
        &cell_rects,
        &mut textures,
        &texture_paths,
        tile_size,
        omit_levels,
        layer_range,
        output_format,
        image_save_options,
        config,
        &mut emit,
    )?;
    for mod_map in configured_additional_map_names(config)
        .into_iter()
        .filter(|_| !sample_build)
    {
        ensure_not_stopped(stop_path)?;
        emit(
            96.0,
            "additional_maps",
            &format!("Starting additional map {mod_map}"),
        );
        render_mod_map(
            config,
            &map_catalog,
            &mod_map,
            output_html,
            stop_path,
            &mut emit,
        )?;
        emit(
            99.0,
            "additional_maps",
            &format!("Completed additional map {mod_map}"),
        );
    }
    if !sample_build {
        write_rendered_map_list(output_html, "mod_maps")?;
    }
    Ok(())
}

/// Validate the selected base map before the worker enters the expensive
/// texture/render stages. The full renderer repeats this scan as part of its
/// normal setup, so this is deliberately limited to the cheap header pass.
pub(crate) fn preflight_map_sources(config: &Value) -> RenderResult<usize> {
    let map_name = config_string(config, "base_map").unwrap_or_else(|| "default".to_string());
    let effective_config = effective_render_config(config, &map_name, "base");
    let catalog = MapCatalog::load(&effective_config)?;
    let map_path = configured_map_path(&effective_config, &catalog, &map_name);
    let encoding = catalog.encoding(&map_name);
    let headers = scan_headers(&map_path, &encoding)?;
    if headers.is_empty() {
        return Err(format!(
            "No Project Zomboid map cells were found at {}.",
            map_path.display()
        ));
    }
    Ok(headers.len())
}

#[allow(clippy::too_many_arguments)]
fn render_mod_map(
    config: &Value,
    map_catalog: &MapCatalog,
    map_name: &str,
    output_html: &Path,
    stop_path: &Path,
    emit: &mut impl FnMut(f32, &str, &str),
) -> RenderResult<()> {
    let effective_config = effective_render_config(config, map_name, "base");
    let config = &effective_config;
    let pz_root = filesystem_path(&config_string(config, "pz_root").unwrap_or_default());
    let base_top_config = effective_command_config(config, "base_top");
    let map_path = configured_map_path(config, map_catalog, map_name);
    let map_encoding = map_catalog.encoding(map_name);
    let headers = scan_headers(&map_path, &map_encoding)?;
    if headers.is_empty() {
        return Err(format!(
            "No map cells were found for mod map {map_name:?} at {}.",
            map_path.display()
        ));
    }
    let first = headers.values().next().expect("headers is not empty");
    let dzi_ranges = configured_cell_ranges(config, "dzi_cell_range")?;
    let render_ranges = configured_cell_ranges(config, "render_cell_range")?;
    let base_top_render_ranges = configured_cell_ranges(&base_top_config, "render_cell_range")?;
    let bounds = dzi_bounds(
        config,
        map_catalog,
        map_name,
        &map_path,
        &headers,
        dzi_ranges.as_deref(),
    )?
    .ok_or_else(|| format!("Unable to determine bounds for mod map {map_name:?}."))?;
    let cell_rects = dzi_cell_rects(
        config,
        map_catalog,
        map_name,
        &map_path,
        &headers,
        dzi_ranges.as_deref(),
    )?;
    let selected_headers = headers
        .iter()
        .filter(|((x, y), _)| in_ranges(dzi_ranges.as_deref(), *x, *y))
        .map(|(coordinate, header)| (*coordinate, header.clone()))
        .collect::<HashMap<_, _>>();
    let dependency_only = config
        .get("use_depend_texture_only")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tile_size = config_number(config, &["render_conf", "tile_size"])
        .unwrap_or(1024.0)
        .max(128.0) as usize;
    let top_square_size = config_number(config, &["render_conf", "top_view_square_size"])
        .unwrap_or(1.0)
        .max(1.0) as usize;
    let tile_align_levels = config_number(config, &["render_conf", "tile_align_levels"])
        .unwrap_or(3.0)
        .max(1.0) as usize;
    let top_view_color_mode = config_string_nested(config, &["render_conf", "top_view_color_mode"])
        .unwrap_or("avg")
        .to_string();
    let output_format =
        OutputFormat::from_name(config_string_nested(config, &["render_conf", "image_fmt"]));
    let omit_levels = config_number(config, &["render_conf", "omit_levels"])
        .unwrap_or(0.0)
        .max(0.0) as usize;
    let image_save_options = ImageSaveOptions::from_config(config);
    let texture_sources = map_catalog.texture_sources(
        config,
        &["default".to_string(), map_name.to_string()],
        dependency_only,
    );
    let texture_paths = if texture_sources.is_empty() {
        discover_texture_paths(config)
    } else {
        texture_sources
            .iter()
            .map(|source| source.path.clone())
            .collect::<Vec<_>>()
    };
    let mut textures = if texture_sources.is_empty() {
        TextureLibrary::load_directories_with_progress(&texture_paths, |message| {
            emit(62.0, "textures", &message)
        })?
    } else {
        TextureLibrary::load_sources_with_progress(&texture_sources, |message| {
            emit(62.0, "textures", &message)
        })?
    };
    textures.configure_decoded_page_cache(config);
    textures.configure_plants_with_progress(config, |message| emit(62.0, "textures", &message))?;
    emit(
        63.0,
        "textures",
        &format!("Texture cache ready: {}", textures.cache_summary()),
    );
    let mut cell_cache = CellCache::new(map_path.clone(), selected_headers.clone());
    let layer_range = configured_layer_range(config, first.min_layer, first.max_layer)?;
    let geometry = Geometry::from_cell_bounds(
        bounds.0,
        bounds.1,
        bounds.2,
        bounds.3,
        first.cell_size,
        top_square_size,
        tile_size,
        tile_align_levels,
        layer_range.start,
        layer_range.end,
    );
    let base_top_layer_range =
        configured_layer_range(&base_top_config, first.min_layer, first.max_layer)?;
    let base_top_tile_size = config_number(&base_top_config, &["render_conf", "tile_size"])
        .unwrap_or(tile_size as f64)
        .max(128.0) as usize;
    let base_top_square_size =
        config_number(&base_top_config, &["render_conf", "top_view_square_size"])
            .unwrap_or(top_square_size as f64)
            .max(1.0) as usize;
    let base_top_tile_align_levels =
        config_number(&base_top_config, &["render_conf", "tile_align_levels"])
            .unwrap_or(tile_align_levels as f64)
            .max(1.0) as usize;
    let base_top_geometry = Geometry::from_cell_bounds(
        bounds.0,
        bounds.1,
        bounds.2,
        bounds.3,
        first.cell_size,
        base_top_square_size,
        base_top_tile_size,
        base_top_tile_align_levels,
        base_top_layer_range.start,
        base_top_layer_range.end,
    );
    let base_top_output_format = OutputFormat::from_name(config_string_nested(
        &base_top_config,
        &["render_conf", "image_fmt"],
    ));
    let base_top_image_save_options = ImageSaveOptions::from_config(&base_top_config);
    let base_top_omit_levels = config_number(&base_top_config, &["render_conf", "omit_levels"])
        .unwrap_or(omit_levels as f64)
        .max(0.0) as usize;
    let base_top_color_mode =
        config_string_nested(&base_top_config, &["render_conf", "top_view_color_mode"])
            .unwrap_or(&top_view_color_mode)
            .to_string();
    let source_signature = if cache::enabled(config) {
        cache::signature(config, source_paths(&map_path, &texture_paths))
    } else {
        cache::disabled_signature().to_string()
    };
    let texture_signature = if cache::enabled(config) {
        cache::signature(config, texture_source_paths(&texture_paths))
    } else {
        cache::disabled_signature().to_string()
    };
    let map_data_root = output_html
        .join("map_data/mod_maps")
        .join(sanitize_map_component(map_name));
    overlays::generate(
        config,
        &map_path,
        pz_root.as_path(),
        &selected_headers,
        &map_data_root,
        emit,
    )?;
    overlay_raster::render(
        config,
        &map_path,
        pz_root.as_path(),
        &geometry,
        &selected_headers,
        &map_data_root,
        stop_path,
        tile_size,
        omit_levels,
        output_format,
        image_save_options,
        &cell_rects,
        &source_signature,
        emit,
    )?;
    for layer in layer_range.clone() {
        let layer_format = output_format;
        render_view(
            "base",
            config,
            layer,
            &geometry,
            &mut cell_cache,
            &mut textures,
            first,
            &map_path,
            stop_path,
            tile_size,
            false,
            omit_levels,
            &top_view_color_mode,
            layer_format,
            image_save_options,
            &map_data_root,
            &source_signature,
            &texture_signature,
            render_ranges.as_deref(),
            &cell_rects,
            layer_range.start,
            emit,
        )?;
    }
    textures.configure_plants_with_progress(&base_top_config, |message| {
        emit(68.0, "textures", &message)
    })?;
    emit(
        68.0,
        "textures",
        &format!(
            "Top-view texture configuration ready: {}",
            textures.cache_summary()
        ),
    );
    for layer in base_top_layer_range.clone() {
        let layer_format = base_top_output_format;
        render_view(
            "base_top",
            &base_top_config,
            layer,
            &base_top_geometry,
            &mut cell_cache,
            &mut textures,
            first,
            &map_path,
            stop_path,
            base_top_tile_size,
            true,
            base_top_omit_levels,
            &base_top_color_mode,
            layer_format,
            base_top_image_save_options,
            &map_data_root,
            &source_signature,
            &texture_signature,
            base_top_render_ranges.as_deref(),
            &cell_rects,
            base_top_layer_range.start,
            emit,
        )?;
    }
    Ok(())
}

fn sanitize_map_component(name: &str) -> String {
    sanitize_component(name)
}

fn dzi_cell_rects(
    config: &Value,
    catalog: &MapCatalog,
    current_name: &str,
    current_path: &Path,
    current_headers: &HashMap<(i32, i32), LotHeader>,
    configured: Option<&[CellRect]>,
) -> RenderResult<Vec<CellRect>> {
    if let Some(configured) = configured {
        return Ok(configured.to_vec());
    }
    let mut cells = current_headers.keys().copied().collect::<Vec<_>>();
    if uses_all_mod_map_bounds(config) {
        let mut names =
            vec![config_string(config, "base_map").unwrap_or_else(|| "default".to_string())];
        names.extend(configured_additional_map_names(config));
        names.sort();
        names.dedup();
        for name in names {
            let path = configured_map_path(config, catalog, &name);
            if name == current_name || path == current_path {
                continue;
            }
            cells.extend(
                scan_headers(&path, &catalog.encoding(&name))?
                    .keys()
                    .copied(),
            );
        }
    }
    Ok(rect_cover(&cells))
}

fn rect_cover(cells: &[(i32, i32)]) -> Vec<CellRect> {
    let mut sorted = cells.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut columns = Vec::<(i32, Vec<(i32, i32)>)>::new();
    for (x, y) in sorted {
        if columns.last().is_none_or(|(last_x, _)| *last_x != x) {
            columns.push((x, Vec::new()));
        }
        let runs = &mut columns.last_mut().expect("column was just added").1;
        if let Some((start, length)) = runs.last_mut()
            && *start + *length == y
        {
            *length += 1;
        } else {
            runs.push((y, 1));
        }
    }
    let mut rectangles = Vec::new();
    let mut previous_x = None;
    let mut previous_runs = Vec::<(i32, i32)>::new();
    let mut width = 0;
    for (x, runs) in columns {
        if previous_x == Some(x - 1) && runs == previous_runs {
            width += 1;
            previous_x = Some(x);
            continue;
        }
        if width > 0 {
            for &(y, height) in &previous_runs {
                rectangles.push(CellRect {
                    x: previous_x.expect("previous column") - width + 1,
                    y,
                    width,
                    height,
                });
            }
        }
        previous_x = Some(x);
        previous_runs = runs;
        width = 1;
    }
    if width > 0 {
        for &(y, height) in &previous_runs {
            rectangles.push(CellRect {
                x: previous_x.expect("previous column") - width + 1,
                y,
                width,
                height,
            });
        }
    }
    rectangles
}

fn sanitize_component(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "_".to_string()
    } else {
        sanitized
    }
}

fn write_rendered_map_list(output_html: &Path, folder: &str) -> RenderResult<()> {
    let directory = output_html.join("map_data").join(folder);
    if !directory.is_dir() {
        return Ok(());
    }
    let mut names = fs::read_dir(&directory)
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect::<Vec<_>>();
    names.sort();
    fs::write(
        directory.join("map_list.json"),
        serde_json::to_vec(&names).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn source_paths(map_path: &Path, texture_paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    collect_source_paths(map_path, &mut paths);
    paths.extend(texture_source_paths(texture_paths));
    paths
}

fn texture_source_paths(texture_paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for root in texture_paths {
        collect_source_paths(root, &mut paths);
    }
    paths
}

fn cell_source_path(map_path: &Path, x: i32, y: i32) -> PathBuf {
    map_path.join(format!("world_{x}_{y}.lotpack"))
}

fn header_source_path(map_path: &Path, x: i32, y: i32) -> PathBuf {
    map_path.join(format!("world_{x}_{y}.lotheader"))
}

fn resolve_map_path(config: &Value, map_folder: &str) -> PathBuf {
    let pz_root = filesystem_path(&config_string(config, "pz_root").unwrap_or_default());
    let mut candidates = vec![pz_root.join("media/maps").join(map_folder)];
    for key in ["custom_root", "mod_root"] {
        if let Some(root) = config_string(config, key) {
            candidates.push(filesystem_path(&root).join("media/maps").join(map_folder));
        }
    }
    if let Some(found) = candidates.iter().find(|path| path.is_dir()) {
        return found.clone();
    }

    // Workshop mods commonly nest the map below <workshop>/id/mods/name.
    // Walk only directories and return the first deterministic match.
    for key in ["custom_root", "mod_root"] {
        let Some(root) = config_string(config, key) else {
            continue;
        };
        let mut matches = WalkDir::new(filesystem_path(&root))
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_dir())
            .filter_map(|entry| {
                let path = entry.into_path();
                (path.file_name().and_then(|name| name.to_str()) == Some(map_folder)
                    && path.parent().is_some_and(|parent| {
                        parent.file_name().is_some_and(|name| name == "maps")
                    }))
                .then_some(path)
            })
            .collect::<Vec<_>>();
        matches.sort();
        if let Some(found) = matches.into_iter().next() {
            return found;
        }
    }
    candidates.remove(0)
}

fn map_folder_for_name(name: &str) -> String {
    if name.eq_ignore_ascii_case("default") {
        "Muldraugh, KY".to_string()
    } else {
        name.to_string()
    }
}

fn configured_map_path(config: &Value, catalog: &MapCatalog, name: &str) -> PathBuf {
    configured_custom_map_path(config, name)
        .or_else(|| catalog.map_path(config, name))
        .unwrap_or_else(|| resolve_map_path(config, &map_folder_for_name(name)))
}

fn header_bounds(headers: &HashMap<(i32, i32), LotHeader>) -> Option<(i32, i32, i32, i32)> {
    Some((
        headers.keys().map(|(x, _)| *x).min()?,
        headers.keys().map(|(_, y)| *y).min()?,
        headers.keys().map(|(x, _)| *x).max()?,
        headers.keys().map(|(_, y)| *y).max()?,
    ))
}

fn extend_bounds(
    bounds: &mut Option<(i32, i32, i32, i32)>,
    additional: Option<(i32, i32, i32, i32)>,
) {
    let Some((min_x, min_y, max_x, max_y)) = additional else {
        return;
    };
    if let Some(current) = bounds {
        current.0 = current.0.min(min_x);
        current.1 = current.1.min(min_y);
        current.2 = current.2.max(max_x);
        current.3 = current.3.max(max_y);
    } else {
        *bounds = Some((min_x, min_y, max_x, max_y));
    }
}

fn uses_all_mod_map_bounds(config: &Value) -> bool {
    nested_value(config, &["render_conf", "dzi_cell_range"])
        .and_then(Value::as_str)
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("all_mod_maps"))
}

fn dzi_bounds(
    config: &Value,
    catalog: &MapCatalog,
    current_name: &str,
    current_path: &Path,
    current_headers: &HashMap<(i32, i32), LotHeader>,
    configured_ranges: Option<&[CellRect]>,
) -> RenderResult<Option<(i32, i32, i32, i32)>> {
    if let Some(ranges) = configured_ranges {
        return Ok(range_bounds(ranges));
    }

    let mut bounds = header_bounds(current_headers);
    if !uses_all_mod_map_bounds(config) {
        return Ok(bounds);
    }

    let mut names =
        vec![config_string(config, "base_map").unwrap_or_else(|| "default".to_string())];
    names.extend(configured_additional_map_names(config));
    names.sort();
    names.dedup();

    for name in names {
        let path = configured_map_path(config, catalog, &name);
        if name == current_name || path == current_path {
            extend_bounds(&mut bounds, header_bounds(current_headers));
            continue;
        }
        let headers = scan_headers(&path, &catalog.encoding(&name))?;
        extend_bounds(&mut bounds, header_bounds(&headers));
    }
    Ok(bounds)
}

fn discover_texture_paths(config: &Value) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(pz_root) = config_string(config, "pz_root") {
        roots.push(filesystem_path(&pz_root).join("media/texturepacks"));
    }
    for key in ["custom_root", "mod_root"] {
        let Some(root) = config_string(config, key) else {
            continue;
        };
        let mut found = WalkDir::new(filesystem_path(&root))
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_dir())
            .filter_map(|entry| {
                let path = entry.into_path();
                (path.file_name().and_then(|name| name.to_str()) == Some("texturepacks"))
                    .then_some(path)
            })
            .collect::<Vec<_>>();
        found.sort();
        roots.extend(found);
    }
    let mut unique = Vec::with_capacity(roots.len());
    for root in roots {
        if !unique.contains(&root) {
            unique.push(root);
        }
    }
    roots = unique;
    roots
}

fn collect_source_paths(path: &Path, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let child = entry.path();
        paths.push(child.clone());
        if child.is_dir() {
            collect_source_paths(&child, paths);
        }
    }
}

fn scan_headers(path: &Path, encoding: &str) -> RenderResult<HashMap<(i32, i32), LotHeader>> {
    let mut headers = HashMap::new();
    for entry in fs::read_dir(path).map_err(|error| format!("{}: {error}", path.display()))? {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path
            .extension()
            .is_none_or(|extension| extension != "lotheader")
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let Some((x, y)) = stem
            .split_once('_')
            .and_then(|(x, y)| Some((x.parse().ok()?, y.parse().ok()?)))
        else {
            continue;
        };
        headers.insert((x, y), parse_header(&path, x, y, encoding)?);
    }
    Ok(headers)
}

pub(crate) struct Geometry {
    pub(crate) min_x: i32,
    pub(crate) min_y: i32,
    pub(crate) min_cell_x: i32,
    pub(crate) min_cell_y: i32,
    pub(crate) cell_size: i32,
    pub(crate) iso_width: usize,
    pub(crate) iso_height: usize,
    pub(crate) top_width: usize,
    pub(crate) top_height: usize,
    pub(crate) top_square_size: usize,
    source_min_cell_x: i32,
    source_min_cell_y: i32,
    source_max_cell_x: i32,
    source_max_cell_y: i32,
    output_min_layer: i32,
    output_max_layer: i32,
}

impl Geometry {
    pub(crate) fn with_layout(&self, tile_size: usize, tile_align_levels: usize) -> Self {
        Self::from_cell_bounds(
            self.source_min_cell_x,
            self.source_min_cell_y,
            self.source_max_cell_x,
            self.source_max_cell_y,
            self.cell_size,
            self.top_square_size,
            tile_size,
            tile_align_levels,
            self.output_min_layer,
            self.output_max_layer,
        )
    }
}

pub(crate) fn map_info_origin(geometry: &Geometry, top_view: bool) -> (i32, i32) {
    if top_view {
        let scale = geometry.top_square_size as i32;
        (
            geometry
                .min_cell_x
                .saturating_mul(geometry.cell_size)
                .saturating_mul(scale)
                .saturating_neg(),
            geometry
                .min_cell_y
                .saturating_mul(geometry.cell_size)
                .saturating_mul(scale)
                .saturating_neg(),
        )
    } else {
        (
            geometry
                .min_x
                .saturating_mul(ISO_GRID_WIDTH)
                .saturating_neg(),
            geometry
                .min_y
                .saturating_add(1)
                .saturating_mul(ISO_GRID_HEIGHT)
                .saturating_neg(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CellRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

impl CellRect {
    fn contains(self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

impl Geometry {
    fn from_cell_bounds(
        min_cell_x: i32,
        min_cell_y: i32,
        max_cell_x: i32,
        max_cell_y: i32,
        cell_size: i32,
        top_square_size: usize,
        tile_size: usize,
        tile_align_levels: usize,
        min_layer: i32,
        max_layer: i32,
    ) -> Self {
        let align_tiles = 1_i32
            .checked_shl(tile_align_levels.saturating_sub(1).min(30) as u32)
            .unwrap_or(1);
        let aligned_min_cell_x = align_down(min_cell_x, align_tiles);
        let aligned_min_cell_y = align_down(min_cell_y, align_tiles);
        let raw_sx0 = min_cell_x * cell_size;
        let raw_sy0 = min_cell_y * cell_size;
        let sx1 = (max_cell_x + 1) * cell_size - 1;
        let sy1 = (max_cell_y + 1) * cell_size - 1;
        let mut raw_min_x = raw_sx0 - sy1;
        let mut raw_min_y = raw_sx0 + raw_sy0;
        let mut max_x = sx1 - raw_sy0;
        let mut max_y = sx1 + sy1;
        // Match IsoDZI's output margin for the largest (jumbo-tree) texture.
        raw_min_x -= 3;
        max_x += 3;
        raw_min_y -= 15;
        max_y += 1;
        if max_layer > 1 {
            raw_min_y -= (max_layer * 6).max(0);
        }
        if min_layer < 0 {
            max_y += (-min_layer * 6).max(0);
        }
        let grid_per_tile_x = (tile_size as i32 / ISO_GRID_WIDTH).max(1);
        let grid_per_tile_y = (tile_size as i32 / ISO_GRID_HEIGHT).max(1);
        let min_x = align_down(raw_min_x, grid_per_tile_x * align_tiles);
        let min_y = align_down(raw_min_y, grid_per_tile_y * align_tiles);
        Self {
            min_x,
            min_y,
            min_cell_x: aligned_min_cell_x,
            min_cell_y: aligned_min_cell_y,
            cell_size,
            iso_width: ((max_x - min_x) * ISO_GRID_WIDTH).max(1) as usize,
            iso_height: ((max_y - min_y) * ISO_GRID_HEIGHT).max(1) as usize,
            top_width: ((max_cell_x - aligned_min_cell_x + 1) * cell_size) as usize
                * top_square_size,
            top_height: ((max_cell_y - aligned_min_cell_y + 1) * cell_size) as usize
                * top_square_size,
            top_square_size,
            source_min_cell_x: min_cell_x,
            source_min_cell_y: min_cell_y,
            source_max_cell_x: max_cell_x,
            source_max_cell_y: max_cell_y,
            output_min_layer: min_layer,
            output_max_layer: max_layer,
        }
    }
}

fn align_down(value: i32, alignment: i32) -> i32 {
    value.div_euclid(alignment.max(1)) * alignment.max(1)
}

fn empty_tile_path(path: &Path) -> PathBuf {
    path.with_extension("rust-empty")
}

fn public_empty_tile_path(path: &Path) -> PathBuf {
    path.with_extension("empty")
}

fn is_empty_tile(path: &Path) -> bool {
    empty_tile_path(path).is_file() || public_empty_tile_path(path).is_file()
}

pub(crate) fn tile_output_exists(path: &Path) -> bool {
    path.is_file() || is_empty_tile(path)
}

fn read_tile_for_composite(
    base: &Path,
    layer: i32,
    level: usize,
    tile_x: usize,
    tile_y: usize,
    preferred: OutputFormat,
) -> RenderResult<Option<RgbaImage>> {
    let candidates = [
        preferred,
        OutputFormat::Png,
        OutputFormat::Webp,
        OutputFormat::Jpeg,
    ];
    for format in candidates {
        let path = base.join(format!(
            "layer{layer}_files/{level}/{tile_x}_{tile_y}.{}",
            format.extension()
        ));
        if path.is_file() && !is_empty_tile(&path) {
            return Ok(Some(RgbaImage::read(&path)?));
        }
    }
    Ok(None)
}

pub(crate) fn composite_lower_layers(
    base: &Path,
    image: &mut RgbaImage,
    layer: i32,
    min_layer: i32,
    level: usize,
    tile_x: usize,
    tile_y: usize,
    format: OutputFormat,
) -> RenderResult<()> {
    if format != OutputFormat::Jpeg {
        return Ok(());
    }
    for lower_layer in min_layer..layer {
        if let Some(lower) =
            read_tile_for_composite(base, lower_layer, level, tile_x, tile_y, format)?
        {
            image.alpha_composite(&lower);
        }
    }
    Ok(())
}

pub(crate) fn write_optional_tile(
    image: &RgbaImage,
    path: &Path,
    format: OutputFormat,
    image_save_options: ImageSaveOptions,
    public_empty: bool,
) -> RenderResult<bool> {
    let empty_path = empty_tile_path(path);
    let public_empty_path = public_empty_tile_path(path);
    if image.is_empty() {
        if path.is_file() {
            fs::remove_file(path).map_err(|error| error.to_string())?;
        }
        if let Some(parent) = empty_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::write(empty_path, []).map_err(|error| error.to_string())?;
        if image_save_options.save_empty_tile && public_empty {
            fs::write(public_empty_path, []).map_err(|error| error.to_string())?;
        } else if public_empty_path.is_file() {
            fs::remove_file(public_empty_path).map_err(|error| error.to_string())?;
        }
        return Ok(false);
    }
    if empty_path.is_file() {
        fs::remove_file(empty_path).map_err(|error| error.to_string())?;
    }
    if public_empty_path.is_file() {
        fs::remove_file(public_empty_path).map_err(|error| error.to_string())?;
    }
    image.write(path, format, image_save_options)?;
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn render_sample_view(
    view: &str,
    layer: i32,
    geometry: &Geometry,
    cells: &mut CellCache,
    textures: &mut TextureLibrary,
    header: &LotHeader,
    top_view: bool,
    output_format: OutputFormat,
    image_save_options: ImageSaveOptions,
    map_data_root: &Path,
) -> RenderResult<()> {
    const SAMPLE_SIZE: usize = 256;
    let base = map_data_root.join(view);
    let level_path = base.join(format!("layer{layer}_files/0"));
    fs::create_dir_all(&level_path).map_err(|error| error.to_string())?;
    let mut image = RgbaImage::new(SAMPLE_SIZE, SAMPLE_SIZE);
    if top_view {
        render_top_tile(
            &mut image,
            0,
            0,
            SAMPLE_SIZE,
            geometry,
            cells,
            textures,
            header,
            layer,
            "avg",
            None,
        )?;
    } else {
        render_iso_tile(
            &mut image,
            0,
            0,
            SAMPLE_SIZE,
            geometry,
            cells,
            textures,
            header,
            layer,
            None,
        )?;
    }
    write_optional_tile(
        &image,
        &level_path.join(format!("0_0.{}", output_format.extension())),
        output_format,
        image_save_options,
        layer == 0,
    )?;
    let dzi = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Image TileSize=\"{SAMPLE_SIZE}\" Overlap=\"0\" Format=\"{}\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"{SAMPLE_SIZE}\" Height=\"{SAMPLE_SIZE}\"/></Image>",
        output_format.dzi_name()
    );
    fs::write(base.join(format!("layer{layer}.dzi")), dzi).map_err(|error| error.to_string())?;
    fs::write(
        base.join("map_info.json"),
        serde_json::to_vec_pretty(&json!({
            "w": SAMPLE_SIZE,
            "h": SAMPLE_SIZE,
            "skip": 0,
            "x0": map_info_origin(&geometry, top_view).0,
            "y0": map_info_origin(&geometry, top_view).1,
            "sqr": if top_view { geometry.top_square_size } else { ISO_SQUARE_WIDTH as usize },
            "cell_size": geometry.cell_size,
            "block_size": header.block_size,
            "minlayer": header.min_layer,
            "maxlayer": header.max_layer,
            "pz_version": if header.version == 0 { "B41" } else { "B42" },
            "pzmap2dzi_version": "rust-pzmap2dzi",
            "cell_rects": [],
            "renderer": "pzmap2dzi-rust-sample"
        }))
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[allow(clippy::too_many_arguments)]
fn render_view(
    view: &str,
    config: &Value,
    layer: i32,
    geometry: &Geometry,
    cells: &mut CellCache,
    textures: &mut TextureLibrary,
    header: &LotHeader,
    map_path: &Path,
    stop_path: &Path,
    tile_size: usize,
    top_view: bool,
    omit_levels: usize,
    top_view_color_mode: &str,
    output_format: OutputFormat,
    image_save_options: ImageSaveOptions,
    map_data_root: &Path,
    source_signature: &str,
    texture_signature: &str,
    render_ranges: Option<&[CellRect]>,
    cell_rects: &[CellRect],
    render_min_layer: i32,
    emit: &mut impl FnMut(f32, &str, &str),
) -> RenderResult<()> {
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
    let levels = pyramid_levels(width.max(1), height.max(1));
    let visible_levels = retained_pyramid_levels(&levels, omit_levels);
    let max_level = levels.len() - 1;
    let visible_width = visible_levels.last().map(|(w, _)| *w).unwrap_or(width);
    let visible_height = visible_levels.last().map(|(_, h)| *h).unwrap_or(height);
    let base = map_data_root.join(view);
    let map_info = json!({
        "w": visible_width,
        "h": visible_height,
        "skip": omit_levels,
        "x0": map_info_origin(&geometry, top_view).0,
        "y0": map_info_origin(&geometry, top_view).1,
        "sqr": if top_view { geometry.top_square_size } else { ISO_SQUARE_WIDTH as usize },
        "cell_size": geometry.cell_size,
        "block_size": header.block_size,
        "minlayer": header.min_layer,
        "maxlayer": header.max_layer,
        "pz_version": if header.version == 0 { "B41" } else { "B42" },
        "pzmap2dzi_version": "rust-pzmap2dzi",
        "cell_rects": cell_rects.iter().map(|range| json!([
            range.x, range.y, range.width, range.height
        ])).collect::<Vec<_>>(),
        "renderer": "pzmap2dzi-rust"
    });
    ensure_map_info_compatible(&base, &map_info)?;
    let view_signature = cache::scoped_signature(config, source_signature);
    let cache_path = base.join(format!("layer{layer}.rust-cache"));
    if cache::is_current(&cache_path, &view_signature)
        && pyramid_outputs_exist(&base, layer, visible_levels, tile_size, output_format)
    {
        emit(
            65.0,
            "cache",
            &format!("rust-pzmap2dzi cache hit {view} layer {layer}"),
        );
        return Ok(());
    }
    fs::create_dir_all(base.join(format!("layer{layer}_files/{max_level}")))
        .map_err(|error| error.to_string())?;
    let tiles_x = width.div_ceil(tile_size);
    let tiles_y = height.div_ceil(tile_size);
    let total = (tiles_x * tiles_y).max(1);
    for tile_y in 0..tiles_y {
        for tile_x in 0..tiles_x {
            ensure_not_stopped(stop_path)?;
            let tile_number = tile_y * tiles_x + tile_x + 1;
            emit(
                65.0 + (tile_number as f32 / total as f32) * if top_view { 30.0 } else { 15.0 },
                "render",
                &format!("Processing {view} tile {tile_number}/{total} at {tile_x},{tile_y}"),
            );
            let tile_width = tile_size.min(width.saturating_sub(tile_x * tile_size));
            let tile_height = tile_size.min(height.saturating_sub(tile_y * tile_size));
            let tile_coordinates = if top_view {
                top_tile_cells(
                    tile_x,
                    tile_y,
                    tile_size,
                    geometry,
                    header,
                    tile_width,
                    tile_height,
                    &cells.coordinates,
                )
            } else {
                iso_tile_cells(
                    tile_x,
                    tile_y,
                    tile_size,
                    geometry,
                    header,
                    tile_width,
                    tile_height,
                    &cells.coordinates,
                    layer,
                )
            };
            let tile_coordinates = tile_coordinates
                .into_iter()
                .filter(|(x, y)| in_ranges(render_ranges, *x, *y))
                .collect::<Vec<_>>();
            let tile_sources = tile_coordinates
                .iter()
                .flat_map(|(x, y)| {
                    [
                        header_source_path(map_path, *x, *y),
                        cell_source_path(map_path, *x, *y),
                    ]
                })
                .collect::<Vec<_>>();
            let tile_signature =
                cache::signature_with_base(config, texture_signature, tile_sources);
            let tile_output = base.join(format!(
                "layer{layer}_files/{max_level}/{tile_x}_{tile_y}.{}",
                output_format.extension()
            ));
            let tile_cache = tile_output.with_extension("rust-cache");
            if cache::is_current(&tile_cache, &tile_signature) && tile_output_exists(&tile_output) {
                let complete = tile_y * tiles_x + tile_x + 1;
                emit(
                    65.0 + (complete as f32 / total as f32) * if top_view { 30.0 } else { 15.0 },
                    "cache",
                    &format!("rust-pzmap2dzi tile cache hit {view} {tile_x},{tile_y}"),
                );
                continue;
            }
            let mut image = RgbaImage::new(tile_width.max(1), tile_height.max(1));
            if top_view {
                render_top_tile(
                    &mut image,
                    tile_x,
                    tile_y,
                    tile_size,
                    geometry,
                    cells,
                    textures,
                    header,
                    layer,
                    top_view_color_mode,
                    render_ranges,
                )?;
            } else {
                render_iso_tile(
                    &mut image,
                    tile_x,
                    tile_y,
                    tile_size,
                    geometry,
                    cells,
                    textures,
                    header,
                    layer,
                    render_ranges,
                )?;
            }
            composite_lower_layers(
                &base,
                &mut image,
                layer,
                render_min_layer,
                max_level,
                tile_x,
                tile_y,
                output_format,
            )?;
            write_optional_tile(
                &image,
                &tile_output,
                output_format,
                image_save_options,
                layer == 0,
            )?;
            cache::write(&tile_cache, &tile_signature)?;
            let complete = tile_y * tiles_x + tile_x + 1;
            emit(
                65.0 + (complete as f32 / total as f32) * if top_view { 30.0 } else { 15.0 },
                "render",
                &format!("rust-pzmap2dzi render {view} tile {complete}/{total}"),
            );
        }
    }
    let pyramid_progress_start = if top_view { 95.0 } else { 80.0 };
    let (pyramid_workers, _, pyramid_memory_budget) = pyramid_worker_count(tile_size);
    let pyramid_backend = configured_pyramid_backend(config);
    emit(
        pyramid_progress_start,
        "pyramid",
        &format!(
            "Building {view} layer {layer} Deep Zoom pyramid: {} source level(s); {} CPU workers; {} MB RAM budget; backend={}",
            max_level,
            pyramid_workers,
            pyramid_memory_budget / (1024 * 1024),
            pyramid_backend.label()
        ),
    );
    let pyramid_started = Instant::now();
    let mut last_pyramid_report = Instant::now();
    build_pyramid_with_progress(
        stop_path,
        &base,
        layer,
        &levels,
        tile_size,
        output_format,
        image_save_options,
        &view_signature,
        configured_pyramid_cache_limit_mb(config),
        pyramid_backend,
        |level, level_complete, level_total, complete, total| {
            ensure_not_stopped(stop_path)?;
            if level_complete == 1
                || level_complete == level_total
                || last_pyramid_report.elapsed().as_secs() >= 5
            {
                let fraction = complete as f32 / total.max(1) as f32;
                emit(
                    pyramid_progress_start + fraction,
                    "pyramid",
                    &format!(
                        "Building {view} layer {layer} pyramid: level {level}/{max_level} tile {level_complete}/{level_total} ({complete}/{total}), elapsed {:.1}s",
                        pyramid_started.elapsed().as_secs_f64()
                    ),
                );
                last_pyramid_report = Instant::now();
            }
            Ok(())
        },
    )?;
    emit(
        pyramid_progress_start + 1.0,
        "pyramid",
        &format!("Completed {view} layer {layer} Deep Zoom pyramid"),
    );
    prune_pyramid_levels(&base, layer, levels.len(), visible_levels.len())?;
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
    cache::write(&cache_path, &view_signature)
}

fn pyramid_outputs_exist(
    base: &Path,
    layer: i32,
    levels: &[(usize, usize)],
    tile_size: usize,
    format: OutputFormat,
) -> bool {
    for (level, (width, height)) in levels.iter().enumerate() {
        let tiles_x = width.div_ceil(tile_size);
        let tiles_y = height.div_ceil(tile_size);
        for tile_y in 0..tiles_y {
            for tile_x in 0..tiles_x {
                let path = base.join(format!(
                    "layer{layer}_files/{}/{tile_x}_{tile_y}.{}",
                    level,
                    format.extension()
                ));
                if !tile_output_exists(&path) {
                    return false;
                }
            }
        }
    }
    true
}

pub(crate) fn ensure_map_info_compatible(base: &Path, new_info: &Value) -> RenderResult<()> {
    let path = base.join("map_info.json");
    if !path.is_file() {
        return Ok(());
    }
    let old_info: Value = serde_json::from_slice(
        &fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?,
    )
    .map_err(|error| format!("{}: invalid map_info.json: {error}", path.display()))?;
    for key in ["w", "h", "skip", "x0", "y0", "sqr"] {
        if old_info.get(key) != new_info.get(key) {
            return Err(format!(
                "Render output geometry changed for {} (field {key:?}); use a new output path or remove the existing output.",
                base.display()
            ));
        }
    }
    Ok(())
}

fn retained_pyramid_levels(levels: &[(usize, usize)], omit_levels: usize) -> &[(usize, usize)] {
    let count = levels.len().saturating_sub(omit_levels).max(1);
    &levels[..count]
}

fn prune_pyramid_levels(
    base: &Path,
    layer: i32,
    full_level_count: usize,
    retained_level_count: usize,
) -> RenderResult<()> {
    for level in retained_level_count..full_level_count {
        let path = base.join(format!("layer{layer}_files/{level}"));
        if path.is_dir() {
            fs::remove_dir_all(path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct PyramidTileKey {
    level: usize,
    x: usize,
    y: usize,
}

struct PyramidImageCache {
    images: HashMap<PyramidTileKey, Arc<RgbaImage>>,
    order: VecDeque<PyramidTileKey>,
    bytes: usize,
    max_bytes: usize,
}

impl PyramidImageCache {
    fn new(max_bytes: usize) -> Self {
        Self {
            images: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            max_bytes,
        }
    }

    fn take(&mut self, key: PyramidTileKey) -> Option<Arc<RgbaImage>> {
        let image = self.images.remove(&key)?;
        self.order.retain(|entry| *entry != key);
        self.bytes = self.bytes.saturating_sub(image.pixels.len());
        Some(image)
    }

    fn insert(&mut self, key: PyramidTileKey, image: RgbaImage) {
        if self.max_bytes == 0 {
            return;
        }
        let image_bytes = image.pixels.len();
        if image_bytes > self.max_bytes {
            return;
        }
        if let Some(previous) = self.images.remove(&key) {
            self.order.retain(|entry| *entry != key);
            self.bytes = self.bytes.saturating_sub(previous.pixels.len());
        }
        while self.bytes.saturating_add(image_bytes) > self.max_bytes {
            let Some(oldest_key) = self.order.pop_front() else {
                break;
            };
            if let Some(oldest) = self.images.remove(&oldest_key) {
                self.bytes = self.bytes.saturating_sub(oldest.pixels.len());
            }
        }
        self.bytes = self.bytes.saturating_add(image_bytes);
        self.images.insert(key, Arc::new(image));
        self.order.push_back(key);
    }
}

struct PyramidWorkQueue {
    state: Mutex<PyramidWorkQueueState>,
    wake: Condvar,
}

struct PyramidWorkQueueState {
    queue: VecDeque<PyramidTileKey>,
    closed: bool,
}

impl PyramidWorkQueue {
    fn new(initial: VecDeque<PyramidTileKey>) -> Self {
        Self {
            state: Mutex::new(PyramidWorkQueueState {
                queue: initial,
                closed: false,
            }),
            wake: Condvar::new(),
        }
    }

    fn push(&self, key: PyramidTileKey) {
        let mut state = self.state.lock().expect("pyramid work queue lock");
        if state.closed {
            return;
        }
        state.queue.push_back(key);
        self.wake.notify_one();
    }

    fn pop(&self) -> Option<PyramidTileKey> {
        let mut state = self.state.lock().expect("pyramid work queue lock");
        loop {
            if let Some(key) = state.queue.pop_front() {
                return Some(key);
            }
            if state.closed {
                return None;
            }
            state = self.wake.wait(state).expect("pyramid work queue wait");
        }
    }

    fn close(&self) {
        let mut state = self.state.lock().expect("pyramid work queue lock");
        state.closed = true;
        self.wake.notify_all();
    }
}

fn compose_pyramid_source(
    base: &Path,
    layer: i32,
    level: usize,
    tile_x: usize,
    tile_y: usize,
    tile_size: usize,
    width: usize,
    height: usize,
    child_width: usize,
    child_height: usize,
    format: OutputFormat,
    child_cache: Option<&Arc<Mutex<PyramidImageCache>>>,
) -> RenderResult<RgbaImage> {
    let parent_width = tile_size
        .min(width.saturating_sub(tile_x * tile_size))
        .max(1);
    let parent_height = tile_size
        .min(height.saturating_sub(tile_y * tile_size))
        .max(1);
    let source_width = (parent_width * 2)
        .min(child_width.saturating_sub(tile_x * tile_size * 2))
        .max(1);
    let source_height = (parent_height * 2)
        .min(child_height.saturating_sub(tile_y * tile_size * 2))
        .max(1);
    let mut source = RgbaImage::new(source_width, source_height);
    for child_y in 0..2 {
        for child_x in 0..2 {
            let child_tile_x = tile_x * 2 + child_x;
            let child_tile_y = tile_y * 2 + child_y;
            let child_path = base.join(format!(
                "layer{layer}_files/{}/{child_tile_x}_{child_tile_y}.{}",
                level + 1,
                format.extension()
            ));
            let child_key = PyramidTileKey {
                level: level + 1,
                x: child_tile_x,
                y: child_tile_y,
            };
            let child = if let Some(cached) =
                child_cache.and_then(|cache| cache.lock().ok()?.take(child_key))
            {
                cached
            } else {
                if !tile_output_exists(&child_path) || is_empty_tile(&child_path) {
                    continue;
                }
                Arc::new(RgbaImage::read(&child_path)?)
            };
            let offset_x = child_x * tile_size;
            let offset_y = child_y * tile_size;
            let copy_width = child.width.min(source.width.saturating_sub(offset_x));
            let copy_height = child.height.min(source.height.saturating_sub(offset_y));
            for row in 0..copy_height {
                let source_start = (row * child.width) * 4;
                let target_start = ((offset_y + row) * source.width + offset_x) * 4;
                let byte_count = copy_width * 4;
                source.pixels[target_start..target_start + byte_count]
                    .copy_from_slice(&child.pixels[source_start..source_start + byte_count]);
            }
        }
    }
    Ok(source)
}

pub(crate) fn build_pyramid_with_progress<F>(
    stop_path: &Path,
    base: &Path,
    layer: i32,
    levels: &[(usize, usize)],
    tile_size: usize,
    format: OutputFormat,
    image_save_options: ImageSaveOptions,
    pyramid_signature: &str,
    cache_limit_mb: usize,
    backend: PyramidBackend,
    mut progress: F,
) -> RenderResult<()>
where
    F: FnMut(usize, usize, usize, usize, usize) -> RenderResult<()>,
{
    let max_level = levels.len() - 1;
    let total_tiles = levels[..max_level]
        .iter()
        .map(|(width, height)| width.div_ceil(tile_size) * height.div_ceil(tile_size))
        .sum::<usize>()
        .max(1);
    let (worker_count, _, _) = pyramid_worker_count(tile_size);
    // The current WGPU implementation performs a synchronous readback for every
    // tile. That makes it a serial pipeline even when all CPU workers are
    // available, and is slower than the parallel CPU path for the large 1024px
    // tiles used by the Python renderer. Keep Auto on the established parallel
    // CPU path; GPU remains available as an explicit opt-in until it has a
    // batched readback path.
    let gpu = match backend {
        PyramidBackend::Cpu | PyramidBackend::Auto => None,
        PyramidBackend::Gpu => match gpu_pyramid::GpuPyramid::shared() {
            Ok(gpu) => Some(gpu),
            Err(error) => return Err(error),
        },
    };
    if backend == PyramidBackend::Auto {
        eprintln!(
            "GPU pyramid auto mode uses the parallel CPU path; GPU readback is synchronous per tile"
        );
    }
    if let Some(gpu) = gpu.as_ref() {
        eprintln!("WGPU pyramid adapter active: {}", gpu.adapter_name());
    }
    let stop_path = stop_path.to_path_buf();
    let pyramid_signature = pyramid_signature.to_string();
    if gpu.is_none() {
        return build_cpu_pyramid_with_progress(
            &stop_path,
            base,
            layer,
            levels,
            tile_size,
            format,
            image_save_options,
            &pyramid_signature,
            worker_count,
            cache_limit_mb,
            progress,
        );
    }
    let mut complete_tiles = 0;
    for level in (0..max_level).rev() {
        let (width, height) = levels[level];
        let (child_width, child_height) = levels[level + 1];
        let tiles_x = width.div_ceil(tile_size);
        let tiles_y = height.div_ceil(tile_size);
        let level_total = (tiles_x * tiles_y).max(1);
        fs::create_dir_all(base.join(format!("layer{layer}_files/{level}")))
            .map_err(|error| error.to_string())?;
        let tile_coordinates = (0..tiles_y)
            .flat_map(|tile_y| (0..tiles_x).map(move |tile_x| (tile_x, tile_y)))
            .collect::<Vec<_>>();
        let base_path = base.to_path_buf();
        let stop_path_for_worker = stop_path.clone();
        let signature_for_worker = pyramid_signature.clone();
        let gpu_context = gpu
            .as_ref()
            .expect("CPU pyramid path returns before the GPU loop");
        let mut level_complete = 0;
        for &(tile_x, tile_y) in &tile_coordinates {
            ensure_not_stopped(&stop_path_for_worker)?;
            let tile_output = base_path.join(format!(
                "layer{layer}_files/{level}/{tile_x}_{tile_y}.{}",
                format.extension()
            ));
            let tile_cache = tile_output.with_extension("pyramid-cache");
            let tile_signature =
                format!("{signature_for_worker}:pyramid:{level}:{tile_x}:{tile_y}");
            level_complete += 1;
            if cache::is_current(&tile_cache, &tile_signature) && tile_output_exists(&tile_output) {
                progress(
                    level,
                    level_complete,
                    level_total,
                    complete_tiles + level_complete,
                    total_tiles,
                )?;
                continue;
            }
            let source = compose_pyramid_source(
                &base_path,
                layer,
                level,
                tile_x,
                tile_y,
                tile_size,
                width,
                height,
                child_width,
                child_height,
                format,
                None,
            )?;
            let parent = gpu_context.downsample(
                &source,
                source.width.div_ceil(2),
                source.height.div_ceil(2),
            )?;
            write_optional_tile(
                &parent,
                &tile_output,
                format,
                image_save_options,
                layer == 0,
            )?;
            cache::write(&tile_cache, &tile_signature)?;
            progress(
                level,
                level_complete,
                level_total,
                complete_tiles + level_complete,
                total_tiles,
            )?;
        }
        complete_tiles += level_total;
    }
    Ok(())
}

fn pyramid_morton_key(x: usize, y: usize) -> u64 {
    let mut key = 0_u64;
    for bit in 0..32 {
        key |= ((x as u64 >> bit) & 1) << (bit * 2);
        key |= ((y as u64 >> bit) & 1) << (bit * 2 + 1);
    }
    key
}

fn pyramid_children(key: PyramidTileKey) -> [PyramidTileKey; 4] {
    [
        PyramidTileKey {
            level: key.level + 1,
            x: key.x * 2,
            y: key.y * 2,
        },
        PyramidTileKey {
            level: key.level + 1,
            x: key.x * 2 + 1,
            y: key.y * 2,
        },
        PyramidTileKey {
            level: key.level + 1,
            x: key.x * 2,
            y: key.y * 2 + 1,
        },
        PyramidTileKey {
            level: key.level + 1,
            x: key.x * 2 + 1,
            y: key.y * 2 + 1,
        },
    ]
}

fn render_cpu_pyramid_tile(
    stop_path: &Path,
    base: &Path,
    layer: i32,
    levels: &[(usize, usize)],
    tile_size: usize,
    format: OutputFormat,
    image_save_options: ImageSaveOptions,
    pyramid_signature: &str,
    key: PyramidTileKey,
    image_cache: &Arc<Mutex<PyramidImageCache>>,
    resizer: &mut fast_image_resize::Resizer,
    resize_options: &fast_image_resize::ResizeOptions,
) -> RenderResult<()> {
    ensure_not_stopped(stop_path)?;
    let (width, height) = levels[key.level];
    let (child_width, child_height) = levels[key.level + 1];
    let tile_output = base.join(format!(
        "layer{layer}_files/{}/{}_{}.{}",
        key.level,
        key.x,
        key.y,
        format.extension()
    ));
    let tile_cache = tile_output.with_extension("pyramid-cache");
    let tile_signature = format!(
        "{pyramid_signature}:pyramid:{}:{}:{}",
        key.level, key.x, key.y
    );
    let source = compose_pyramid_source(
        base,
        layer,
        key.level,
        key.x,
        key.y,
        tile_size,
        width,
        height,
        child_width,
        child_height,
        format,
        Some(image_cache),
    )?;
    let parent = source.downsample_2x_with(resizer, resize_options)?;
    write_optional_tile(
        &parent,
        &tile_output,
        format,
        image_save_options,
        layer == 0,
    )?;
    cache::write(&tile_cache, &tile_signature)?;
    image_cache
        .lock()
        .map_err(|_| "Pyramid image cache lock was poisoned.".to_string())?
        .insert(key, parent);
    Ok(())
}

fn build_cpu_pyramid_with_progress<F>(
    stop_path: &Path,
    base: &Path,
    layer: i32,
    levels: &[(usize, usize)],
    tile_size: usize,
    format: OutputFormat,
    image_save_options: ImageSaveOptions,
    pyramid_signature: &str,
    worker_count: usize,
    cache_limit_mb: usize,
    mut progress: F,
) -> RenderResult<()>
where
    F: FnMut(usize, usize, usize, usize, usize) -> RenderResult<()>,
{
    let max_level = levels.len().saturating_sub(1);
    if max_level == 0 {
        return Ok(());
    }
    let total_tiles = levels[..max_level]
        .iter()
        .map(|(width, height)| width.div_ceil(tile_size) * height.div_ceil(tile_size))
        .sum::<usize>()
        .max(1);
    let mut level_totals = vec![0_usize; max_level];
    let mut level_completed = vec![0_usize; max_level];
    let mut completed = HashSet::new();
    let mut pending_tasks = Vec::new();

    for level in 0..max_level {
        let (width, height) = levels[level];
        let tiles_x = width.div_ceil(tile_size);
        let tiles_y = height.div_ceil(tile_size);
        let level_total = (tiles_x * tiles_y).max(1);
        level_totals[level] = level_total;
        fs::create_dir_all(base.join(format!("layer{layer}_files/{level}")))
            .map_err(|error| error.to_string())?;
        let mut coordinates = (0..tiles_y)
            .flat_map(|tile_y| (0..tiles_x).map(move |tile_x| (tile_x, tile_y)))
            .collect::<Vec<_>>();
        coordinates.sort_unstable_by_key(|&(x, y)| pyramid_morton_key(x, y));
        for (x, y) in coordinates {
            let key = PyramidTileKey { level, x, y };
            let tile_output = base.join(format!(
                "layer{layer}_files/{level}/{x}_{y}.{}",
                format.extension()
            ));
            let tile_cache = tile_output.with_extension("pyramid-cache");
            let tile_signature = format!("{pyramid_signature}:pyramid:{level}:{x}:{y}");
            if cache::is_current(&tile_cache, &tile_signature) && tile_output_exists(&tile_output) {
                completed.insert(key);
                level_completed[level] += 1;
            } else {
                pending_tasks.push(key);
            }
        }
    }

    if pending_tasks.is_empty() {
        let level = max_level - 1;
        progress(
            level,
            level_completed[level],
            level_totals[level],
            completed.len(),
            total_tiles,
        )?;
        return Ok(());
    }

    let mut dependencies = HashMap::<PyramidTileKey, usize>::new();
    let mut parents = HashMap::<PyramidTileKey, Vec<PyramidTileKey>>::new();
    for key in pending_tasks.iter().copied() {
        let mut count = 0;
        for child in pyramid_children(key) {
            if child.level < max_level && !completed.contains(&child) {
                count += 1;
                parents.entry(child).or_default().push(key);
            }
        }
        dependencies.insert(key, count);
    }
    let mut ready = pending_tasks
        .iter()
        .copied()
        .filter(|key| dependencies.get(key) == Some(&0))
        .collect::<Vec<_>>();
    ready.sort_unstable_by_key(|key| {
        (
            std::cmp::Reverse(key.level),
            pyramid_morton_key(key.x, key.y),
        )
    });
    if ready.is_empty() && !pending_tasks.is_empty() {
        return Err("Pyramid dependency graph did not produce a ready tile.".to_string());
    }

    let image_cache = Arc::new(Mutex::new(PyramidImageCache::new(
        cache_limit_mb.saturating_mul(1024 * 1024),
    )));
    let work_queue = Arc::new(PyramidWorkQueue::new(ready.into_iter().collect()));
    let (sender, receiver) = std::sync::mpsc::channel();
    let pending_count = pending_tasks.len();
    let mut completed_total = completed.len();
    let stop_path = stop_path.to_path_buf();
    let base = base.to_path_buf();
    let pyramid_signature = pyramid_signature.to_string();
    let result = std::thread::scope(|scope| {
        for _ in 0..worker_count.max(1) {
            let work_queue = Arc::clone(&work_queue);
            let image_cache = Arc::clone(&image_cache);
            let sender = sender.clone();
            let stop_path = stop_path.clone();
            let base = base.clone();
            let pyramid_signature = pyramid_signature.clone();
            scope.spawn(move || {
                let mut resizer = fast_image_resize::Resizer::new();
                let resize_options = fast_image_resize::ResizeOptions::new()
                    .resize_alg(fast_image_resize::ResizeAlg::Convolution(
                        fast_image_resize::FilterType::Lanczos3,
                    ))
                    .use_alpha(true);
                while let Some(key) = work_queue.pop() {
                    let result = render_cpu_pyramid_tile(
                        &stop_path,
                        &base,
                        layer,
                        levels,
                        tile_size,
                        format,
                        image_save_options,
                        &pyramid_signature,
                        key,
                        &image_cache,
                        &mut resizer,
                        &resize_options,
                    );
                    if sender.send((key, result)).is_err() {
                        break;
                    }
                }
            });
        }
        drop(sender);

        let mut remaining = pending_count;
        let mut first_error = None;
        while remaining > 0 && first_error.is_none() {
            let (key, tile_result) = receiver
                .recv()
                .map_err(|error| format!("Pyramid worker channel closed: {error}"))?;
            remaining -= 1;
            if let Err(error) = tile_result {
                first_error = Some(error);
                work_queue.close();
                break;
            }
            completed_total += 1;
            level_completed[key.level] += 1;
            if let Err(error) = progress(
                key.level,
                level_completed[key.level],
                level_totals[key.level],
                completed_total,
                total_tiles,
            ) {
                first_error = Some(error);
                work_queue.close();
                break;
            }
            if let Some(parent_keys) = parents.get(&key) {
                for parent in parent_keys {
                    let dependency_count = dependencies
                        .get_mut(parent)
                        .expect("pyramid parent dependency exists");
                    *dependency_count -= 1;
                    if *dependency_count == 0 {
                        work_queue.push(*parent);
                    }
                }
            }
        }
        if first_error.is_some() {
            work_queue.close();
            while receiver.recv().is_ok() {}
            return Err(first_error.expect("pyramid error exists"));
        }
        work_queue.close();
        Ok(())
    });
    result
}

pub(crate) fn pyramid_worker_count(tile_size: usize) -> (usize, u64, u64) {
    const MEMORY_BUDGET_PERCENT: u64 = 75;
    let cpu_workers = rayon::current_num_threads().max(1);
    let mut system = System::new();
    system.refresh_memory();
    let available_memory = system.available_memory();
    let memory_budget = available_memory.saturating_mul(MEMORY_BUDGET_PERCENT) / 100;
    // A pyramid worker holds a 2x source image, decoded child data, and a
    // resized parent image. This deliberately overestimates peak use to avoid
    // turning large 8192px tiles into an out-of-memory event.
    let memory_per_worker = (tile_size as u64)
        .saturating_mul(tile_size as u64)
        .saturating_mul(32)
        .max(64 * 1024 * 1024);
    let memory_workers = if memory_budget == 0 {
        cpu_workers
    } else {
        (memory_budget / memory_per_worker).max(1) as usize
    };
    (
        cpu_workers.min(memory_workers).max(1),
        memory_per_worker,
        memory_budget,
    )
}

fn iso_tile_cells(
    tile_x: usize,
    tile_y: usize,
    tile_size: usize,
    geometry: &Geometry,
    header: &LotHeader,
    image_width: usize,
    image_height: usize,
    coordinates: &[(i32, i32)],
    layer: i32,
) -> Vec<(i32, i32)> {
    let offset_x = tile_x as i32 * tile_size as i32;
    let offset_y = tile_y as i32 * tile_size as i32;
    coordinates
        .iter()
        .copied()
        .filter(|(cell_x, cell_y)| {
            let square_min_x = cell_x * header.cell_size - (cell_y + header.cell_size - 1);
            let square_max_x = cell_x * header.cell_size + header.cell_size - 1 - cell_y;
            let square_min_y = cell_x + cell_y;
            let square_max_y = cell_x + cell_y + 2 * (header.cell_size - 1);
            let layer_offset = layer.saturating_mul(6) * ISO_GRID_HEIGHT;
            let screen_min_x = (square_min_x - geometry.min_x) * ISO_GRID_WIDTH - offset_x;
            let screen_max_x = (square_max_x - geometry.min_x) * ISO_GRID_WIDTH - offset_x;
            let screen_min_y = (square_min_y - geometry.min_y) * ISO_GRID_HEIGHT
                + ISO_SQUARE_HEIGHT / 2
                + layer_offset
                - offset_y;
            let screen_max_y = (square_max_y - geometry.min_y) * ISO_GRID_HEIGHT
                + ISO_SQUARE_HEIGHT / 2
                + layer_offset
                - offset_y;
            !(screen_max_x < -512
                || screen_max_y < -512
                || screen_min_x >= image_width as i32 + 512
                || screen_min_y >= image_height as i32 + 512)
        })
        .collect()
}

fn top_tile_cells(
    tile_x: usize,
    tile_y: usize,
    tile_size: usize,
    geometry: &Geometry,
    header: &LotHeader,
    image_width: usize,
    image_height: usize,
    coordinates: &[(i32, i32)],
) -> Vec<(i32, i32)> {
    let offset_x = (tile_x * tile_size) as i32;
    let offset_y = (tile_y * tile_size) as i32;
    coordinates
        .iter()
        .copied()
        .filter(|(cell_x, cell_y)| {
            let cell_left =
                (cell_x - geometry.min_cell_x) * header.cell_size * geometry.top_square_size as i32;
            let cell_top =
                (cell_y - geometry.min_cell_y) * header.cell_size * geometry.top_square_size as i32;
            let cell_width = header.cell_size * geometry.top_square_size as i32;
            !(cell_left >= offset_x + image_width as i32
                || cell_top >= offset_y + image_height as i32
                || cell_left + cell_width <= offset_x
                || cell_top + cell_width <= offset_y)
        })
        .collect()
}

fn render_iso_tile(
    image: &mut RgbaImage,
    tile_x: usize,
    tile_y: usize,
    tile_size: usize,
    geometry: &Geometry,
    cells: &mut CellCache,
    textures: &mut TextureLibrary,
    header: &LotHeader,
    layer: i32,
    render_ranges: Option<&[CellRect]>,
) -> RenderResult<()> {
    let tile_size = tile_size as i32;
    let offset_x = tile_x as i32 * tile_size;
    let offset_y = tile_y as i32 * tile_size;
    let coordinates = iso_tile_cells(
        tile_x,
        tile_y,
        tile_size as usize,
        geometry,
        header,
        image.width,
        image.height,
        &cells.coordinates,
        layer,
    )
    .into_iter()
    .filter(|(x, y)| in_ranges(render_ranges, *x, *y))
    .collect::<Vec<_>>();
    for (cell_x, cell_y) in coordinates {
        let Some(cell) = cells.get((cell_x, cell_y))? else {
            continue;
        };
        for sub_x in 0..header.cell_size as usize {
            for sub_y in 0..header.cell_size as usize {
                let square_x = cell_x * header.cell_size + sub_x as i32;
                let square_y = cell_y * header.cell_size + sub_y as i32;
                let grid_x = square_x - square_y;
                let grid_y = square_x + square_y;
                let screen_x = (grid_x - geometry.min_x) * ISO_GRID_WIDTH - offset_x;
                let screen_y = (grid_y - geometry.min_y) * ISO_GRID_HEIGHT
                    + ISO_SQUARE_HEIGHT / 2
                    + layer.saturating_mul(6) * ISO_GRID_HEIGHT
                    - offset_y;
                if screen_x < -512
                    || screen_y < -512
                    || screen_x >= image.width as i32 + 512
                    || screen_y >= image.height as i32 + 512
                {
                    continue;
                }
                let Some(tile_names) = cell.tile_names(sub_x, sub_y, layer) else {
                    continue;
                };
                for name in tile_names {
                    if let Some(texture) = textures.texture(name)? {
                        texture.composite_into(image, screen_x, screen_y);
                    }
                }
            }
        }
    }
    Ok(())
}

fn render_top_tile(
    image: &mut RgbaImage,
    tile_x: usize,
    tile_y: usize,
    tile_size: usize,
    geometry: &Geometry,
    cells: &mut CellCache,
    textures: &mut TextureLibrary,
    header: &LotHeader,
    layer: i32,
    color_mode: &str,
    render_ranges: Option<&[CellRect]>,
) -> RenderResult<()> {
    let offset_x = tile_x * tile_size;
    let offset_y = tile_y * tile_size;
    let coordinates = top_tile_cells(
        tile_x,
        tile_y,
        tile_size,
        geometry,
        header,
        image.width,
        image.height,
        &cells.coordinates,
    )
    .into_iter()
    .filter(|(x, y)| in_ranges(render_ranges, *x, *y))
    .collect::<Vec<_>>();
    for (cell_x, cell_y) in coordinates {
        let Some(cell) = cells.get((cell_x, cell_y))? else {
            continue;
        };
        for sub_x in 0..header.cell_size as usize {
            for sub_y in 0..header.cell_size as usize {
                let absolute_x = (cell_x - geometry.min_cell_x) * header.cell_size + sub_x as i32;
                let absolute_y = (cell_y - geometry.min_cell_y) * header.cell_size + sub_y as i32;
                let pixel_x = absolute_x.max(0) as usize * geometry.top_square_size;
                let pixel_y = absolute_y.max(0) as usize * geometry.top_square_size;
                if pixel_x < offset_x
                    || pixel_y < offset_y
                    || pixel_x >= offset_x + image.width
                    || pixel_y >= offset_y + image.height
                {
                    continue;
                }
                let Some(tile_names) = cell.tile_names(sub_x, sub_y, layer) else {
                    continue;
                };
                let color = top_view_color(tile_names, textures, color_mode, layer)?;
                let local_x = (pixel_x - offset_x) as i32;
                let local_y = (pixel_y - offset_y) as i32;
                for dy in 0..geometry.top_square_size as i32 {
                    for dx in 0..geometry.top_square_size as i32 {
                        image.set_pixel(local_x + dx, local_y + dy, color);
                    }
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn top_view_color(
    tile_names: &[String],
    textures: &mut TextureLibrary,
    mode: &str,
    layer: i32,
) -> RenderResult<[u8; 4]> {
    if mode.eq_ignore_ascii_case("carto-zed") {
        if let Some(color) = carto_zed_tile(tile_names, layer) {
            return Ok(color);
        }
    }
    let selected = match mode.to_ascii_lowercase().as_str() {
        "base" => tile_names.iter().take(1).collect::<Vec<_>>(),
        "base+water" => base_water_tiles(tile_names),
        _ => tile_names.iter().collect(),
    };
    let mut sums = [0u64; 3];
    let mut count = 0u64;
    for name in selected {
        if let Some(texture) = textures.texture(name)? {
            let (texture_sum, texture_count) = texture.opaque_color_sum();
            for channel in 0..3 {
                sums[channel] += texture_sum[channel];
            }
            count += texture_count;
        }
    }
    if count == 0 {
        return Ok([0, 0, 0, 0]);
    }
    Ok([
        (sums[0] / count) as u8,
        (sums[1] / count) as u8,
        (sums[2] / count) as u8,
        255,
    ])
}

#[cfg(test)]
fn average_colors(colors: &[[u8; 4]]) -> [u8; 4] {
    if colors.is_empty() {
        return [0, 0, 0, 0];
    }
    let mut sums = [0u32; 3];
    for color in colors {
        sums[0] += color[0] as u32;
        sums[1] += color[1] as u32;
        sums[2] += color[2] as u32;
    }
    let count = colors.len() as u32;
    [
        (sums[0] / count) as u8,
        (sums[1] / count) as u8,
        (sums[2] / count) as u8,
        255,
    ]
}

fn is_half_water(name: &str) -> bool {
    matches!(
        name,
        "blends_natural_02_1"
            | "blends_natural_02_2"
            | "blends_natural_02_3"
            | "blends_natural_02_4"
    )
}

fn base_water_tiles(tile_names: &[String]) -> Vec<&String> {
    let mut selected = Vec::new();
    for (index, name) in tile_names.iter().enumerate() {
        if index == 0 {
            selected.push(name);
        } else if is_half_water(name) {
            selected.push(name);
            break;
        }
    }
    selected
}

fn carto_zed_tile(tile_names: &[String], layer: i32) -> Option<[u8; 4]> {
    let rules: &[(usize, Option<usize>, [u8; 4], &str)] = if layer == 0 {
        &[
            (0, Some(5), [218, 165, 32, 255], "corn"),
            (1, None, [38, 53, 22, 255], "tree"),
            (0, Some(1), [132, 81, 76, 255], "tilesand"),
            (1, None, [73, 58, 43, 255], "rails"),
            (1, None, [48, 73, 32, 255], "vegetation"),
            (1, Some(100), [93, 44, 39, 255], "walls"),
            (0, Some(1), [108, 127, 131, 255], "water"),
            (0, Some(1), [128, 128, 128, 255], "street"),
            (0, Some(1), [217, 207, 183, 255], "sand"),
            (0, Some(1), [75, 88, 27, 255], "darkgrass"),
            (0, Some(1), [97, 103, 36, 255], "medgrass"),
            (0, Some(1), [127, 120, 45, 255], "litegrass"),
            (0, Some(1), [91, 63, 21, 255], "dirt"),
            (0, Some(8), [132, 81, 76, 255], "tilesand"),
        ]
    } else {
        &[(1, Some(100), [93, 44, 39, 255], "walls")]
    };
    for (begin, end, color, rule) in rules {
        let end = end.unwrap_or(tile_names.len()).min(tile_names.len());
        for tile in tile_names.iter().take(end).skip(*begin) {
            if carto_zed_matches(tile, rule) {
                return Some(*color);
            }
        }
    }
    None
}

fn carto_zed_matches(tile: &str, rule: &str) -> bool {
    let name = tile.to_ascii_lowercase();
    match rule {
        "corn" => name.contains("vegetation_farm"),
        "tree" => name.contains("_trees") || name.contains("jumbo"),
        "tilesand" => {
            name.contains("floors_exterior_tilesandstone")
                || name.contains("floors_interior_carpet")
                || name.contains("floors_interior_tilesandwood")
                || name.contains("location_")
        }
        "rails" => name.contains("_railroad"),
        "vegetation" => name.starts_with("vegetation"),
        "walls" => name.starts_with("walls"),
        "water" => natural_variant(&name).is_some_and(|(code, _)| code == 2),
        "street" => name.contains("_street_"),
        "sand" => natural_variant(&name)
            .is_some_and(|(code, variant)| code == 1 && (0..=15).contains(&variant)),
        "darkgrass" => natural_variant(&name)
            .is_some_and(|(code, variant)| code == 1 && (16..=31).contains(&variant)),
        "medgrass" => natural_variant(&name)
            .is_some_and(|(code, variant)| code == 1 && (32..=47).contains(&variant)),
        "litegrass" => natural_variant(&name)
            .is_some_and(|(code, variant)| code == 1 && (48..=63).contains(&variant)),
        "dirt" => natural_variant(&name)
            .is_some_and(|(code, variant)| code == 1 && (64..=79).contains(&variant)),
        _ => false,
    }
}

fn natural_variant(name: &str) -> Option<(u32, u32)> {
    let suffix = name.split("_natural_").nth(1)?;
    let mut values = suffix
        .split('_')
        .rev()
        .take(2)
        .map(|value| value.parse::<u32>().ok());
    let variant = values.next()??;
    let code = values.next()??;
    Some((code, variant))
}

fn pyramid_levels(mut width: usize, mut height: usize) -> Vec<(usize, usize)> {
    let mut levels = vec![(width, height)];
    while width > 1 || height > 1 {
        width = width.div_ceil(2);
        height = height.div_ceil(2);
        levels.push((width, height));
    }
    levels.reverse();
    levels
}

fn config_string(config: &Value, key: &str) -> Option<String> {
    config.get(key).and_then(Value::as_str).map(str::to_string)
}

fn configured_custom_map_path(config: &Value, map_name: &str) -> Option<PathBuf> {
    let value = configured_additional_maps(config)
        .into_iter()
        .find(|map| map.name == map_name)
        .and_then(|map| map.folder)
        .or_else(|| {
            config
                .get("custom_map_paths")
                .and_then(Value::as_object)
                .and_then(|paths| paths.get(map_name))
                .and_then(Value::as_str)
                .map(str::to_string)
        })?;
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let path = expand_environment_path(filesystem_path(value));
    if path.is_absolute() {
        return Some(path);
    }
    config_string(config, "custom_root")
        .map(|root| expand_environment_path(filesystem_path(&root)).join(&path))
        .or(Some(path))
}

pub(super) fn filesystem_path(value: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(value.replace('/', "\\"))
    } else {
        PathBuf::from(value)
    }
}

fn expand_environment_path(mut path: PathBuf) -> PathBuf {
    if let Some(text) = path.to_str() {
        let mut expanded = text.to_string();
        for (key, value) in std::env::vars() {
            expanded = expanded.replace(&format!("%{key}%"), &value);
        }
        path = filesystem_path(&expanded);
    }
    path
}

fn sample_without_saves(config: &Value) -> Value {
    let mut sample = config.clone();
    if let Some(object) = sample.as_object_mut() {
        object.remove("save_game_root");
        object.remove("save_games");
    }
    sample
}

fn write_sample_overlay_metadata(root: &Path) -> RenderResult<()> {
    for name in ["foraging", "objects", "rooms", "zombie"] {
        let directory = root.join(name);
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        fs::write(directory.join("marks.json"), b"[]").map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn config_string_nested<'a>(config: &'a Value, path: &[&str]) -> Option<&'a str> {
    nested_value(config, path)?.as_str()
}

pub(crate) fn configured_pyramid_backend(config: &Value) -> PyramidBackend {
    let configured = config_string_nested(config, &["render_conf", "pyramid_backend"])
        .or_else(|| config.get("pyramid_backend").and_then(Value::as_str))
        .unwrap_or("cpu");
    match configured.trim().to_ascii_lowercase().as_str() {
        "gpu" | "cuda" | "directx" | "direct3d" => PyramidBackend::Gpu,
        "auto" | "gpu_if_available" | "gpu-when-available" => PyramidBackend::Auto,
        _ => PyramidBackend::Cpu,
    }
}

pub(crate) fn configured_pyramid_cache_limit_mb(config: &Value) -> usize {
    if !cache::enabled(config) {
        return 0;
    }
    config_number(config, &["render_conf", "cache_limit_mb"])
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value.min(usize::MAX as f64) as usize)
        .unwrap_or(2048)
}

fn nested_value<'a>(config: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut value = config;
    for key in path {
        value = value.get(*key)?;
    }
    Some(value)
}

fn configured_cell_ranges(config: &Value, key: &str) -> RenderResult<Option<Vec<CellRect>>> {
    let Some(value) = nested_value(config, &["render_conf", key]) else {
        return Ok(None);
    };
    if let Some(text) = value.as_str() {
        let normalized = text.trim();
        if normalized.is_empty()
            || normalized.eq_ignore_ascii_case("all")
            || normalized.eq_ignore_ascii_case("auto")
            || normalized.eq_ignore_ascii_case("all_mod_maps")
        {
            return Ok(None);
        }
        return parse_range_text(normalized).map(Some);
    }
    parse_range_value(value).map(Some)
}

fn configured_additional_map_names(config: &Value) -> Vec<String> {
    configured_additional_maps(config)
        .into_iter()
        .map(|map| map.name)
        .collect()
}

fn configured_names(config: &Value, key: &str) -> Vec<String> {
    let Some(value) = config.get(key) else {
        return Vec::new();
    };
    if let Some(text) = value.as_str() {
        return text
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"))
            .map(str::to_string)
            .collect();
    }
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn configured_additional_maps(config: &Value) -> Vec<ConfiguredAdditionalMap> {
    let mut maps = Vec::new();
    for key in ["additional_maps", "custom_maps", "mod_maps"] {
        if let Some(value) = config.get(key) {
            append_configured_additional_maps(value, &mut maps);
        }
    }
    maps
}

fn append_configured_additional_maps(value: &Value, maps: &mut Vec<ConfiguredAdditionalMap>) {
    if let Some(text) = value.as_str() {
        for name in text
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("all"))
        {
            push_configured_additional_map(maps, name, None);
        }
        return;
    }
    let Some(values) = value.as_array() else {
        return;
    };
    for value in values {
        if let Some(name) = value.as_str() {
            push_configured_additional_map(maps, name, None);
            continue;
        }
        let Some(object) = value.as_object() else {
            continue;
        };
        let Some(name) = object
            .get("name")
            .or_else(|| object.get("map_name"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let folder = object
            .get("folder")
            .or_else(|| object.get("path"))
            .and_then(Value::as_str);
        push_configured_additional_map(maps, name, folder);
    }
}

fn push_configured_additional_map(
    maps: &mut Vec<ConfiguredAdditionalMap>,
    raw_name: &str,
    raw_folder: Option<&str>,
) {
    let name = raw_name.trim();
    if name.is_empty() || name.eq_ignore_ascii_case("all") {
        return;
    }
    let folder = raw_folder.map(str::trim).filter(|value| !value.is_empty());
    if let Some(existing) = maps.iter_mut().find(|map| map.name == name) {
        if existing.folder.is_none() {
            existing.folder = folder.map(str::to_string);
        }
        return;
    }
    maps.push(ConfiguredAdditionalMap {
        name: name.to_string(),
        folder: folder.map(str::to_string),
    });
}

fn effective_render_config(config: &Value, map_name: &str, command: &str) -> Value {
    let mut effective = config.clone();
    let render_conf = config
        .get("__render_conf_source")
        .and_then(Value::as_object)
        .or_else(|| config.get("render_conf").and_then(Value::as_object));
    let Some(render_conf) = render_conf else {
        return effective;
    };
    let mut resolved = serde_json::Map::new();
    let mut priorities = HashMap::<String, usize>::new();
    for (raw_key, value) in render_conf {
        let (base, map, cmd) = parse_override_key(raw_key);
        let priority = if map.as_deref() == Some(map_name) && cmd.as_deref() == Some(command) {
            3
        } else if cmd.as_deref() == Some(command) && map.is_none() {
            2
        } else if map.as_deref() == Some(map_name) && cmd.is_none() {
            1
        } else if map.is_none() && cmd.is_none() {
            0
        } else {
            continue;
        };
        if priorities
            .get(&base)
            .is_some_and(|current| *current > priority)
        {
            continue;
        }
        priorities.insert(base.clone(), priority);
        resolved.insert(base, value.clone());
    }
    effective["render_conf"] = Value::Object(resolved);
    effective["__render_conf_source"] = Value::Object(render_conf.clone());
    effective["__render_map_name"] = Value::String(map_name.to_string());
    effective
}

pub(crate) fn effective_command_config(config: &Value, command: &str) -> Value {
    let map_name = config
        .get("__render_map_name")
        .and_then(Value::as_str)
        .unwrap_or("default");
    effective_render_config(config, map_name, command)
}

fn parse_override_key(raw_key: &str) -> (String, Option<String>, Option<String>) {
    let base_end = raw_key.find(['[', '(']).unwrap_or(raw_key.len());
    let base = raw_key[..base_end].to_string();
    let map = raw_key
        .find('[')
        .and_then(|start| {
            raw_key[start + 1..]
                .find(']')
                .map(|end| (start + 1, start + 1 + end))
        })
        .map(|(start, end)| raw_key[start..end].to_string())
        .filter(|value| !value.is_empty());
    let command = raw_key
        .find('(')
        .and_then(|start| {
            raw_key[start + 1..]
                .find(')')
                .map(|end| (start + 1, start + 1 + end))
        })
        .map(|(start, end)| raw_key[start..end].to_string())
        .filter(|value| !value.is_empty());
    (base, map, command)
}

fn parse_range_value(value: &Value) -> RenderResult<Vec<CellRect>> {
    let values = value.as_array().ok_or_else(|| {
        "Cell range must be 'all' or an array of [x, y] / [x, y, width, height].".to_string()
    })?;
    if values.iter().all(Value::is_number) {
        return range_from_numbers(values);
    }
    let mut ranges = Vec::new();
    for item in values {
        let numbers = item
            .as_array()
            .ok_or_else(|| "Each cell range must be an array of numbers.".to_string())?;
        ranges.extend(range_from_numbers(numbers)?);
    }
    Ok(ranges)
}

fn parse_range_text(text: &str) -> RenderResult<Vec<CellRect>> {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return parse_range_value(&value);
    }
    let mut groups = Vec::new();
    let mut current = Vec::new();
    let mut number = String::new();
    let mut in_group = false;
    for character in text.chars() {
        if character == '[' {
            in_group = true;
            current.clear();
        } else if character == ']' {
            if !number.trim().is_empty() {
                current.push(parse_integer(&number)?);
                number.clear();
            }
            if in_group {
                if !current.is_empty() {
                    groups.push(current.clone());
                }
            }
            in_group = false;
        } else if character == '-' || character.is_ascii_digit() {
            number.push(character);
        } else if !number.trim().is_empty() {
            current.push(parse_integer(&number)?);
            number.clear();
        }
    }
    if !number.trim().is_empty() {
        current.push(parse_integer(&number)?);
    }
    if groups.is_empty() && !current.is_empty() {
        groups.push(current);
    }
    if groups.is_empty() {
        return Err(format!("Could not parse cell range: {text}"));
    }
    let mut ranges = Vec::new();
    for group in groups {
        ranges.extend(range_from_integers(&group)?);
    }
    Ok(ranges)
}

fn range_from_numbers(numbers: &[Value]) -> RenderResult<Vec<CellRect>> {
    let values = numbers
        .iter()
        .map(|value| {
            value
                .as_i64()
                .and_then(|number| i32::try_from(number).ok())
                .ok_or_else(|| "Cell range coordinates must be 32-bit integers.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    range_from_integers(&values)
}

fn range_from_integers(values: &[i32]) -> RenderResult<Vec<CellRect>> {
    if values.len() != 2 && values.len() != 4 {
        return Err("Cell ranges must contain 2 or 4 integers.".to_string());
    }
    let width = values.get(2).copied().unwrap_or(1);
    let height = values.get(3).copied().unwrap_or(1);
    if width <= 0 || height <= 0 {
        return Err("Cell range width and height must be positive.".to_string());
    }
    Ok(vec![CellRect {
        x: values[0],
        y: values[1],
        width,
        height,
    }])
}

fn parse_integer(value: &str) -> RenderResult<i32> {
    value
        .trim()
        .parse::<i32>()
        .map_err(|error| format!("Invalid cell range coordinate '{value}': {error}"))
}

fn in_ranges(ranges: Option<&[CellRect]>, x: i32, y: i32) -> bool {
    ranges
        .map(|ranges| ranges.iter().any(|range| range.contains(x, y)))
        .unwrap_or(true)
}

fn range_bounds(ranges: &[CellRect]) -> Option<(i32, i32, i32, i32)> {
    let min_x = ranges.iter().map(|range| range.x).min()?;
    let min_y = ranges.iter().map(|range| range.y).min()?;
    let max_x = ranges.iter().map(|range| range.x + range.width - 1).max()?;
    let max_y = ranges
        .iter()
        .map(|range| range.y + range.height - 1)
        .max()?;
    Some((min_x, min_y, max_x, max_y))
}

fn config_number(config: &Value, path: &[&str]) -> Option<f64> {
    let mut value = config;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_f64()
}

pub(crate) fn configured_layer_range(
    config: &Value,
    source_min: i32,
    source_max: i32,
) -> RenderResult<std::ops::Range<i32>> {
    let Some(value) = nested_value(config, &["render_conf", "layer_range"]) else {
        return Ok(source_min..source_max);
    };
    let numbers = if let Some(text) = value.as_str() {
        let text = text.trim();
        if text.is_empty() || text.eq_ignore_ascii_case("all") {
            return Ok(source_min..source_max);
        }
        if text.eq_ignore_ascii_case("ground")
            || text.eq_ignore_ascii_case("layer0")
            || text.eq_ignore_ascii_case("ground_only")
        {
            let requested_min = 0.max(source_min);
            let requested_max = 1.min(source_max);
            if requested_min >= requested_max {
                return Err(format!(
                    "Configured ground layer does not overlap the available range [{source_min}, {source_max})."
                ));
            }
            return Ok(requested_min..requested_max);
        }
        if text.eq_ignore_ascii_case("ground_and_positive")
            || text.eq_ignore_ascii_case("nonnegative")
            || text.eq_ignore_ascii_case("positive")
        {
            let requested_min = 0.max(source_min);
            if requested_min >= source_max {
                return Err(format!(
                    "Configured ground_and_positive range does not overlap the available range [{source_min}, {source_max})."
                ));
            }
            return Ok(requested_min..source_max);
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
            layer_range_numbers(&parsed)?
        } else {
            parse_layer_text(text)?
        }
    } else {
        layer_range_numbers(value)?
    };
    let requested_min = numbers[0].max(source_min);
    let requested_max = numbers[1].min(source_max);
    if requested_min >= requested_max {
        return Err(format!(
            "Configured layer range [{}, {}] does not overlap the available range [{source_min}, {source_max}).",
            numbers[0], numbers[1]
        ));
    }
    Ok(requested_min..requested_max)
}

fn layer_range_numbers(value: &Value) -> RenderResult<Vec<i32>> {
    let values = value.as_array().ok_or_else(|| {
        "Layer range must be 'all', 'ground', 'ground_and_positive', or [minimum, maximum]."
            .to_string()
    })?;
    if values.len() != 2 {
        return Err("Layer range must contain exactly two integers.".to_string());
    }
    values
        .iter()
        .map(|value| {
            value
                .as_i64()
                .and_then(|number| i32::try_from(number).ok())
                .ok_or_else(|| "Layer range values must be 32-bit integers.".to_string())
        })
        .collect()
}

fn parse_layer_text(text: &str) -> RenderResult<Vec<i32>> {
    let mut values = Vec::new();
    let mut number = String::new();
    for character in text.chars() {
        if character == '-' || character.is_ascii_digit() {
            number.push(character);
        } else if !number.is_empty() {
            values.push(parse_integer(&number)?);
            number.clear();
        }
    }
    if !number.is_empty() {
        values.push(parse_integer(&number)?);
    }
    if values.len() != 2 {
        return Err("Layer range must contain exactly two integers.".to_string());
    }
    Ok(values)
}

fn ensure_not_stopped(path: &Path) -> RenderResult<()> {
    if path.is_file() {
        return Err("Build stopped by user.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pyramid_starts_at_one_pixel() {
        assert_eq!(pyramid_levels(4, 2), vec![(1, 1), (2, 1), (4, 2)]);
    }

    #[test]
    fn parses_pyramid_backend_and_preserves_cpu_default() {
        assert_eq!(
            configured_pyramid_backend(&json!({
                "render_conf": {"pyramid_backend": "gpu"}
            })),
            PyramidBackend::Gpu
        );
        assert_eq!(
            configured_pyramid_backend(&json!({
                "render_conf": {"pyramid_backend": "auto"}
            })),
            PyramidBackend::Auto
        );
        assert_eq!(
            configured_pyramid_backend(&json!({"render_conf": {}})),
            PyramidBackend::Cpu
        );
    }

    #[test]
    fn pyramid_cache_uses_safe_default_only_when_enabled() {
        assert_eq!(configured_pyramid_cache_limit_mb(&json!({})), 2048);
        assert_eq!(
            configured_pyramid_cache_limit_mb(&json!({
                "render_conf": {"enable_cache": true, "cache_limit_mb": 0}
            })),
            2048
        );
        assert_eq!(
            configured_pyramid_cache_limit_mb(&json!({
                "render_conf": {"enable_cache": true, "cache_limit_mb": 512}
            })),
            512
        );
        assert_eq!(
            configured_pyramid_cache_limit_mb(&json!({
                "render_conf": {"enable_cache": false, "cache_limit_mb": 4096}
            })),
            0
        );
    }

    #[test]
    fn pyramid_tiles_are_parallel_and_resumable_from_tile_markers() {
        let root =
            std::env::temp_dir().join(format!("pz-honus-hub-pyramid-test-{}", std::process::id()));
        let source_level = root.join("layer0_files/1");
        fs::create_dir_all(&source_level).expect("create pyramid source level");
        for tile_y in 0..2 {
            for tile_x in 0..2 {
                let mut child = RgbaImage::new(2, 2);
                for pixel in child.pixels.chunks_exact_mut(4) {
                    pixel.copy_from_slice(&[(tile_x * 80) as u8, (tile_y * 80) as u8, 200, 255]);
                }
                child
                    .write(
                        &source_level.join(format!("{tile_x}_{tile_y}.png")),
                        OutputFormat::Png,
                        ImageSaveOptions::default(),
                    )
                    .expect("write pyramid source tile");
            }
        }
        let stop_path = root.join("stop");
        let levels = [(2, 2), (4, 4)];
        let mut progress_events = 0;
        build_pyramid_with_progress(
            &stop_path,
            &root,
            0,
            &levels,
            2,
            OutputFormat::Png,
            ImageSaveOptions::default(),
            "pyramid-test",
            0,
            PyramidBackend::Cpu,
            |_, _, _, _, _| {
                progress_events += 1;
                Ok(())
            },
        )
        .expect("pyramid should render");
        assert_eq!(progress_events, 1);
        assert!(root.join("layer0_files/0/0_0.png").is_file());
        assert!(root.join("layer0_files/0/0_0.pyramid-cache").is_file());

        let mut resumed_events = 0;
        build_pyramid_with_progress(
            &stop_path,
            &root,
            0,
            &levels,
            2,
            OutputFormat::Png,
            ImageSaveOptions::default(),
            "pyramid-test",
            0,
            PyramidBackend::Cpu,
            |_, _, _, _, _| {
                resumed_events += 1;
                Ok(())
            },
        )
        .expect("pyramid should resume from its marker");
        assert_eq!(resumed_events, 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn omit_levels_keeps_at_least_one_pyramid_level() {
        let levels = pyramid_levels(16, 8);
        assert_eq!(retained_pyramid_levels(&levels, 1).last(), Some(&(8, 4)));
        assert_eq!(retained_pyramid_levels(&levels, 100).len(), 1);
    }

    #[test]
    fn alpha_compositing_preserves_opaque_source() {
        let texture = Texture {
            width: 1,
            height: 1,
            offset_x: 0,
            offset_y: 0,
            pixels: vec![255, 0, 0, 255],
        };
        let mut image = RgbaImage::new(1, 1);
        texture.composite_into(&mut image, 0, 0);
        assert_eq!(image.pixels, vec![255, 0, 0, 255]);
    }

    #[test]
    fn alpha_compositing_preserves_translucent_source_color() {
        let mut image = RgbaImage::new(1, 1);
        image.blend_pixel(0, 0, [255, 0, 0, 128]);
        assert_eq!(image.pixels, vec![255, 0, 0, 128]);
        image.blend_pixel(0, 0, [0, 0, 255, 128]);
        assert_eq!(image.pixels, vec![85, 0, 170, 192]);
    }

    #[test]
    fn transparent_tiles_use_an_empty_sentinel_and_can_be_replaced() {
        let root =
            std::env::temp_dir().join(format!("pz-honus-hub-empty-tile-{}", std::process::id()));
        let path = root.join("layer0_files/0/0_0.webp");
        let empty = RgbaImage::new(2, 2);
        assert!(
            !write_optional_tile(
                &empty,
                &path,
                OutputFormat::Webp,
                ImageSaveOptions::default(),
                true,
            )
            .expect("write empty tile sentinel")
        );
        assert!(!path.is_file());
        assert!(tile_output_exists(&path));
        assert!(empty_tile_path(&path).is_file());
        assert!(!public_empty_tile_path(&path).is_file());

        let mut filled = RgbaImage::new(2, 2);
        filled.set_pixel(0, 0, [255, 0, 0, 255]);
        assert!(
            write_optional_tile(
                &filled,
                &path,
                OutputFormat::Webp,
                ImageSaveOptions::default(),
                true,
            )
            .expect("replace empty tile with image")
        );
        assert!(path.is_file());
        assert!(!empty_tile_path(&path).exists());
        assert!(!public_empty_tile_path(&path).exists());
        assert!(tile_output_exists(&path));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_reusing_output_with_different_map_geometry() {
        let root = std::env::temp_dir().join(format!(
            "pz-honus-hub-map-info-compatibility-{}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("create map output directory");
        fs::write(
            root.join("map_info.json"),
            serde_json::to_vec(&json!({
                "w": 100,
                "h": 80,
                "skip": 0,
                "x0": 1,
                "y0": 2,
                "sqr": 128
            }))
            .expect("serialize old map info"),
        )
        .expect("write old map info");

        let error = ensure_map_info_compatible(
            &root,
            &json!({
                "w": 101,
                "h": 80,
                "skip": 0,
                "x0": 1,
                "y0": 2,
                "sqr": 128
            }),
        )
        .expect_err("geometry changes should require a new output");
        assert!(error.contains("geometry changed"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn decodes_configured_map_text_encodings() {
        assert_eq!(decode_map_text(b"Cafe", "utf8"), "Cafe");
        assert_eq!(decode_map_text(&[0x43, 0x61, 0x66, 0xE9], "cp1252"), "Café");
        assert_eq!(decode_map_text(&[0x43, 0x61, 0x66, 0xE9], "latin1"), "Café");
    }

    #[test]
    fn loads_extracted_png_textures_with_offsets_and_crops_transparency() {
        let root =
            std::env::temp_dir().join(format!("pz-honus-hub-raw-texture-{}", std::process::id()));
        fs::create_dir_all(&root).expect("create raw texture directory");
        let path = root.join("tile.png");
        let mut bytes = Vec::new();
        {
            let encoder = png::Encoder::new(Cursor::new(&mut bytes), 3, 2);
            let mut encoder = encoder;
            encoder.set_color(ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .add_text_chunk("ox".to_string(), "7".to_string())
                .expect("write x offset metadata");
            encoder
                .add_text_chunk("oy".to_string(), "-9".to_string())
                .expect("write y offset metadata");
            let mut writer = encoder.write_header().expect("write png header");
            writer
                .write_image_data(&[
                    0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255,
                ])
                .expect("write png pixels");
        }
        fs::write(&path, bytes).expect("write raw texture");

        let mut library =
            TextureLibrary::load_directories_with_progress(std::slice::from_ref(&root), |_| {})
                .expect("load raw texture directory");
        let texture = library
            .texture("tile")
            .expect("decode raw texture")
            .expect("find raw texture");
        assert_eq!((texture.width, texture.height), (2, 2));
        assert_eq!((texture.offset_x, texture.offset_y), (8, -9));
        assert_eq!(texture.pixels.len(), 2 * 2 * 4);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn caches_pack_reads_and_decoded_pages_for_multiple_textures() {
        let root =
            std::env::temp_dir().join(format!("pz-honus-hub-pack-cache-{}", std::process::id()));
        fs::create_dir_all(&root).expect("create texture pack directory");
        let mut png_bytes = Vec::new();
        {
            let encoder = png::Encoder::new(Cursor::new(&mut png_bytes), 2, 1);
            let mut encoder = encoder;
            encoder.set_color(ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().expect("write texture page header");
            writer
                .write_image_data(&[255, 0, 0, 255, 0, 255, 0, 255])
                .expect("write texture page pixels");
        }

        let mut pack = Vec::new();
        let push_u32 = |target: &mut Vec<u8>, value: u32| {
            target.extend_from_slice(&value.to_le_bytes());
        };
        let push_i32 = |target: &mut Vec<u8>, value: i32| {
            target.extend_from_slice(&value.to_le_bytes());
        };
        pack.extend_from_slice(b"PZPK");
        push_u32(&mut pack, 1);
        push_u32(&mut pack, 1);
        push_u32(&mut pack, 4);
        pack.extend_from_slice(b"page");
        push_u32(&mut pack, 2);
        push_u32(&mut pack, 1);
        for (name, x) in [("one", 0_u32), ("two", 1_u32)] {
            push_u32(&mut pack, name.len() as u32);
            pack.extend_from_slice(name.as_bytes());
            push_u32(&mut pack, x);
            push_u32(&mut pack, 0);
            push_u32(&mut pack, 1);
            push_u32(&mut pack, 1);
            push_i32(&mut pack, 0);
            push_i32(&mut pack, 0);
            push_i32(&mut pack, 1);
            push_i32(&mut pack, 1);
        }
        push_u32(&mut pack, png_bytes.len() as u32);
        pack.extend_from_slice(&png_bytes);
        fs::write(root.join("tiles.pack"), pack).expect("write texture pack");

        let mut messages = Vec::new();
        let mut library = TextureLibrary::load_sources_with_progress(
            &[TextureSource {
                path: root.clone(),
                patterns: Vec::new(),
            }],
            |message| messages.push(message),
        )
        .expect("index texture pack");
        assert!(
            library
                .texture("one")
                .expect("decode first texture")
                .is_some()
        );
        assert!(
            library
                .texture("two")
                .expect("decode second texture")
                .is_some()
        );
        assert_eq!(messages.len(), 1);
        assert!(library.cache_summary().contains("1 pack read(s)"));
        assert!(library.cache_summary().contains("1 PNG page(s) decoded"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_single_cell_and_rect_ranges() {
        let single = parse_range_text("[30, 30]").expect("single cell range should parse");
        assert_eq!(
            single[0],
            CellRect {
                x: 30,
                y: 30,
                width: 1,
                height: 1
            }
        );
        let rect = parse_range_text("[30, 30, 21, 21]").expect("rect range should parse");
        assert_eq!(range_bounds(&rect), Some((30, 30, 50, 50)));
    }

    #[test]
    fn parses_nested_json_ranges() {
        let config = json!({
            "render_conf": {
                "render_cell_range": [[-2, 4], [8, 9, 2, 3]]
            }
        });
        let ranges = configured_cell_ranges(&config, "render_cell_range")
            .expect("nested ranges should parse")
            .expect("configured ranges should be present");
        assert_eq!(ranges.len(), 2);
        assert!(in_ranges(Some(&ranges), -2, 4));
        assert!(in_ranges(Some(&ranges), 9, 11));
        assert!(!in_ranges(Some(&ranges), 7, 9));
        let text_ranges =
            parse_range_text("[[1, 2], [4, 5, 2, 2]]").expect("JSON text ranges should parse");
        assert_eq!(text_ranges.len(), 2);
        let line_ranges =
            parse_range_text("[1, 2]\n[4, 5]").expect("line-separated ranges should parse");
        assert_eq!(line_ranges.len(), 2);
    }

    #[test]
    fn compact_cell_rect_cover_matches_python_shape() {
        assert_eq!(
            rect_cover(&[(0, 0), (0, 1), (1, 0), (1, 1), (3, 2), (3, 3)]),
            vec![
                CellRect {
                    x: 0,
                    y: 0,
                    width: 2,
                    height: 2,
                },
                CellRect {
                    x: 3,
                    y: 2,
                    width: 1,
                    height: 2,
                },
            ]
        );
    }

    #[test]
    fn clamps_configured_layer_range_to_source_layers() {
        let config = json!({"render_conf": {"layer_range": "[-32, 3]"}});
        let range = configured_layer_range(&config, 0, 8).expect("layer range should parse");
        assert_eq!(range, 0..3);
    }

    #[test]
    fn supports_named_quality_layer_ranges() {
        let ground = json!({"render_conf": {"layer_range": "ground"}});
        let ground_range =
            configured_layer_range(&ground, -32, 32).expect("ground range should parse");
        assert_eq!(ground_range, 0..1);

        let nonnegative = json!({"render_conf": {"layer_range": "ground_and_positive"}});
        let nonnegative_range =
            configured_layer_range(&nonnegative, -32, 32).expect("nonnegative range should parse");
        assert_eq!(nonnegative_range, 0..32);
    }

    #[test]
    fn clamps_build_specific_header_layer_bounds() {
        assert_eq!(clamped_layer_bounds(0, 0, 40), (0, 8));
        assert_eq!(clamped_layer_bounds(42, -40, 40), (-32, 32));
        assert_eq!(clamped_layer_bounds(42, -10, 31), (-10, 32));
    }

    #[test]
    fn rejects_layer_ranges_without_overlap() {
        let config = json!({"render_conf": {"layer_range": [20, 24]}});
        let error = configured_layer_range(&config, 0, 8).expect_err("range should be rejected");
        assert!(error.contains("does not overlap"));
    }

    #[test]
    fn aligns_geometry_origins_to_configured_tile_levels() {
        let geometry = Geometry::from_cell_bounds(3, 5, 4, 6, 10, 1, 1024, 3, 0, 8);
        assert_eq!(geometry.min_cell_x, 0);
        assert_eq!(geometry.min_cell_y, 4);
        assert_eq!(geometry.top_width, 50);
        assert_eq!(geometry.top_height, 30);
    }

    #[test]
    fn isometric_geometry_reserves_configured_layer_offsets() {
        let one_layer = Geometry::from_cell_bounds(0, 0, 0, 0, 10, 1, 1024, 3, 0, 1);
        let build_42 = Geometry::from_cell_bounds(0, 0, 0, 0, 10, 1, 1024, 3, -32, 32);
        assert!(build_42.min_y < one_layer.min_y);
        assert!(build_42.iso_height > one_layer.iso_height);
        assert!(build_42.iso_width >= one_layer.iso_width);
    }

    #[test]
    fn averages_top_view_colors() {
        assert_eq!(
            average_colors(&[[10, 20, 30, 255], [30, 40, 50, 255]]),
            [20, 30, 40, 255]
        );
        assert!(is_half_water("blends_natural_02_3"));
        assert!(!is_half_water("floors_interior_01"));
        let names = vec![
            "floor_base".to_string(),
            "vegetation_groundcover".to_string(),
            "blends_natural_02_3".to_string(),
            "blends_natural_02_4".to_string(),
        ];
        assert_eq!(
            base_water_tiles(&names)
                .into_iter()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["floor_base", "blends_natural_02_3"]
        );
    }

    #[test]
    fn weights_top_view_color_by_opaque_texture_pixels() {
        let mut textures = TextureLibrary::default();
        textures.textures.insert(
            "small".into(),
            Texture {
                width: 1,
                height: 1,
                offset_x: 0,
                offset_y: 0,
                pixels: vec![255, 0, 0, 255],
            },
        );
        textures.textures.insert(
            "large".into(),
            Texture {
                width: 3,
                height: 1,
                offset_x: 0,
                offset_y: 0,
                pixels: vec![0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255],
            },
        );
        let names = ["small".to_string(), "large".to_string()];
        assert_eq!(
            top_view_color(&names, &mut textures, "avg", 0).expect("average color"),
            [63, 0, 191, 255]
        );
    }

    #[test]
    fn applies_cartozed_rule_order_and_natural_ranges() {
        assert_eq!(
            carto_zed_tile(&["floors_exterior_tilesandstone_01".into()], 0),
            Some([132, 81, 76, 255])
        );
        assert_eq!(
            carto_zed_tile(&["blends_natural_01_32".into()], 0),
            Some([97, 103, 36, 255])
        );
        assert_eq!(
            carto_zed_tile(&["floor_generic_01".into(), "walls_generic_01".into()], 1),
            Some([93, 44, 39, 255])
        );
    }

    #[test]
    fn resolves_nested_workshop_map_sources() {
        let root =
            std::env::temp_dir().join(format!("pz-honus-hub-map-source-{}", std::process::id()));
        let map = root.join("123/mods/Test/media/maps/Workshop Map");
        fs::create_dir_all(&map).expect("create nested workshop map");
        let config = json!({"pz_root": root.join("game"), "mod_root": root});
        assert_eq!(resolve_map_path(&config, "Workshop Map"), map);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn custom_map_paths_override_description_fallbacks() {
        let root = std::env::temp_dir().join(format!(
            "pz-honus-hub-custom-map-path-{}",
            std::process::id()
        ));
        let config = json!({
            "custom_root": root,
            "custom_map_paths": {
                "My Map": "maps/My Map"
            }
        });
        assert_eq!(
            configured_custom_map_path(&config, "My Map"),
            Some(root.join("maps/My Map"))
        );
        assert_eq!(configured_custom_map_path(&config, "Missing"), None);
    }

    #[test]
    fn additional_maps_use_name_for_identity_and_folder_as_an_override() {
        let root = std::env::temp_dir().join(format!(
            "pz-honus-hub-additional-map-{}",
            std::process::id()
        ));
        let folder = root.join("maps/Bedford Falls");
        let config = json!({
            "additional_maps": [{"name": "Bedford Falls", "folder": folder}]
        });

        assert_eq!(
            configured_additional_map_names(&config),
            vec!["Bedford Falls".to_string()]
        );
        assert_eq!(
            configured_custom_map_path(&config, "Bedford Falls"),
            Some(folder)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normalizes_windows_filesystem_separators_at_the_path_boundary() {
        let path = filesystem_path("D:/pzmap/maps");
        if cfg!(windows) {
            assert_eq!(path.to_string_lossy(), "D:\\pzmap\\maps");
        } else {
            assert_eq!(path.to_string_lossy(), "D:/pzmap/maps");
        }
    }

    #[test]
    fn all_mod_map_bounds_include_custom_map_cells() {
        let root = std::env::temp_dir().join(format!(
            "pz-honus-hub-all-mod-map-bounds-{}",
            std::process::id()
        ));
        let base = root.join("base");
        let mod_map = root.join("my-map");
        fs::create_dir_all(&base).expect("create base map directory");
        fs::create_dir_all(&mod_map).expect("create custom map directory");
        write_test_header(&base, 0, 0);
        write_test_header(&mod_map, 3, 4);

        let config = json!({
            "base_map": "default",
            "render_conf": {"dzi_cell_range": "all_mod_maps"},
            "mod_maps": ["My Map"],
            "custom_map_paths": {"My Map": mod_map}
        });
        let base_headers = scan_headers(&base, "utf8").expect("scan base headers");
        let bounds = dzi_bounds(
            &config,
            &MapCatalog::default(),
            "default",
            &base,
            &base_headers,
            None,
        )
        .expect("calculate combined map bounds");

        assert_eq!(bounds, Some((0, 0, 3, 4)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn configured_dzi_range_takes_precedence_over_all_mod_map_bounds() {
        let config = json!({
            "render_conf": {"dzi_cell_range": "all_mod_maps"}
        });
        assert!(uses_all_mod_map_bounds(&config));

        let ranges = vec![CellRect {
            x: 8,
            y: 9,
            width: 2,
            height: 3,
        }];
        let headers = HashMap::new();
        assert_eq!(
            dzi_bounds(
                &config,
                &MapCatalog::default(),
                "default",
                Path::new("unused"),
                &headers,
                Some(&ranges),
            )
            .expect("use configured range"),
            Some((8, 9, 9, 11))
        );
    }

    fn write_test_header(root: &Path, x: i32, y: i32) {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"LOTH");
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.push(0);
        bytes.extend_from_slice(&960u32.to_le_bytes());
        bytes.extend_from_slice(&960u32.to_le_bytes());
        bytes.extend_from_slice(&8i32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend(std::iter::repeat_n(0u8, 30 * 30));
        fs::write(root.join(format!("{x}_{y}.lotheader")), bytes).expect("write test header");
    }

    #[test]
    fn applies_map_and_command_override_precedence() {
        let config = json!({
            "render_conf": {
                "omit_levels": 0,
                "omit_levels(base)": 1,
                "omit_levels[default]": 2,
                "omit_levels[default](base)": 3
            }
        });
        let effective = effective_render_config(&config, "default", "base");
        assert_eq!(effective["render_conf"]["omit_levels"].as_i64(), Some(3));
    }

    #[test]
    fn preserves_command_overrides_for_overlay_pipelines() {
        let config = json!({
            "render_conf": {
                "tile_size": 1024,
                "tile_size(zombie)": 4096,
                "tile_size(foraging)": 2048
            }
        });
        let base = effective_render_config(&config, "default", "base");
        let zombie = effective_command_config(&base, "zombie");
        let foraging = effective_command_config(&base, "foraging");
        assert_eq!(zombie["render_conf"]["tile_size"].as_i64(), Some(4096));
        assert_eq!(foraging["render_conf"]["tile_size"].as_i64(), Some(2048));
    }

    #[test]
    fn applies_seasonal_plant_texture_configuration() {
        let mapping = plant_texture_mapping(&json!({
            "season": "autumn",
            "tree_size": 2,
            "jumbo_tree_size": 4,
            "jumbo_tree_type": 1,
            "no_ground_cover": true
        }));
        assert!(mapping["vegetation_groundcover_01_0"].is_empty());
        assert!(mapping["vegetation_trees_01_0"][0].contains("e_"));
        assert!(mapping.contains_key("jumbo_tree_01_0"));
    }
}
