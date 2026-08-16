//! Version-aware Project Zomboid save chunk reader.
//!
//! This intentionally extracts only the information required by the map
//! renderer: layer masks and the primary sprite attached to each saved grid
//! object. Inventory, entity, and vehicle payloads are skipped structurally so
//! an unsupported payload cannot silently shift the reader into the next
//! square.

use std::fs;
use std::path::Path;

pub(crate) type ChunkResult<T> = Result<T, String>;

#[derive(Debug, Clone)]
pub(crate) struct SavedChunk {
    pub(crate) world_version: u32,
    pub(crate) block_size: usize,
    pub(crate) min_layer: i32,
    pub(crate) max_layer: i32,
    pub(crate) squares: Vec<SavedSquare>,
}

#[derive(Debug, Clone)]
pub(crate) struct SavedSquare {
    pub(crate) x: usize,
    pub(crate) y: usize,
    pub(crate) layers: Vec<(i32, Vec<i32>)>,
}

pub(crate) fn parse_file(path: &Path) -> ChunkResult<SavedChunk> {
    let data = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    parse(&data)
}

pub(crate) fn parse(data: &[u8]) -> ChunkResult<SavedChunk> {
    let mut reader = BigReader::new(data);
    let debug = reader.u8()?;
    let world_version = reader.u32()?;
    let _declared_size = reader.u32()?;
    let _crc = reader.u64()?;
    skip_chunk_header(&mut reader, world_version)?;

    let block_size = if world_version <= 195 { 10 } else { 8 };
    let (min_layer, max_layer) = if world_version <= 195 {
        (0, 8)
    } else if world_version < 206 {
        let max = reader.i32()?;
        let min = reader.i32()?;
        (min, max)
    } else {
        // IsoChunk defaults to the full eight Build 42 layers from v206
        // onward. The min/max integers are only serialized by older chunks.
        (0, 7)
    };

    let blood_count = reader.i32()?;
    if !(0..=100_000).contains(&blood_count) {
        return Err(format!(
            "Invalid save chunk blood-splat count: {blood_count}"
        ));
    }
    for _ in 0..blood_count {
        // IsoFloorBloodSplat.save writes three packed coordinates, a type,
        // world age, and an index: 1 + 1 + 1 + 1 + 4 + 1 bytes.
        reader.skip(9)?;
    }

    let mut squares = Vec::with_capacity(block_size * block_size);
    for x in 0..block_size {
        for y in 0..block_size {
            let layer_flags = if world_version > 195 {
                reader.u64()?
            } else {
                (reader.u8()? as u64) << 32
            };
            let mut saved = SavedSquare {
                x,
                y,
                layers: Vec::new(),
            };
            for layer in min_layer..=max_layer {
                let bit = layer + 32;
                if !(0..64).contains(&bit) || layer_flags & (1u64 << bit) == 0 {
                    continue;
                }
                let sprites = parse_grid_square(&mut reader, world_version, debug)?;
                if !sprites.is_empty() {
                    saved.layers.push((layer, sprites));
                }
            }
            squares.push(saved);
        }
    }
    Ok(SavedChunk {
        world_version,
        block_size,
        min_layer,
        max_layer,
        squares,
    })
}

fn skip_chunk_header(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    if world_version >= 209 {
        reader.skip(1)?;
    }
    if world_version >= 210 {
        let modified_mask = reader.u8()?;
        let partial = reader.u8()?;
        if partial != 0 && modified_mask != 0x0f {
            reader.skip(4)?;
        }
    }
    if world_version >= 214 {
        reader.skip(2)?;
    }
    if world_version >= 221 {
        let count = reader.u16()? as usize;
        reader.skip(count.saturating_mul(12))?;
    }
    Ok(())
}

fn parse_grid_square(
    reader: &mut BigReader<'_>,
    world_version: u32,
    debug: u8,
) -> ChunkResult<Vec<i32>> {
    let square_offset = reader.pos;
    skip_erosion_square(reader, world_version)?;
    let flags = reader.u8()?;
    if flags & 1 == 0 {
        return Ok(Vec::new());
    }
    if debug != 0 {
        reader.string_utf()?;
    }
    let object_count = if flags & 8 != 0 {
        reader.u16()? as usize
    } else if flags & 4 != 0 {
        3
    } else if flags & 2 != 0 {
        2
    } else if flags & 1 != 0 {
        1
    } else {
        0
    };
    let mut sprites = Vec::new();
    for _ in 0..object_count {
        // IsoGridSquare.save writes the per-object special/world-object
        // flags before the optional debug class name and IsoObject payload.
        reader.u8()?;
        if debug != 0 {
            reader.string_utf()?;
        }
        // IsoObject.factoryFromFileInput first reads the serialized-object
        // boolean and then the concrete factory id.
        if reader.u8()? == 0 {
            continue;
        }
        let class_id = reader.u8()? as u32;
        if let Some(sprite) = parse_object_class(reader, class_id, world_version, debug)
            .map_err(|error| format!("{error}; square offset {square_offset}"))?
        {
            sprites.push(sprite);
        }
    }
    if debug != 0 && flags & 1 != 0 {
        reader.expect(b"CRPS")?;
    }
    if flags & 64 != 0 {
        skip_grid_extra(reader, world_version, debug)?;
    }
    Ok(sprites)
}

fn skip_erosion_square(reader: &mut BigReader<'_>, _world_version: u32) -> ChunkResult<()> {
    let flags = reader.u8()?;
    if flags & 1 == 0 {
        return Ok(());
    }
    // ErosionData.Square.load reads noise-main, soil, and magic bytes before
    // the compact list of ErosionCategory::Data records.
    reader.skip(3)?;
    let count = if flags & 4 != 0 {
        1
    } else if flags & 8 != 0 {
        2
    } else if flags & 16 != 0 {
        3
    } else if flags & 32 != 0 {
        4
    } else if flags & 64 != 0 {
        reader.u8()? as usize
    } else {
        0
    };
    for _ in 0..count {
        reader.skip(3)?;
        let category_flags = reader.u8()?;
        if category_flags & 128 != 0 {
            reader.u8()?;
        }
    }
    Ok(())
}

fn parse_object_class(
    reader: &mut BigReader<'_>,
    class_id: u32,
    world_version: u32,
    debug: u8,
) -> ChunkResult<Option<i32>> {
    let sprite = if !matches!(class_id, 1 | 2 | 3 | 6 | 11 | 27 | 36) {
        let base_offset = reader.pos;
        parse_base_object(reader, world_version, debug)
            .map_err(|error| format!("{error}; base object offset {base_offset}"))?
    } else {
        None
    };
    skip_class_payload(reader, class_id, world_version, debug)?;
    Ok(sprite)
}

#[cfg(test)]
fn parse_object(
    reader: &mut BigReader<'_>,
    world_version: u32,
    debug: u8,
) -> ChunkResult<Option<i32>> {
    let serialize = reader.u8()?;
    if serialize == 0 {
        return Ok(None);
    }
    let class_id = reader.u8()? as u32;
    parse_object_class(reader, class_id, world_version, debug)
}

