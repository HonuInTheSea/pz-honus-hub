use crate::models::{HonuModsDbResult, ModSummary, RequiredByInfo};
use crate::utils::ensure_parent_dir;
use chrono::DateTime;
use serde_json::Value as JsonValue;
use std::fs;
use std::path::Path;

fn lua_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(ch),
        }
    }
    out
}

fn lua_string(input: &str) -> String {
    format!("\"{}\"", lua_escape(input))
}

fn lua_bool(value: bool) -> &'static str {
    if value { "true" } else { "false" }
}

fn lua_string_list(values: &[String]) -> String {
    if values.is_empty() {
        return "{}".to_string();
    }
    let items = values
        .iter()
        .map(|v| lua_string(v))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{{ {} }}", items)
}

fn lua_required_by_list(values: &[RequiredByInfo]) -> String {
    if values.is_empty() {
        return "{}".to_string();
    }
    let items = values
        .iter()
        .filter_map(|info| {
            let mod_id = info.mod_id.trim();
            let name = info.name.trim();
            let mut fields = Vec::new();
            if !mod_id.is_empty() {
                fields.push(format!("modId = {}", lua_string(mod_id)));
            }
            if !name.is_empty() {
                fields.push(format!("name = {}", lua_string(name)));
            }
            if fields.is_empty() {
                None
            } else {
                Some(format!("{{ {} }}", fields.join(", ")))
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    format!("{{ {} }}", items)
}

fn lua_json(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "nil".to_string(),
        JsonValue::Bool(v) => lua_bool(*v).to_string(),
        JsonValue::Number(v) => v.to_string(),
        JsonValue::String(v) => lua_string(v),
        JsonValue::Array(values) => {
            if values.is_empty() {
                return "{}".to_string();
            }
            let items = values.iter().map(lua_json).collect::<Vec<_>>().join(", ");
            format!("{{ {} }}", items)
        }
        JsonValue::Object(values) => {
            if values.is_empty() {
                return "{}".to_string();
            }
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let items = keys
                .into_iter()
                .filter_map(|key| values.get(key).map(|value| (key, value)))
                .map(|(key, value)| format!("[{}] = {}", lua_string(key), lua_json(value)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("{{ {} }}", items)
        }
    }
}

fn lua_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return lua_string(key);
    }
    let mut chars = trimmed.chars();
    let first = chars.next().unwrap();
    let valid_first = first.is_ascii_alphabetic() || first == '_';
    let valid_rest = chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if valid_first && valid_rest {
        trimmed.to_string()
    } else {
        format!("[{}]", lua_string(trimmed))
    }
}

fn strip_workshop_descriptions(value: &JsonValue) -> JsonValue {
    let JsonValue::Object(map) = value else {
        return value.clone();
    };
    let mut next = serde_json::Map::new();
    for (key, val) in map {
        if key.eq_ignore_ascii_case("description")
            || key.eq_ignore_ascii_case("file_description")
            || key.eq_ignore_ascii_case("short_description")
            || key.eq_ignore_ascii_case("app_name")
            || key.eq_ignore_ascii_case("appid")
            || key.eq_ignore_ascii_case("author")
            || key.eq_ignore_ascii_case("maybe_inappropriate_violence")
            || key.eq_ignore_ascii_case("num_children")
            || key.eq_ignore_ascii_case("num_comments_public")
            || key.eq_ignore_ascii_case("num_reports")
            || key.eq_ignore_ascii_case("preview_file_size")
            || key.eq_ignore_ascii_case("preview_url")
            || key.eq_ignore_ascii_case("publishedfileid")
            || key.eq_ignore_ascii_case("raw_tags")
            || key.eq_ignore_ascii_case("result")
            || key.eq_ignore_ascii_case("revision")
            || key.eq_ignore_ascii_case("revision_change_number")
            || key.eq_ignore_ascii_case("show_subscribe_all")
            || key.eq_ignore_ascii_case("tags")
            || key.eq_ignore_ascii_case("ban_reason")
            || key.eq_ignore_ascii_case("ban_text_check_result")
            || key.eq_ignore_ascii_case("banned")
            || key.eq_ignore_ascii_case("banner")
            || key.eq_ignore_ascii_case("can_be_deleted")
            || key.eq_ignore_ascii_case("can_subscribe")
            || key.eq_ignore_ascii_case("consumer_appid")
            || key.eq_ignore_ascii_case("consumer_shortcutid")
            || key.eq_ignore_ascii_case("creator")
            || key.eq_ignore_ascii_case("creator_appid")
            || key.eq_ignore_ascii_case("creator_avatar")
            || key.eq_ignore_ascii_case("creator_avatar_hash")
            || key.eq_ignore_ascii_case("creator_avatar_medium")
            || key.eq_ignore_ascii_case("creator_avatar_small")
            || key.eq_ignore_ascii_case("creator_commentpermission")
            || key.eq_ignore_ascii_case("creator_communityvisibilitystate")
            || key.eq_ignore_ascii_case("creator_id")
            || key.eq_ignore_ascii_case("creator_loccountrycode")
            || key.eq_ignore_ascii_case("creator_locstatecode")
            || key.eq_ignore_ascii_case("creator_personastate")
            || key.eq_ignore_ascii_case("creator_personastateflags")
            || key.eq_ignore_ascii_case("creator_primaryclanid")
            || key.eq_ignore_ascii_case("creator_profileurl")
            || key.eq_ignore_ascii_case("creator_profilestate")
            || key.eq_ignore_ascii_case("creator_name")
            || key.eq_ignore_ascii_case("creator_realname")
            || key.eq_ignore_ascii_case("creator_steamid")
            || key.eq_ignore_ascii_case("creator_timecreated")
            || key.eq_ignore_ascii_case("title")
            || key.eq_ignore_ascii_case("visibility")
            || key.eq_ignore_ascii_case("workshop_accepted")
            || key.eq_ignore_ascii_case("workshop_file")
            || key.eq_ignore_ascii_case("map_followers")
            || key.eq_ignore_ascii_case("followers")
            || key.eq_ignore_ascii_case("lifetime_favorited")
            || key.eq_ignore_ascii_case("lifetime_followers")
            || key.eq_ignore_ascii_case("lifetime_playtime")
            || key.eq_ignore_ascii_case("lifetime_playtime_sessions")
            || key.eq_ignore_ascii_case("lifetime_subscriptions")
            || key.eq_ignore_ascii_case("hcontent_file")
            || key.eq_ignore_ascii_case("hcontent_preview")
            || key.eq_ignore_ascii_case("language")
            || key.eq_ignore_ascii_case("file_type")
            || key.eq_ignore_ascii_case("file_url")
            || key.eq_ignore_ascii_case("fileid")
            || key.eq_ignore_ascii_case("filename")
            || key.eq_ignore_ascii_case("flags")
        {
            continue;
        }
        next.insert(key.clone(), val.clone());
    }
    JsonValue::Object(next)
}

fn json_value_to_id(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(v) => {
            let trimmed = v.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        JsonValue::Number(v) => Some(v.to_string()),
        _ => None,
    }
}

fn workshop_key_for_mod(mod_item: &ModSummary) -> Option<String> {
    if let Some(workshop_id) = mod_item.workshop_id.as_ref() {
        let trimmed = workshop_id.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let meta = mod_item.workshop.as_ref()?;
    let obj = meta.as_object()?;
    if let Some(value) = obj.get("fileid").and_then(json_value_to_id) {
        return Some(value);
    }
    if let Some(value) = obj.get("publishedfileid").and_then(json_value_to_id) {
        return Some(value);
    }
    None
}

#[tauri::command]
pub fn ensure_honu_mods_db(
    base_dir: String,
    mods: Vec<ModSummary>,
) -> Result<HonuModsDbResult, String> {
    let base = Path::new(&base_dir);
    let path = base.join("honus_miqol_db.lua");
    let created = !path.exists();
    ensure_parent_dir(&path)?;

    let mut lines = Vec::new();
    lines.push("return {".to_string());
    lines.push("  mods = {".to_string());
    for mod_item in mods {
        let mod_id = mod_item.mod_id.as_deref().unwrap_or("").to_string();
        let mod_id_trimmed = mod_id.trim();
        let id_value = if mod_id_trimmed.is_empty() {
            mod_item.id.clone()
        } else {
            mod_id_trimmed.to_string()
        };
        let id_value = if id_value.starts_with('\\') {
            id_value
        } else {
            format!("\\{}", id_value)
        };
        let workshop_id = workshop_key_for_mod(&mod_item).unwrap_or_default();
        let composite_id = if workshop_id.is_empty() {
            id_value.clone()
        } else {
            format!("{}::{}", id_value, workshop_id)
        };
        let creator_name = mod_item
            .workshop
            .as_ref()
            .and_then(|meta| meta.get("creator_name"))
            .and_then(|value| value.as_str())
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string());
        let workshop_meta = mod_item
            .workshop
            .as_ref()
            .filter(|meta| !meta.is_null())
            .map(strip_workshop_descriptions);

        lines.push("    {".to_string());
        lines.push(format!("      id = {},", lua_string(&composite_id)));
        lines.push(format!("      workshop_id = {},", lua_string(&workshop_id)));
        let author_value = mod_item
            .author
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string())
            .or_else(|| creator_name.clone());
        if let Some(author) = author_value {
            lines.push(format!("      author = {},", lua_string(&author)));
        }
        lines.push(format!(
            "      hidden = {},",
            lua_bool(mod_item.hidden.unwrap_or(false))
        ));
        lines.push(format!(
            "      favorite = {},",
            lua_bool(mod_item.favorite.unwrap_or(false))
        ));
        if let Some(version) = mod_item
            .version
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!("      version = {},", lua_string(version)));
        }
        if let Some(version) = mod_item
            .version_min
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!("      version_min = {},", lua_string(version)));
        }
        if let Some(version) = mod_item
            .version_max
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!("      version_max = {},", lua_string(version)));
        }
        if let Some(install_date) = mod_item
            .install_date
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            if let Ok(parsed) = DateTime::parse_from_rfc3339(install_date) {
                lines.push(format!("      install_date = {},", parsed.timestamp()));
            }
        }
        if let Some(url) = mod_item
            .url
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!("      url = {},", lua_string(url)));
        }
        if let Some(values) = mod_item.requires.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      requires = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.dependencies.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      dependencies = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.load_after.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      load_after = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.load_before.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      load_before = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.incompatible.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      incompatible = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.packs.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      packs = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.tiledefs.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      tiledefs = {},", lua_string_list(values)));
        }
        if let Some(values) = mod_item.soundbanks.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!("      soundbanks = {},", lua_string_list(values)));
        }
        if let Some(worldmap) = mod_item
            .worldmap
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!("      worldmap = {},", lua_string(worldmap)));
        }
        if let Some(preview) = mod_item
            .preview_image_path
            .as_ref()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
        {
            lines.push(format!(
                "      preview_image_path = {},",
                lua_string(preview)
            ));
        }
        if let Some(values) = mod_item.required_by.as_ref().filter(|v| !v.is_empty()) {
            lines.push(format!(
                "      required_by = {},",
                lua_required_by_list(values)
            ));
        }
        if let Some(JsonValue::Object(map)) = workshop_meta.as_ref() {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            for field in keys {
                if let Some(field_value) = map.get(field) {
                    if *field == "creator_url" {
                        if let Some(url) = field_value.as_str() {
                            let trimmed = url.trim();
                            if !trimmed.is_empty() {
                                let appended = if trimmed.contains("appid=108600") {
                                    trimmed.to_string()
                                } else {
                                    format!("{}?appid=108600", trimmed)
                                };
                                lines.push(format!(
                                    "      {} = {},",
                                    lua_key(field),
                                    lua_string(&appended)
                                ));
                                continue;
                            }
                        }
                    }
                    lines.push(format!(
                        "      {} = {},",
                        lua_key(field),
                        lua_json(field_value)
                    ));
                }
            }
        }
        lines.push("    },".to_string());
    }
    lines.push("  }".to_string());
    lines.push("}".to_string());
    fs::write(&path, lines.join("\n")).map_err(|e| e.to_string())?;

    Ok(HonuModsDbResult {
        created,
        path: path.to_string_lossy().to_string(),
    })
}
