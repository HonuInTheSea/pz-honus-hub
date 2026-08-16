//! Native WorldDictionary.bin sprite-name reader for saved maps.
//!
//! The dictionary is separate from the static `.tiles` files because saved
//! worlds can register sprites supplied by mods or generated at runtime.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

type DictionaryResult<T> = Result<T, String>;

pub(crate) fn load_sprites(path: &Path, b41: bool) -> DictionaryResult<HashMap<i32, String>> {
    let data = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    parse_sprites(&data, b41)
}

fn parse_sprites(data: &[u8], b41: bool) -> DictionaryResult<HashMap<i32, String>> {
    let mut reader = Reader::new(data);
    if !b41 {
        reader.i32()?;
    }
    reader.i16()?;
    reader.u8()?;
    reader.i32()?;
    let mod_count = checked_count(reader.i32()?, "mod id")?;
    for _ in 0..mod_count {
        reader.string_utf()?;
    }
    let module_count = checked_count(reader.i32()?, "module")?;
    for _ in 0..module_count {
        reader.string_utf()?;
    }
    let item_count = checked_count(reader.i32()?, "item")?;
    for _ in 0..item_count {
        skip_dict_info(&mut reader, mod_count, module_count)?;
    }
    let object_count = checked_count(reader.i32()?, "object")?;
    for _ in 0..object_count {
        reader.u8()?;
        reader.string_utf()?;
    }
    let sprite_count = checked_count(reader.i32()?, "sprite")?;
    let mut sprites = HashMap::with_capacity(sprite_count);
    for _ in 0..sprite_count {
        let id = reader.i32()?;
        let name = reader.string_utf()?;
        sprites.insert(id, name);
    }
    Ok(sprites)
}

fn skip_dict_info(
    reader: &mut Reader<'_>,
    mod_count: usize,
    module_count: usize,
) -> DictionaryResult<()> {
    reader.i16()?;
    if module_count > 127 {
        reader.i16()?;
    } else {
        reader.u8()?;
    }
    reader.string_utf()?;
    let flags = reader.u8()?;
    if flags & 1 != 0 {
        if mod_count > 127 {
            reader.i16()?;
        } else {
            reader.u8()?;
        }
    }
    let override_count = if flags & 16 != 0 {
        if flags & 32 != 0 {
            reader.u8()? as usize
        } else {
            1
        }
    } else {
        0
    };
    for _ in 0..override_count {
        if mod_count > 127 {
            reader.i16()?;
        } else {
            reader.u8()?;
        }
    }
    Ok(())
}

fn checked_count(value: i32, kind: &str) -> DictionaryResult<usize> {
    if (0..=10_000_000).contains(&value) {
        Ok(value as usize)
    } else {
        Err(format!("Invalid WorldDictionary {kind} count: {value}"))
    }
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn bytes(&mut self, count: usize) -> DictionaryResult<&'a [u8]> {
        let end = self
            .pos
            .checked_add(count)
            .filter(|end| *end <= self.data.len())
            .ok_or_else(|| "Unexpected end of WorldDictionary.bin.".to_string())?;
        let bytes = &self.data[self.pos..end];
        self.pos = end;
        Ok(bytes)
    }

    fn u8(&mut self) -> DictionaryResult<u8> {
        Ok(self.bytes(1)?[0])
    }

    fn i16(&mut self) -> DictionaryResult<i16> {
        Ok(i16::from_be_bytes(self.bytes(2)?.try_into().unwrap()))
    }

    fn i32(&mut self) -> DictionaryResult<i32> {
        Ok(i32::from_be_bytes(self.bytes(4)?.try_into().unwrap()))
    }

    fn string_utf(&mut self) -> DictionaryResult<String> {
        let length = u16::from_be_bytes(self.bytes(2)?.try_into().unwrap()) as usize;
        Ok(String::from_utf8_lossy(self.bytes(length)?).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn push_u8(data: &mut Vec<u8>, value: u8) {
        data.push(value);
    }

    fn push_i16(data: &mut Vec<u8>, value: i16) {
        data.extend_from_slice(&value.to_be_bytes());
    }

    fn push_i32(data: &mut Vec<u8>, value: i32) {
        data.extend_from_slice(&value.to_be_bytes());
    }

    fn push_string(data: &mut Vec<u8>, value: &str) {
        data.extend_from_slice(&(value.len() as u16).to_be_bytes());
        data.extend_from_slice(value.as_bytes());
    }

    fn dictionary(b41: bool) -> Vec<u8> {
        let mut data = Vec::new();
        if !b41 {
            push_i32(&mut data, 249);
        }
        push_i16(&mut data, 0);
        push_u8(&mut data, 0);
        push_i32(&mut data, 1);
        push_i32(&mut data, 0);
        push_i32(&mut data, 1);
        push_string(&mut data, "Base");
        push_i32(&mut data, 0);
        push_i32(&mut data, 0);
        push_i32(&mut data, 1);
        push_i32(&mut data, 3);
        push_string(&mut data, "saved_sprite");
        data
    }

    #[test]
    fn parses_b41_sprite_entries() {
        let sprites = parse_sprites(&dictionary(true), true).expect("B41 dictionary should parse");
        assert_eq!(sprites.get(&3), Some(&"saved_sprite".to_string()));
    }

    #[test]
    fn parses_b42_sprite_entries() {
        let sprites =
            parse_sprites(&dictionary(false), false).expect("B42 dictionary should parse");
        assert_eq!(sprites.get(&3), Some(&"saved_sprite".to_string()));
    }
}