fn parse_base_object(
    reader: &mut BigReader<'_>,
    world_version: u32,
    debug: u8,
) -> ChunkResult<Option<i32>> {
    let sprite_id = reader.i32()?;
    let flags = reader.u8()?;
    let sprite_count = if flags & 3 == 3 {
        1
    } else if flags & 1 != 0 {
        reader.u8()? as usize
    } else {
        0
    };
    if debug != 0 && flags & 1 != 0 {
        reader.string_utf()?;
    }
    for _ in 0..sprite_count {
        skip_sprite(reader)?;
    }
    if flags & 4 != 0 {
        skip_sprite_name(reader)?;
    }
    if flags & 8 != 0 {
        reader.skip(3)?;
    }
    if flags & 64 != 0 {
        skip_extra_data(reader, world_version, debug)?;
    }
    Ok((sprite_id >= 0).then_some(sprite_id))
}

fn skip_sprite(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    reader.i32()?;
    let flags = reader.u8()?;
    if flags & 2 != 0 {
        reader.skip(15)?;
    }
    if flags & 16 != 0 {
        reader.skip(4)?;
    }
    Ok(())
}

fn skip_sprite_name(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    let flags = reader.u8()?;
    if flags & 4 != 0 || flags & 8 != 0 {
        if flags & 4 != 0 {
            reader.u8()?;
        } else {
            reader.string_utf()?;
        }
    }
    if flags & 16 != 0 || flags & 32 != 0 {
        if flags & 16 != 0 {
            reader.i32()?;
        } else {
            reader.string_utf()?;
        }
    }
    Ok(())
}

fn skip_extra_data(reader: &mut BigReader<'_>, world_version: u32, debug: u8) -> ChunkResult<()> {
    let flags = reader.u16()? as u64;
    if flags & 1 != 0 {
        let count = reader.u8()? as usize;
        reader.skip(count.saturating_mul(8))?;
    }
    if flags & 2 != 0 {
        if debug != 0 {
            reader.string_utf()?;
        }
        let count = reader.u8()? as usize;
        for _ in 0..count {
            skip_inventory_container(reader, world_version)?;
        }
    }
    if flags & 4 != 0 {
        skip_ktable(reader, 0, world_version)?;
    }
    if flags & 16 != 0 {
        reader.i32()?;
    }
    if flags & 64 != 0 {
        reader.f32()?;
    }
    if flags & 128 != 0 {
        reader.f32()?;
    }
    if flags & 256 != 0 {
        if flags & 512 == 0 {
            reader.i32()?;
        } else {
            reader.string_utf()?;
        }
    }
    if flags & 1024 != 0 {
        reader.skip(4)?;
    }
    if flags & 4096 != 0 {
        skip_entity_payload(reader)?;
    }
    if flags & 8192 != 0 {
        reader.string_utf()?;
    }
    Ok(())
}

fn skip_grid_extra(reader: &mut BigReader<'_>, world_version: u32, debug: u8) -> ChunkResult<()> {
    let flags = reader.u8()?;
    if flags & 1 != 0 {
        if debug != 0 {
            reader.string_utf()?;
        }
        let count = reader.u16()? as usize;
        for _ in 0..count {
            skip_object(reader, world_version, debug)?;
        }
    }
    if flags & 2 != 0 {
        skip_ktable(reader, 0, world_version)?;
    }
    if flags & 8 != 0 {
        reader.skip(12)?;
    }
    Ok(())
}

fn skip_object(reader: &mut BigReader<'_>, world_version: u32, debug: u8) -> ChunkResult<()> {
    reader.u8()?;
    if debug != 0 {
        reader.string_utf()?;
    }
    if reader.u8()? == 0 {
        return Ok(());
    }
    let class_id = reader.u8()? as u32;
    parse_object_class(reader, class_id, world_version, debug).map(|_| ())
}

fn skip_inventory_container(reader: &mut BigReader<'_>, _world_version: u32) -> ChunkResult<()> {
    // ItemContainer.load uses GameWindow.ReadString, an explored byte, and
    // CompressIdenticalItems.load. Each compressed group contains a signed
    // short group count, an i32 multiplicity, one size-prefixed item payload,
    // and (for duplicates) one i32 item id per additional item. The previous
    // reader treated the item payload as an arbitrary u32 blob, which could
    // consume the following character fields when an inventory was non-empty.
    reader.string_utf()?;
    reader.u8()?;
    let groups = bounded_count(reader.i16()? as i32, "inventory group", 32_767)?;
    for _ in 0..groups {
        let identical = bounded_count(reader.i32()?, "identical inventory item", 1_000_000)?;
        let item_size = bounded_count(reader.i32()?, "inventory item payload", 64 * 1024 * 1024)?;
        reader.skip(item_size)?;
        if identical > 1 {
            reader.skip((identical - 1).saturating_mul(4))?;
        }
    }
    reader.u8()?;
    reader.i32()?;
    Ok(())
}

fn skip_ktable(reader: &mut BigReader<'_>, depth: usize, world_version: u32) -> ChunkResult<()> {
    if depth > 32 {
        return Err("Nested save table is too deep.".into());
    }
    let count = reader.i32()?;
    if !(0..=1_000_000).contains(&count) {
        return Err(format!("Invalid save table count: {count}"));
    }
    for _ in 0..count {
        if world_version >= 25 {
            skip_kobject(reader, depth + 1, world_version)?;
        } else {
            // Before save version 25, Kahlua serialized every table key as a
            // type byte followed by a GameWindow string.
            reader.u8()?;
            reader.string_utf()?;
        }
        skip_kobject(reader, depth + 1, world_version)?;
    }
    Ok(())
}

fn skip_kobject(reader: &mut BigReader<'_>, depth: usize, world_version: u32) -> ChunkResult<()> {
    match reader.u8()? {
        0 => {
            reader.string_utf()?;
        }
        1 => {
            reader.f64()?;
        }
        2 => {
            skip_ktable(reader, depth, world_version)?;
        }
        3 => {
            reader.u8()?;
        }
        value => return Err(format!("Unsupported save table value type: {value}")),
    }
    Ok(())
}

