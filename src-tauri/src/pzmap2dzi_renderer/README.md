# Native pzmap2dzi renderer modules

The renderer is deliberately split by responsibility:

- `pzmap2dzi_renderer.rs` owns the Project Zomboid cell/lotpack readers and base map geometry.
- `output.rs` owns PNG/WebP/JPG encoding and Deep Zoom pyramid construction.
- `cache.rs` owns deterministic source/config signatures used for incremental rebuilds.
- `map_config.rs` loads `map_conf` YAML descriptions, applies defaults, expands
  map/config placeholders, resolves dependencies in default-first order, and
  filters texture packs. Flat `default_b41.txt`/`default_b42.txt` fields are
  applied to every map definition like the Python renderer.
- `overlays.rs` emits viewer-consumed marks for rooms, objects, zombies, foraging, and streets.
- `overlay_raster.rs` emits the zombie and foraging image overlays for both map projections,
  using full isometric diamonds and configured Build 41/42 foraging colors. It
  also emits geometric room borders and object borders when marks are disabled,
  split across the configured Z-layer range. Room, object, and zombie labels
  use configured fonts through `fontdue`; CSS color names, RGB/RGBA, HSL, and
  alpha hex values use the same default-alpha behavior as Pillow.
- `save_chunk.rs` decodes versioned B41/B42 chunk squares, object sprites, and
  layer masks without a Python parser dependency.
- `world_dictionary.rs` resolves runtime/mod-registered saved sprites from
  `WorldDictionary.bin`, including B41/B42 layouts.
- `save_game.rs` discovers versioned save chunks, writes the native save-source
  index, adds jumbo-tree definitions, and renders parsed save squares into
  per-save DZI base/base-top views.
- Cell-range settings now accept `[x, y]`, `[x, y, width, height]`, or multiple
  ranges. `dzi_cell_range` limits the output bounds, while `render_cell_range`
  limits which cells are loaded and drawn within those bounds.
- `dzi_cell_range: all_mod_maps` combines the base map and configured additional-map
  cell extents, including maps supplied through Angular `additional_maps`.
- `omit_levels` now removes the highest-resolution pyramid levels from base,
  overlay, and save outputs and updates each DZI dimension accordingly.
- `layer_range` is clamped to the source map/save layers and controls which
  image layers are rendered.
- `tile_align_levels` aligns top-down cell origins and isometric grid origins
  to the configured power-of-two tile boundary.
- `additional_maps` entries are rendered below `map_data/mod_maps/<name>` using
  the same renderer pipeline as the base map. Each entry is identified by its
  `name`; an optional `folder` overrides map-description and Workshop discovery.
- The Rust reader remains backward-compatible with legacy `mod_maps`,
  `custom_maps`, and `custom_map_paths` settings.
- `image_save_options` supports PNG `compress_level` and JPG/JPEG `quality`;
  configured `hash_method` values `md5`, `sha1`, and `sha256` hash source file
  contents for incremental-cache signatures.
- DZI parent tiles use the same Lanczos resampling family as Python/Pillow's
  `Image.thumbnail(..., Image.LANCZOS)` path on the CPU backend. The CPU
  pyramid scheduler follows Python's topological order: child images are kept
  in a bounded in-memory cache until their parent is ready, with disk fallback
  for evicted or resumed tiles. CPU workers use `fast_image_resize`'s SIMD
  RGBA8 Lanczos implementation and reuse one resizer per worker, avoiding
  repeated filter setup for every tile. Its optional Rayon feature is not
  enabled because the renderer already owns the outer worker pool.
  The optional `render_conf.pyramid_backend: gpu` path uses WGPU/D3D12 (or
  Vulkan/GLES) linear filtering for the resize stage; image decoding,
  child-tile assembly, encoding, and disk I/O remain native CPU work. `auto`
  selects the parallel CPU path because the current GPU path has a synchronous
  readback per tile; `gpu` reports an error instead of silently changing the
  selected backend.
- `render_conf.worker_count` accepts `all`, `auto`, or a positive integer. `all`
  resolves to the process's available logical CPU cores and is recorded in the
  worker log, resume configuration, and build estimates.
- JPG layers composite previously rendered lower layers before encoding, matching
  Python's non-alpha `render_below` behavior; PNG/WebP retain independent alpha
  layers.
