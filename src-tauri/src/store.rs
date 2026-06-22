use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::fs;
use tauri::Manager;

fn try_read_store_key(store_json: &JsonValue, key: &str) -> Option<JsonValue> {
    if let Some(value) = store_json.get(key) {
        return Some(value.clone());
    }

    for container_key in ["data", "store"] {
        if let Some(value) = store_json
            .get(container_key)
            .and_then(|container| container.get(key))
        {
            return Some(value.clone());
        }
    }

    None
}

#[tauri::command]
pub fn get_bootstrap_store_items(
    app: tauri::AppHandle,
    keys: Vec<String>,
) -> Result<HashMap<String, JsonValue>, String> {
    let mut out: HashMap<String, JsonValue> = HashMap::new();
    let unique_keys: Vec<String> = keys
        .into_iter()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .collect();

    if unique_keys.is_empty() {
        return Ok(out);
    }

    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let store_path = config_dir.join("pz_mod_manager.store.json");

    if !store_path.exists() {
        for key in unique_keys {
            out.insert(key, JsonValue::Null);
        }
        return Ok(out);
    }

    let content = match fs::read_to_string(&store_path) {
        Ok(raw) => raw,
        Err(_) => {
            for key in unique_keys {
                out.insert(key, JsonValue::Null);
            }
            return Ok(out);
        }
    };

    let parsed: JsonValue = match serde_json::from_str(&content) {
        Ok(value) => value,
        Err(_) => {
            for key in unique_keys {
                out.insert(key, JsonValue::Null);
            }
            return Ok(out);
        }
    };

    for key in unique_keys {
        let value = try_read_store_key(&parsed, &key).unwrap_or(JsonValue::Null);
        out.insert(key, value);
    }

    Ok(out)
}