fn skip_class_payload(
    reader: &mut BigReader<'_>,
    class_id: u32,
    world_version: u32,
    debug: u8,
) -> ChunkResult<()> {
    match class_id {
        0 | 7 | 20 | 30 | 31 | 40 => {}
        6 => {
            reader.skip(5 * 4)?;
            skip_sized_blob(reader)?;
            reader.f64()?;
            let flags = reader.u8()?;
            if flags & 2 != 0 {
                skip_entity_payload(reader)?;
            }
        }
        4 | 5 => {
            if class_id == 4 {
                reader.i32()?;
            }
            if reader.u8()? != 0 {
                skip_inventory_container(reader, world_version)?;
            }
        }
        8 => {
            reader.skip(1 + 1 + 4 + 4 + 4)?;
        }
        9 | 10 => skip_wave_signal(reader)?,
        12 => {
            reader.u8()?;
            reader.i32()?;
            reader.u8()?;
            reader.f32()?;
            reader.i32()?;
            if reader.u8()? != 0 {
                reader.i32()?;
            }
            if reader.u8()? != 0 {
                reader.i32()?;
            }
        }
        13 => {
            reader.u8()?;
        }
        14 => {
            reader.u8()?;
            reader.f32()?;
        }
        15 => {
            reader.i32()?;
            reader.u8()?;
            reader.f32()?;
            reader.i32()?;
        }
        16 => {
            reader.u8()?;
            reader.i32()?;
            reader.f32()?;
            reader.u8()?;
            reader.u8()?;
        }
        17 => {
            reader.skip(3 + 5 * 4 + 2)?;
        }
        18 => skip_thumpable(reader, world_version)?,
        19 => {
            reader.skip(6 * 4)?;
            if world_version >= 219 {
                reader.skip(4 + 4)?;
            }
            reader.skip(7 * 4)?;
            reader.string_utf()?;
            reader.string_utf()?;
            if reader.u8()? != 0 {
                skip_sized_blob(reader)?;
            }
        }
        21 => {
            if reader.u8()? != 0 {
                skip_sized_blob(reader)?;
            }
            if reader.u8()? != 0 {
                skip_sized_blob(reader)?;
            }
            reader.skip(1 + 4 + 4)?;
        }
        22 => {
            reader.skip(2 + 4 + 2 * 4)?;
        }
        23 => {
            reader.skip(8)?;
            if world_version >= 213 {
                reader.skip(8)?;
            }
        }
        26 => {
            reader.skip(1 + 1 + 4 + 1 + 1 + 1 + 1)?;
            if reader.u8()? != 0 {
                reader.skip(4)?;
            }
            if reader.u8()? != 0 {
                reader.skip(4)?;
            }
            if reader.u8()? != 0 {
                reader.skip(4)?;
            }
            if reader.u8()? != 0 {
                reader.skip(4)?;
            }
            reader.skip(4)?;
        }
        25 => skip_window(reader)?,
        27 => {
            reader.skip(2)?;
            let count = reader.u8()? as usize;
            reader.skip(count.saturating_mul(2) + 4)?;
        }
        28 => {
            reader.skip(2)?;
        }
        29 => skip_light_switch(reader, world_version)?,
        32 => {
            reader.skip(9 * 4 + 3)?;
        }
        33 => skip_combination_washer_dryer(reader)?,
        34 | 35 => {
            if class_id == 34 {
                reader.u8()?;
            }
            reader.u8()?;
            reader.u8()?;
            reader.f32()?;
        }
        37 => {
            let count = reader.i32()?;
            if !(0..=100_000).contains(&count) {
                return Err(format!("Invalid feeding-trough type count: {count}"));
            }
            for _ in 0..count {
                reader.string_utf()?;
                reader.f32()?;
            }
            reader.f32()?;
            if reader.u8()? != 0 {
                reader.skip(2 * 4)?;
            }
            reader.u8()?;
        }
        39 => {
            reader.string_utf()?;
            reader.string_utf()?;
            reader.skip(2 * 4)?;
            if reader.u8()? != 0 {
                reader.i32()?;
            }
            reader.i64()?;
            reader.u8()?;
        }
        41 => {
            reader.u8()?;
        }
        3 => skip_zombie(reader, world_version)?,
        1 | 2 => skip_human_character(reader, class_id, world_version)?,
        11 => skip_dead_body(reader, world_version, debug)?,
        24 => skip_mannequin(reader, world_version)?,
        36 => skip_animal(reader, world_version)?,
        38 => skip_hutch(reader, world_version)?,
        _ => {
            return Err(format!(
                "Unknown saved object class {class_id} at offset {}",
                reader.pos.saturating_sub(1)
            ));
        }
    }
    let _ = debug;
    Ok(())
}

fn bounded_count(value: i32, label: &str, max: i32) -> ChunkResult<usize> {
    if !(0..=max).contains(&value) {
        return Err(format!("Invalid {label} count: {value}"));
    }
    Ok(value as usize)
}

fn skip_moving_payload(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    // IsoMovingObject.load after IsoObject.load: offsetX, offsetY, x, y, z,
    // direction, and the optional mod-data table.
    reader.skip(5 * 4 + 4)?;
    if reader.u8()? != 0 {
        skip_ktable(reader, 0, world_version)?;
    }
    Ok(())
}

fn skip_survivor_desc(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    reader.i32()?;
    reader.string_utf()?;
    reader.string_utf()?;
    reader.string_utf()?;
    reader.i32()?;
    reader.string_utf()?;
    if reader.i32()? != 0 {
        let count = bounded_count(reader.i32()?, "survivor extra", 100_000)?;
        for _ in 0..count {
            reader.string_utf()?;
        }
    }
    let count = bounded_count(reader.i32()?, "survivor XP boost", 100_000)?;
    for _ in 0..count {
        reader.string_utf()?;
        reader.i32()?;
    }
    if world_version >= 208 {
        reader.string_utf()?;
        reader.f32()?;
        reader.i32()?;
    }
    Ok(())
}

fn skip_byte_array(reader: &mut BigReader<'_>, label: &str) -> ChunkResult<()> {
    let count = reader.u8()? as usize;
    if count > 255 {
        return Err(format!("Invalid {label} byte-array length: {count}"));
    }
    reader.skip(count)
}

fn skip_item_visual(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    let flags = reader.u8()?;
    reader.string_utf()?;
    reader.string_utf()?;
    reader.string_utf()?;
    if flags & 1 != 0 {
        reader.skip(3)?;
    }
    if flags & 2 != 0 {
        reader.u8()?;
    }
    if flags & 4 != 0 {
        reader.u8()?;
    }
    if flags & 8 != 0 {
        reader.f32()?;
    }
    if flags & 16 != 0 {
        reader.string_utf()?;
    }
    for label in [
        "item blood",
        "item dirt",
        "item holes",
        "item basic patches",
        "item denim patches",
        "item leather patches",
    ] {
        skip_byte_array(reader, label)?;
    }
    Ok(())
}

fn skip_human_visual(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    let flags = reader.u8()?;
    for bit in [4u8, 2, 8] {
        if flags & bit != 0 {
            reader.skip(3)?;
        }
    }
    reader.skip(3)?;
    for bit in [64u8, 16, 32] {
        if flags & bit != 0 {
            reader.string_utf()?;
        }
    }
    skip_byte_array(reader, "human blood")?;
    skip_byte_array(reader, "human dirt")?;
    skip_byte_array(reader, "human holes")?;
    let body_visual_count = reader.u8()? as usize;
    for _ in 0..body_visual_count {
        skip_item_visual(reader)?;
    }
    reader.string_utf()?;
    let natural_flags = reader.u8()?;
    if natural_flags & 4 != 0 {
        reader.skip(3)?;
    }
    if natural_flags & 2 != 0 {
        reader.skip(3)?;
    }
    Ok(())
}

fn skip_animal_visual(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    reader.string_utf()?;
    reader.u8()?;
    Ok(())
}