- `map_info.json` preserves the DZI cell boundary separately from
  `render_cell_range`, so a subset render does not corrupt viewer coordinate
  metadata. The worker's scan stage performs a real base-map header preflight;
  direct PZPK indexing and metadata writes occur in the native render stage.
- Fully transparent tiles are omitted like Python's default `save_empty_tile: false`;
  Rust keeps a private sentinel for incremental cache and emits the public
  `.empty` marker only when `save_empty_tile` is enabled.
- Isometric output uses the configured layer offsets, jumbo-texture output
  margins, and projection-specific `map_info.json` origins for base, overlay,
  and save views.
- The native pipeline streams tile stages to disk and uses `cache_limit_mb` as
  a bounded pyramid image cache. This preserves the Python renderer's locality
  optimization without retaining an entire full-resolution map in RAM. Set
  `enable_cache: false` to disable it; when caching is enabled, `0` selects the
  safe native 2048 MB default rather than falling back to disk-only pyramid
  composition.
- Source cells use a deterministic 16-entry LRU, matching Python's
  `load_cell_cached` limit, so large maps no longer keep every decoded cell in
  memory while base and mod-map tiles are rendered.
- When the render cache is enabled, base and mod-map bottom-level tiles keep
  per-tile signatures for their contributing `world_x_y.lotpack` files. A
  partial map change rerenders affected tiles and rebuilds the pyramid while
  retaining unchanged source tiles.
- Existing base, overlay, and save outputs are rejected when their stored
  `map_info.json` geometry no longer matches the requested render, preventing
  incompatible pyramids from being mixed incrementally.
- Texture packs are indexed without decoding every page up front; individual
  sprites are decoded only when a tile requests them, reducing memory use for
  range and save-game renders.
- Seasonal plant, bush, grass, tree, and jumbo-tree substitutions are composed
  in the Rust texture library from `plants_conf`.
- B42 foraging marks resolve `BiomeMapConfig.lua` pixel IDs and honor
  per-biome colors and `skip`; `use_mark` and `zombie_count` control vector
  mark output independently of heatmap rasters.
- Command-scoped renderer overrides such as `tile_size(zombie)` and
  `tile_align_levels(foraging)` are retained through effective-config
  resolution and applied to their overlay DZI outputs.
- Object marks accept rectangular, polygon, and line geometry from nested
  `objects.lua` records and convert covered cells into compact rectangles.
- Base-map source discovery checks the vanilla installation, custom root, and
  nested Workshop mod roots. Texture packs from those roots participate in
  rendering and cache signatures with vanilla assets taking precedence.
- Save-object payloads for zombies, dead bodies, mannequins, animals, and
  hutches are structurally decoded with Build-specific moving, visual,
  inventory, genetics, and table readers. The renderer uses these readers to
  preserve chunk alignment while extracting the map sprites; animal wool/egg
  fields follow the vanilla Build 42 type/breed naming conventions.
- Save-game top-down squares use the same base, water, average, and Carto-Zed
  color rules as static-map top-down rendering.
- `save_games: all` filters discovered saves to the same Build 41/42 generation
  as the selected static map before parsing and rendering them.
- Player and survivor save objects now consume the non-zombie character schema,
  including ordered stats, conditional body damage and thermoregulator fields,
  XP maps, player nutrition/fitness data, known media, and craft history.
- The Angular builder's `Build Sample` action sets `sample_build`, renders one
  available static-map cell, skips save-game and mod-map work, and uses a
  reduced disk estimate. The same path can be exercised headlessly with
  `scripts/test-rust-map-sample.ps1 -PzRoot <ProjectZomboid> -OutputRoot <folder>`.
- Failed save chunks now include the chunk coordinate and parser error in
  `map_data/saves/<save>/index.json` under `parse_error_details`, while the
  optional `failed_chunks` copies preserve the original bytes for parity work.
- Build 42 ECS component blocks attached to ordinary objects and world
  inventory items are consumed from their length-delimited `GameEntity` frame;
  their component-specific fields are intentionally opaque because they do not
  affect map sprites. When `save_game_dump_failed_chunks` is enabled, chunks
  that still contain an unknown schema are copied to the save output's
  `failed_chunks` directory for inspection.

New render layers should add a module and expose a narrow function from the worker boundary. They should not add process management or duplicate image encoding logic.