fn skip_character_common(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    reader.u8()?;
    reader.skip(8 * 4)?;
    let read_books = bounded_count(reader.i32()?, "read book", 100_000)?;
    for _ in 0..read_books {
        reader.string_utf()?;
        reader.i32()?;
    }
    reader.f32()?;
    let recipes = bounded_count(reader.i32()?, "known recipe", 100_000)?;
    for _ in 0..recipes {
        reader.string_utf()?;
    }
    reader.i32()?;
    reader.skip(3 * 4)?;
    reader.skip(6)?; // unlimited carry, build, health, mechanics, movables, farming
    if world_version >= 202 {
        reader.u8()?;
    }
    if world_version >= 217 {
        reader.skip(2)?;
    }
    reader.skip(2)?; // timed action and unlimited endurance
    if world_version >= 230 {
        reader.skip(2)?;
    }
    reader.skip(2)?; // sneaking and death drag-down
    let literature = bounded_count(reader.i32()?, "read literature", 100_000)?;
    for _ in 0..literature {
        reader.string_utf()?;
        reader.i32()?;
    }
    if world_version >= 222 {
        let print_media = bounded_count(reader.i32()?, "read print media", 100_000)?;
        for _ in 0..print_media {
            reader.string_utf()?;
        }
    }
    reader.i64()?;
    if world_version >= 231 {
        let cheats = bounded_count(reader.i32()?, "player cheat", 100_000)?;
        reader.skip(cheats)?;
    }
    Ok(())
}

fn skip_game_character(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    skip_moving_payload(reader, world_version)?;
    if reader.u8()? != 0 {
        skip_survivor_desc(reader, world_version)?;
    }
    skip_human_visual(reader)?;
    skip_inventory_container(reader, world_version)?;
    reader.u8()?;
    reader.f32()?;
    // IsoGameCharacter stores the equipped item ids before the common
    // character tail. They are not inventory payloads and must still be
    // consumed for zombie saves.
    reader.i32()?;
    reader.i32()?;
    skip_character_common(reader, world_version)
}

fn skip_human_character(
    reader: &mut BigReader<'_>,
    class_id: u32,
    world_version: u32,
) -> ChunkResult<()> {
    // Players and survivors use the same IsoGameCharacter prefix as zombies,
    // but non-zombies additionally serialize Stats, BodyDamage, and XP before
    // the common character fields.  Keep these readers structural: none of
    // the values are needed by the map renderer.
    skip_moving_payload(reader, world_version)?;
    if reader.u8()? != 0 {
        skip_survivor_desc(reader, world_version)?;
    }
    skip_human_visual(reader)?;
    skip_inventory_container(reader, world_version)?;
    reader.u8()?;
    reader.f32()?;
    skip_stats(reader)?;
    skip_body_damage(reader, world_version)?;
    skip_xp(reader)?;
    reader.i32()?;
    reader.i32()?;
    skip_character_common(reader, world_version)?;
    if class_id == 1 {
        skip_player_tail(reader)?;
    }
    Ok(())
}

fn skip_stats(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    // CharacterStat.ORDERED_STATS in the current Build 42 jar.
    reader.skip(24 * 4)
}

fn skip_body_damage(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    // BodyDamage serializes the 17 BodyPart entries in fixed order.  Several
    // fields are conditional on the preceding boolean, so skipping a fixed
    // byte count would misalign the next object.
    for _ in 0..17 {
        reader.u8()?;
        reader.u8()?;
        reader.u8()?;
        let bandaged = reader.u8()? != 0;
        reader.u8()?;
        reader.u8()?;
        reader.u8()?;
        reader.u8()?;
        reader.f32()?;
        if bandaged {
            reader.f32()?;
        }
        if reader.u8()? != 0 {
            reader.f32()?;
        }
        reader.skip(7 * 4)?;
        reader.skip(3)?;
        reader.f32()?;
        reader.skip(2)?;
        reader.f32()?;
        if reader.u8()? != 0 {
            reader.f32()?;
        }
        reader.u8()?;
        reader.f32()?;
        reader.u8()?;
        reader.f32()?;
        reader.string_utf()?;
        reader.string_utf()?;
        reader.skip(6 * 4)?;
    }

    reader.f32()?;
    reader.u8()?;
    reader.f32()?;
    if world_version >= 222 {
        reader.i32()?;
    }
    reader.u8()?;
    reader.skip(6 * 4)?;
    if reader.u8()? != 0 {
        skip_thermoregulator(reader, world_version)?;
    }
    Ok(())
}

fn skip_thermoregulator(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    reader.skip(2 * 4)?;
    if world_version >= 243 {
        reader.f32()?;
    }
    reader.skip(5 * 4)?;
    if world_version >= 249 {
        reader.f32()?;
    }
    let nodes = bounded_count(reader.i32()?, "thermal node", 100_000)?;
    for _ in 0..nodes {
        reader.i32()?;
        reader.skip(9 * 4)?;
    }
    Ok(())
}

fn skip_xp(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    let traits = bounded_count(reader.i32()?, "character trait", 100_000)?;
    for _ in 0..traits {
        reader.string_utf()?;
    }
    reader.f32()?;
    reader.i32()?;
    reader.i32()?;
    skip_perk_float_map(reader, "XP")?;
    skip_perk_level_list(reader, "perk")?;
    let multipliers = bounded_count(reader.i32()?, "XP multiplier", 100_000)?;
    for _ in 0..multipliers {
        reader.string_utf()?;
        reader.f32()?;
        reader.skip(2)?;
    }
    Ok(())
}

fn skip_perk_float_map(reader: &mut BigReader<'_>, label: &str) -> ChunkResult<()> {
    let count = bounded_count(reader.i32()?, &format!("{label} map"), 100_000)?;
    for _ in 0..count {
        reader.string_utf()?;
        reader.f32()?;
    }
    Ok(())
}

fn skip_perk_level_list(reader: &mut BigReader<'_>, label: &str) -> ChunkResult<()> {
    let count = bounded_count(reader.i32()?, &format!("{label} list"), 100_000)?;
    for _ in 0..count {
        reader.string_utf()?;
        reader.i32()?;
    }
    Ok(())
}

fn skip_player_tail(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    reader.f64()?;
    reader.i32()?;
    let worn = reader.u8()? as usize;
    for _ in 0..worn {
        reader.string_utf()?;
        reader.i16()?;
    }
    reader.skip(2 + 2 + 4)?;
    reader.skip(5 * 4)?; // Nutrition
    reader.u8()?;
    reader.string_utf()?;
    reader.skip(3 * 4)?;
    reader.string_utf()?;
    reader.skip(4)?;
    if reader.u8()? != 0 {
        reader.skip(2 * 4 + 2)?;
    }
    let mechanics = bounded_count(reader.i32()?, "mechanics item", 100_000)?;
    reader.skip(mechanics.saturating_mul(16))?;
    skip_fitness(reader)?;
    let books = reader.i16()?;
    if books < 0 {
        return Err(format!("Invalid already-read book count: {books}"));
    }
    reader.skip(books as usize * 2)?;
    let media = reader.i16()?;
    if media < 0 {
        return Err(format!("Invalid known media line count: {media}"));
    }
    for _ in 0..media {
        reader.string_utf()?;
    }
    reader.u8()?;
    skip_craft_history(reader)
}

fn skip_fitness(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    skip_perk_float_map(reader, "fitness stiffness increase")?;
    skip_perk_level_list(reader, "fitness stiffness timer")?;
    skip_perk_float_map(reader, "fitness regularity")?;
    let body_parts = bounded_count(reader.i32()?, "fitness body part", 100_000)?;
    for _ in 0..body_parts {
        reader.string_utf()?;
    }
    let timers = bounded_count(reader.i32()?, "fitness execution timer", 100_000)?;
    for _ in 0..timers {
        reader.string_utf()?;
        reader.i64()?;
    }
    Ok(())
}

fn skip_craft_history(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    let entries = bounded_count(reader.i32()?, "craft history", 100_000)?;
    for _ in 0..entries {
        let chars = bounded_count(reader.i32()?, "craft history key", 1_000_000)?;
        reader.skip(chars.saturating_mul(2))?;
        reader.i32()?;
        reader.f64()?;
    }
    Ok(())
}

fn skip_zombie(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    skip_game_character(reader, world_version)?;
    reader.i32()?;
    reader.i32()?;
    reader.i32()?;
    let worn = reader.u8()? as usize;
    for _ in 0..worn {
        reader.string_utf()?;
        reader.i16()?;
    }
    Ok(())
}

fn skip_animal_gene(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    reader.i32()?;
    reader.string_utf()?;
    for _ in 0..2 {
        reader.string_utf()?;
        reader.skip(2 * 4 + 1)?;
        reader.string_utf()?;
    }
    Ok(())
}

fn skip_animal(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    reader.skip(2 * 8 + 3 * 4 + 4)?;
    reader.skip(24 * 4)?; // Stats.ORDERED_STATS in Build 42
    let animal_type = reader.string_utf()?.to_ascii_lowercase();
    let breed = reader.string_utf()?.to_ascii_lowercase();
    reader.string_utf()?;
    skip_ktable(reader, 0, world_version)?;
    reader.i32()?;
    reader.u8()?;
    reader.i32()?;
    let genes = bounded_count(reader.i32()?, "animal gene", 100_000)?;
    for _ in 0..genes {
        skip_animal_gene(reader)?;
    }
    if reader.u8()? != 0 {
        reader.skip(2 * 4)?;
    }
    reader.i32()?;
    reader.f64()?;
    reader.i64()?;
    reader.f32()?;
    reader.i32()?;
    if reader.u8()? != 0 {
        reader.i32()?;
    }
    let pregnant = reader.u8()? != 0;
    if pregnant {
        reader.i32()?;
    }
    reader.u8()?;
    reader.skip(2 * 4 + 4)?;
    reader.u8()?;
    if animal_type.contains("sheep") || breed.contains("wool") {
        reader.f32()?;
    }
    reader.i32()?;
    reader.u8()?;
    if animal_type.contains("chicken")
        || animal_type.contains("hen")
        || animal_type.contains("rooster")
        || breed.contains("egg")
    {
        reader.i32()?;
    }
    reader.f32()?;
    let acceptance = bounded_count(reader.i32()?, "animal player acceptance", 100_000)?;
    reader.skip(acceptance.saturating_mul(2 + 4))?;
    reader.f32()?;
    reader.i64()?;
    reader.i64()?;
    reader.i32()?;
    reader.f32()?;
    reader.f64()?;
    reader.string_utf()?;
    reader.i32()?;
    if reader.u8()? != 0 {
        reader.skip(3 * 4)?;
    }
    if world_version >= 236 {
        reader.f32()?;
    }
    if world_version >= 245 {
        reader.u8()?;
    }
    if world_version >= 247 {
        reader.i16()?;
    }
    Ok(())
}

fn skip_dead_body(reader: &mut BigReader<'_>, world_version: u32, _debug: u8) -> ChunkResult<()> {
    skip_moving_payload(reader, world_version)?;
    reader.u8()?;
    reader.u8()?;
    let is_animal = reader.u8()? != 0;
    if is_animal {
        reader.string_utf()?;
        reader.f32()?;
        if world_version >= 246 {
            let genes = reader.u8()? as usize;
            for _ in 0..genes {
                skip_animal_gene(reader)?;
            }
            let disorders = reader.u8()? as usize;
            for _ in 0..disorders {
                reader.string_utf()?;
            }
        }
    }
    reader.string_utf()?;
    reader.string_utf()?;
    reader.f32()?;
    reader.string_utf()?;
    reader.skip(3 * 4)?;
    if world_version >= 199 {
        reader.u8()?; // ObjectID type
    } else {
        reader.i16()?;
    }
    if reader.u8()? != 0 {
        reader.i32()?;
    }
    if reader.u8()? != 0 {
        skip_survivor_desc(reader, world_version)?;
    }
    match reader.u8()? {
        0 => skip_human_visual(reader)?,
        1 => skip_animal_visual(reader)?,
        value => return Err(format!("Invalid corpse visual type: {value}")),
    }
    if reader.u8()? != 0 {
        reader.i32()?;
        skip_inventory_container(reader, world_version)?;
        let worn = reader.u8()? as usize;
        for _ in 0..worn {
            reader.string_utf()?;
            reader.i16()?;
        }
        let attached = reader.u8()? as usize;
        for _ in 0..attached {
            reader.string_utf()?;
            reader.i16()?;
        }
    }
    reader.skip(2 * 4)?;
    let _fall_flags = reader.u8()?;
    reader.u8()?;
    reader.f32()?;
    reader.u8()?;
    if world_version >= 222 {
        reader.u8()?;
    }
    if world_version >= 225 {
        reader.string_utf()?;
        reader.string_utf()?;
    }
    reader.u8()?; // crawling
    reader.u8()?; // fake-dead
    let ragdoll_fall = reader.u8()? != 0;
    if ragdoll_fall {
        let transforms = bounded_count(reader.i32()?, "corpse bone transform", 100_000)?;
        reader.skip(transforms.saturating_mul(4 + 3 * 4 + 4 * 4 + 3 * 4))?;
    }
    Ok(())
}

fn skip_mannequin(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    reader.skip(5)?;
    reader.string_utf()?;
    reader.string_utf()?;
    skip_human_visual(reader)?;
    if reader.u8()? != 0 {
        reader.i32()?;
        skip_inventory_container(reader, world_version)?;
        let worn = reader.u8()? as usize;
        for _ in 0..worn {
            reader.string_utf()?;
            reader.i16()?;
        }
    }
    Ok(())
}

fn skip_hutch(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    let linked_x = reader.i32()?;
    let linked_y = reader.i32()?;
    reader.i32()?;
    if linked_x > 0 && linked_y > 0 {
        return Ok(());
    }
    if world_version >= 204 {
        reader.string_utf()?;
    }
    reader.u8()?;
    if world_version >= 204 {
        reader.u8()?;
    }
    reader.skip(3 * 4)?;
    if world_version >= 212 {
        let size = reader.i32()?;
        if size < 0 {
            return Err(format!("Invalid hutch animal payload size: {size}"));
        }
        reader.skip(size as usize)?;
    } else {
        let animals = reader.u8()? as usize;
        for _ in 0..animals {
            reader.u8()?;
            reader.u8()?;
            skip_animal(reader, world_version)?;
        }
    }
    reader.skip(2 * 4)?;
    let nests = reader.u8()? as usize;
    for _ in 0..nests {
        let eggs = reader.u8()? as usize;
        for _ in 0..eggs {
            skip_sized_blob(reader)?;
        }
    }
    Ok(())
}

fn skip_sized_blob(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    let size = reader.u32()? as usize;
    reader.skip(size)
}

fn skip_entity_payload(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    // GameEntity.saveEntity writes a byte component count followed by one
    // ByteBlock per component. Each block is a u32 byte length and contains
    // the component type (u16) plus its version-specific payload. The
    // renderer does not need component fields, but consuming the blocks
    // preserves alignment for the following IsoObject fields and squares.
    let count = reader.u8()? as usize;
    for _ in 0..count {
        let size = reader.u32()? as usize;
        if size < 2 {
            return Err(format!("Invalid saved entity component block size: {size}"));
        }
        reader.skip(size)?;
    }
    Ok(())
}

fn skip_window(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    // IsoWindow.load: open, north, health, locked, permaLocked, destroyed,
    // glassRemoved, optional sprite ids, and maxHealth.
    reader.skip(2 + 4 + 4)?;
    for _ in 0..4 {
        if reader.u8()? != 0 {
            reader.i32()?;
        }
    }
    reader.i32()?;
    Ok(())
}

fn skip_combination_washer_dryer(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    // IsoCombinationWasherDryer.load delegates to the washer and dryer logic.
    reader.skip(1 + 1 + 4 + 1)
}

fn skip_wave_signal(reader: &mut BigReader<'_>) -> ChunkResult<()> {
    if reader.u8()? == 0 {
        return Ok(());
    }
    reader.string_utf()?;
    reader.u8()?;
    reader.i32()?;
    reader.i32()?;
    reader.u8()?;
    reader.f32()?;
    reader.f32()?;
    reader.skip(4)?;
    reader.i32()?;
    reader.i32()?;
    reader.i32()?;
    reader.skip(2)?;
    reader.f32()?;
    reader.f32()?;
    reader.i32()?;
    if reader.u8()? != 0 {
        let _max = reader.i32()?;
        let count = reader.i32()?;
        for _ in 0..count.max(0) {
            reader.string_utf()?;
            reader.i32()?;
        }
    }
    reader.skip(2 + 1)?;
    if reader.u8()? != 0 {
        reader.string_utf()?;
    }
    reader.u8()?;
    Ok(())
}

fn skip_thumpable(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    let flags = reader.u64()?;
    let fields: &[(u64, usize)] = &[
        (8, 4),
        (16, 4),
        (32, 4),
        (64, 4),
        (128, 4),
        (1 << 20, 4),
        (1 << 26, 4),
        (1 << 27, 4),
        (1 << 28, 4),
        (1 << 29, 4),
        (1 << 30, 2),
        (1 << 31, 4),
        (1 << 32, 4),
        (1 << 33, 4),
        (1 << 37, 4),
        (1 << 39, 4),
    ];
    for (bit, bytes) in fields {
        if flags & bit != 0 {
            reader.skip(*bytes)?;
        }
    }
    if flags & (1 << 21) != 0 {
        skip_ktable(reader, 0, world_version)?;
    }
    if flags & (1 << 22) != 0 {
        skip_ktable(reader, 0, world_version)?;
    }
    if flags & (1 << 38) != 0 {
        reader.string_utf()?;
    }
    if flags & (1 << 42) != 0 {
        skip_ktable(reader, 0, world_version)?;
    }
    Ok(())
}

fn skip_light_switch(reader: &mut BigReader<'_>, world_version: u32) -> ChunkResult<()> {
    reader.u8()?;
    if world_version >= 206 {
        reader.i64()?;
    } else {
        reader.i32()?;
    }
    reader.u8()?;
    let can_be_modified = reader.u8()?;
    if can_be_modified != 0 {
        let _use_battery = reader.u8()?;
        let _has_battery = reader.u8()?;
        let bulb_present = reader.u8()?;
        if bulb_present != 0 {
            reader.string_utf()?;
        }
        reader.skip(5 * 4)?;
    }
    reader.i64()?;
    reader.i32().map(|_| ())
}

struct BigReader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> BigReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }
    fn ensure(&self, count: usize) -> ChunkResult<()> {
        self.pos
            .checked_add(count)
            .filter(|end| *end <= self.data.len())
            .map(|_| ())
            .ok_or_else(|| format!("Unexpected end of save chunk at offset {}.", self.pos))
    }
    fn bytes(&mut self, count: usize) -> ChunkResult<&'a [u8]> {
        self.ensure(count)?;
        let start = self.pos;
        self.pos += count;
        Ok(&self.data[start..self.pos])
    }
    fn skip(&mut self, count: usize) -> ChunkResult<()> {
        self.bytes(count).map(|_| ())
    }
    fn expect(&mut self, expected: &[u8]) -> ChunkResult<()> {
        if self.bytes(expected.len())? == expected {
            Ok(())
        } else {
            Err("Unexpected save chunk signature.".into())
        }
    }
    fn u8(&mut self) -> ChunkResult<u8> {
        Ok(self.bytes(1)?[0])
    }
    fn u16(&mut self) -> ChunkResult<u16> {
        Ok(u16::from_be_bytes(self.bytes(2)?.try_into().unwrap()))
    }
    fn i16(&mut self) -> ChunkResult<i16> {
        Ok(i16::from_be_bytes(self.bytes(2)?.try_into().unwrap()))
    }
    fn i32(&mut self) -> ChunkResult<i32> {
        Ok(i32::from_be_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> ChunkResult<u32> {
        Ok(u32::from_be_bytes(self.bytes(4)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> ChunkResult<i64> {
        Ok(i64::from_be_bytes(self.bytes(8)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> ChunkResult<u64> {
        Ok(u64::from_be_bytes(self.bytes(8)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> ChunkResult<f32> {
        Ok(f32::from_bits(self.u32()?))
    }
    fn f64(&mut self) -> ChunkResult<f64> {
        Ok(f64::from_bits(self.u64()?))
    }
    fn string_utf(&mut self) -> ChunkResult<String> {
        // GameWindow.StringUTF.load treats non-positive signed lengths as an
        // empty string and does not consume a payload.  Build 42 uses this
        // sentinel in a few optional visual fields, so reading it as an
        // unsigned length would turn a valid empty field into a huge skip.
        let len = self.i16()?;
        if len <= 0 {
            return Ok(String::new());
        }
        let len = len as usize;
        Ok(String::from_utf8_lossy(self.bytes(len)?).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_u8(data: &mut Vec<u8>, value: u8) {
        data.push(value);
    }

    fn push_u32(data: &mut Vec<u8>, value: u32) {
        data.extend_from_slice(&value.to_be_bytes());
    }

    fn push_u64(data: &mut Vec<u8>, value: u64) {
        data.extend_from_slice(&value.to_be_bytes());
    }

    fn push_i32(data: &mut Vec<u8>, value: i32) {
        data.extend_from_slice(&value.to_be_bytes());
    }

    fn push_i16(data: &mut Vec<u8>, value: i16) {
        data.extend_from_slice(&value.to_be_bytes());
    }

    fn push_i64(data: &mut Vec<u8>, value: i64) {
        data.extend_from_slice(&value.to_be_bytes());
    }

    fn push_f32(data: &mut Vec<u8>, value: f32) {
        data.extend_from_slice(&value.to_bits().to_be_bytes());
    }

    fn push_f64(data: &mut Vec<u8>, value: f64) {
        data.extend_from_slice(&value.to_bits().to_be_bytes());
    }

    fn push_utf(data: &mut Vec<u8>, value: &str) {
        data.extend_from_slice(&(value.len() as u16).to_be_bytes());
        data.extend_from_slice(value.as_bytes());
    }

    fn push_zero_human_visual(data: &mut Vec<u8>) {
        data.push(0);
        data.extend_from_slice(&[0; 3]);
        data.extend_from_slice(&[0; 3]);
        data.push(0);
        push_utf(data, "");
        data.push(0);
    }

    fn push_zero_moving_payload(data: &mut Vec<u8>) {
        data.extend_from_slice(&[0; 5 * 4 + 4]);
        data.push(0);
    }

    fn empty_chunk(version: u32) -> Vec<u8> {
        let block_size = if version <= 195 { 10 } else { 8 };
        let mut data = Vec::new();
        push_u8(&mut data, 0);
        push_u32(&mut data, version);
        push_u32(&mut data, 0);
        push_u64(&mut data, 0);
        if (196..206).contains(&version) {
            push_u32(&mut data, 7);
            push_u32(&mut data, 0);
        }
        push_u32(&mut data, 0);
        for _ in 0..block_size * block_size {
            if version <= 195 {
                push_u8(&mut data, 0);
            } else {
                push_u64(&mut data, 0);
            }
        }
        data
    }

    #[test]
    fn parses_external_b42_fixture_when_requested() {
        let Some(path) = std::env::var_os("PZ_B42_SAVE_CHUNK") else {
            return;
        };
        let data = fs::read(path).expect("external B42 fixture should be readable");
        let parsed = parse(&data).expect("external B42 fixture should parse");
        assert_eq!(parsed.world_version, 249);
        assert_eq!(parsed.block_size, 8);
    }

    #[test]
    fn parses_empty_b41_chunk() {
        let parsed = parse(&empty_chunk(195)).expect("empty B41 chunk should parse");
        assert_eq!(parsed.block_size, 10);
        assert_eq!(parsed.squares.len(), 100);
        assert!(parsed.squares.iter().all(|square| square.layers.is_empty()));
    }

    #[test]
    fn parses_empty_b42_chunk_with_levels() {
        let parsed = parse(&empty_chunk(206)).expect("empty B42 chunk should parse");
        assert_eq!(parsed.block_size, 8);
        assert_eq!(parsed.min_layer, 0);
        assert_eq!(parsed.max_layer, 7);
        assert_eq!(parsed.squares.len(), 64);
    }

    #[test]
    fn rejects_truncated_chunk() {
        let error = parse(&empty_chunk(195)[..20]).expect_err("truncated input must fail");
        assert!(error.contains("Unexpected end"));
    }

    #[test]
    fn skips_world_inventory_and_feeding_trough_payloads() {
        let mut inventory = vec![1, 6];
        inventory.extend_from_slice(&[0; 20]);
        inventory.extend_from_slice(&0u32.to_be_bytes());
        inventory.extend_from_slice(&0f64.to_be_bytes());
        inventory.push(0);
        assert_eq!(
            parse_object(&mut BigReader::new(&inventory), 249, 0).unwrap(),
            None
        );

        let mut trough = vec![1, 37];
        trough.extend_from_slice(&(-1i32).to_be_bytes());
        trough.push(0);
        trough.extend_from_slice(&0i32.to_be_bytes());
        trough.extend_from_slice(&0f32.to_be_bytes());
        trough.push(0);
        trough.push(0);
        assert_eq!(
            parse_object(&mut BigReader::new(&trough), 249, 0).unwrap(),
            None
        );
    }

    #[test]
    fn skips_size_prefixed_inventory_groups_without_shifting_reader() {
        let mut payload = Vec::new();
        push_utf(&mut payload, "bag");
        payload.push(1); // explored
        push_i16(&mut payload, 1); // compressed groups
        push_i32(&mut payload, 2); // identical items
        push_i32(&mut payload, 3); // size-prefixed item payload
        payload.extend_from_slice(&[0xaa, 0xbb, 0xcc]);
        push_i32(&mut payload, 101); // duplicate item id
        payload.push(0); // has been looted
        push_i32(&mut payload, 20); // capacity

        let mut reader = BigReader::new(&payload);
        skip_inventory_container(&mut reader, 249).expect("inventory groups should parse");
        assert_eq!(reader.pos, payload.len());
    }

    #[test]
    fn signed_empty_string_sentinel_does_not_consume_following_bytes() {
        let mut reader = BigReader::new(&[0xf0, 0x27, 0x7f]);
        assert_eq!(reader.string_utf().expect("sentinel string"), "");
        assert_eq!(reader.u8().expect("following byte"), 0x7f);
    }

    #[test]
    fn skips_entity_component_blocks_without_shifting_reader() {
        let mut payload = vec![2];
        payload.extend_from_slice(&5u32.to_be_bytes());
        payload.extend_from_slice(&[0, 17, 1, 2, 3]);
        payload.extend_from_slice(&2u32.to_be_bytes());
        payload.extend_from_slice(&[0, 23]);
        let mut reader = BigReader::new(&payload);
        skip_entity_payload(&mut reader).expect("entity component blocks should parse");
        assert_eq!(reader.pos, payload.len());
    }

    #[test]
    fn rejects_empty_entity_component_blocks() {
        let payload = [1, 0, 0, 0, 1];
        let error = skip_entity_payload(&mut BigReader::new(&payload))
            .expect_err("component blocks must include their type id");
        assert!(error.contains("component block size"));
    }

    #[test]
    fn skips_window_and_combination_washer_payloads() {
        let mut window = vec![1, 25];
        window.extend_from_slice(&0i32.to_be_bytes());
        window.push(0);
        window.extend_from_slice(&[0, 0]);
        window.extend_from_slice(&0i32.to_be_bytes());
        window.extend_from_slice(&[0, 0, 0, 0]);
        window.extend_from_slice(&[0, 0, 0, 0]);
        window.extend_from_slice(&100i32.to_be_bytes());
        assert_eq!(
            parse_object(&mut BigReader::new(&window), 249, 0).unwrap(),
            Some(0)
        );

        let mut washer_dryer = vec![1, 33];
        washer_dryer.extend_from_slice(&0i32.to_be_bytes());
        washer_dryer.push(0);
        washer_dryer.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(
            parse_object(&mut BigReader::new(&washer_dryer), 249, 0).unwrap(),
            Some(0)
        );
    }

    #[test]
    fn skips_zombie_payload_without_shifting_the_reader() {
        let mut payload = Vec::new();
        push_zero_moving_payload(&mut payload);
        payload.push(0); // descriptor
        push_zero_human_visual(&mut payload);
        push_utf(&mut payload, "inventory");
        payload.push(0); // explored
        payload.extend_from_slice(&0u16.to_be_bytes());
        payload.push(0); // has-been-looted
        push_i32(&mut payload, 0);
        payload.push(0); // asleep
        push_f32(&mut payload, 0.0);
        push_i32(&mut payload, 0); // left hand item id
        push_i32(&mut payload, 0); // right hand item id
        payload.push(0); // on fire
        payload.extend_from_slice(&[0; 8 * 4]);
        push_i32(&mut payload, 0); // books
        push_f32(&mut payload, 0.0);
        push_i32(&mut payload, 0); // recipes
        push_i32(&mut payload, 0);
        payload.extend_from_slice(&[0; 3 * 4]);
        payload.extend_from_slice(&[0; 6]);
        payload.push(0); // fishing
        payload.extend_from_slice(&[0; 2]); // brush, fast move
        payload.extend_from_slice(&[0; 2]); // timed action, endurance
        payload.extend_from_slice(&[0; 2]); // ammo, know recipes
        payload.extend_from_slice(&[0; 2]); // sneaking, death drag
        push_i32(&mut payload, 0); // literature
        push_i32(&mut payload, 0); // print media
        push_i64(&mut payload, 0);
        push_i32(&mut payload, 0); // player cheats
        push_i32(&mut payload, 1);
        push_i32(&mut payload, 0);
        push_i32(&mut payload, 0);
        payload.push(0); // worn items
        let mut reader = BigReader::new(&payload);
        if let Err(error) = skip_zombie(&mut reader, 249) {
            panic!("zombie payload should align at {}: {error}", reader.pos);
        }
        assert_eq!(reader.pos, payload.len());
    }

    #[test]
    fn skips_build_42_body_damage_payload_without_shifting_reader() {
        let mut payload = Vec::new();
        for _ in 0..17 {
            payload.extend_from_slice(&[0; 8]);
            push_f32(&mut payload, 0.0);
            payload.push(0); // infected wound
            payload.extend_from_slice(&[0; 7 * 4]);
            payload.extend_from_slice(&[0; 3]);
            push_f32(&mut payload, 0.0);
            payload.extend_from_slice(&[0; 2]);
            push_f32(&mut payload, 0.0);
            payload.push(0); // splint
            payload.push(0); // bullet
            push_f32(&mut payload, 0.0);
            payload.push(0); // burn wash
            push_f32(&mut payload, 0.0);
            push_utf(&mut payload, "");
            push_utf(&mut payload, "");
            payload.extend_from_slice(&[0; 6 * 4]);
        }
        push_f32(&mut payload, 0.0);
        payload.push(0);
        push_f32(&mut payload, 0.0);
        push_i32(&mut payload, 0);
        payload.push(0);
        payload.extend_from_slice(&[0; 6 * 4]);
        payload.push(0); // thermoregulator
        let mut reader = BigReader::new(&payload);
        skip_body_damage(&mut reader, 249).expect("body damage should align");
        assert_eq!(reader.pos, payload.len());
    }

    #[test]
    fn skips_character_xp_payload_without_shifting_reader() {
        let mut payload = Vec::new();
        push_i32(&mut payload, 0); // traits
        push_f32(&mut payload, 0.0);
        push_i32(&mut payload, 0);
        push_i32(&mut payload, 0);
        push_i32(&mut payload, 0); // XP map
        push_i32(&mut payload, 0); // perk list
        push_i32(&mut payload, 0); // multipliers
        let mut reader = BigReader::new(&payload);
        skip_xp(&mut reader).expect("XP should align");
        assert_eq!(reader.pos, payload.len());
    }

    #[test]
    fn skips_dead_body_mannequin_animal_and_hutch_payloads() {
        let mut corpse = Vec::new();
        push_zero_moving_payload(&mut corpse);
        corpse.extend_from_slice(&[0; 3]);
        push_utf(&mut corpse, "");
        push_utf(&mut corpse, "");
        push_f32(&mut corpse, 0.0);
        push_utf(&mut corpse, "");
        corpse.extend_from_slice(&[0; 3 * 4 + 1]);
        corpse.push(0); // persistent outfit
        corpse.push(0); // descriptor
        corpse.push(0); // human visual
        push_zero_human_visual(&mut corpse);
        corpse.push(0); // container
        corpse.extend_from_slice(&[0; 2 * 4]);
        corpse.push(0); // fall flags
        corpse.push(0); // skeleton
        push_f32(&mut corpse, 0.0);
        corpse.push(0); // zombie rot stage
        corpse.push(0); // animal rot stage
        push_utf(&mut corpse, "");
        push_utf(&mut corpse, "");
        corpse.extend_from_slice(&[0; 3]);
        let mut reader = BigReader::new(&corpse);
        if let Err(error) = skip_dead_body(&mut reader, 249, 0) {
            panic!("corpse payload should align at {}: {error}", reader.pos);
        }
        assert_eq!(reader.pos, corpse.len());

        let mut mannequin = vec![0; 5];
        push_utf(&mut mannequin, "");
        push_utf(&mut mannequin, "");
        push_zero_human_visual(&mut mannequin);
        mannequin.push(0);
        let mut reader = BigReader::new(&mannequin);
        skip_mannequin(&mut reader, 249).expect("mannequin payload should align");
        assert_eq!(reader.pos, mannequin.len());

        let mut animal = Vec::new();
        animal.extend_from_slice(&[0; 2 * 8 + 3 * 4 + 4 + 24 * 4]);
        push_utf(&mut animal, "cow");
        push_utf(&mut animal, "default");
        push_utf(&mut animal, "");
        push_i32(&mut animal, 0); // mod data table
        push_i32(&mut animal, 0);
        animal.push(0);
        push_i32(&mut animal, 0);
        push_i32(&mut animal, 0); // genes
        animal.push(0); // attached tree
        push_i32(&mut animal, 0);
        push_f64(&mut animal, 0.0);
        push_i64(&mut animal, 0);
        push_f32(&mut animal, 0.0);
        push_i32(&mut animal, 0);
        animal.push(0); // mother
        animal.push(0); // pregnant
        animal.push(0); // can have milk
        animal.extend_from_slice(&[0; 2 * 4]);
        push_i32(&mut animal, 0);
        animal.push(0);
        push_i32(&mut animal, 0);
        animal.push(0);
        push_f32(&mut animal, 0.0);
        push_i32(&mut animal, 0);
        push_f32(&mut animal, 0.0);
        push_i64(&mut animal, 0);
        push_i64(&mut animal, 0);
        push_i32(&mut animal, 0);
        push_f32(&mut animal, 0.0);
        push_f64(&mut animal, 0.0);
        push_utf(&mut animal, "");
        push_i32(&mut animal, 0);
        animal.push(0);
        push_f32(&mut animal, 0.0);
        animal.push(0);
        animal.extend_from_slice(&[0; 2]);
        let mut reader = BigReader::new(&animal);
        skip_animal(&mut reader, 249).expect("animal payload should align");
        assert_eq!(reader.pos, animal.len());
        let mut animal_object = vec![1, 36];
        animal_object.extend_from_slice(&animal);
        assert_eq!(
            parse_object(&mut BigReader::new(&animal_object), 249, 0).unwrap(),
            None
        );

        let mut hutch = Vec::new();
        hutch.extend_from_slice(&[0; 3 * 4]);
        push_utf(&mut hutch, "");
        hutch.push(0);
        hutch.push(0);
        hutch.extend_from_slice(&[0; 3 * 4]);
        push_i32(&mut hutch, 1);
        hutch.push(0);
        hutch.extend_from_slice(&[0; 2 * 4]);
        hutch.push(0);
        let mut reader = BigReader::new(&hutch);
        skip_hutch(&mut reader, 249).expect("hutch payload should align");
        assert_eq!(reader.pos, hutch.len());
    }
}
