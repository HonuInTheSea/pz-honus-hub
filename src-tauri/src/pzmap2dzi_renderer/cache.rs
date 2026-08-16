//! Small, deterministic source signatures for incremental rendering.

use md5::{Digest, Md5};
use serde_json::Value;
use sha1::Sha1;
use sha2::Sha256;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::Path;

const CACHE_DISABLED: &str = "rust-pzmap2dzi-cache-disabled";
const CACHE_VERSION: &str = "rust-pzmap2dzi-v3";

pub(crate) fn enabled(config: &Value) -> bool {
    config
        .get("render_conf")
        .and_then(|value| value.get("enable_cache"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub(crate) fn disabled_signature() -> &'static str {
    CACHE_DISABLED
}

pub(crate) fn signature(
    config: &Value,
    paths: impl IntoIterator<Item = impl AsRef<Path>>,
) -> String {
    let mut hasher = DefaultHasher::new();
    config.to_string().hash(&mut hasher);
    hash_paths(&mut hasher, config, paths);
    format!("{CACHE_VERSION}-{:016x}", hasher.finish())
}

/// Derive a narrower cache signature from an already-computed configuration
/// and texture signature. This keeps per-tile incremental checks cheap while
/// still honoring the configured content hash method.
pub(crate) fn signature_with_base(
    config: &Value,
    base_signature: &str,
    paths: impl IntoIterator<Item = impl AsRef<Path>>,
) -> String {
    if base_signature == CACHE_DISABLED {
        return CACHE_DISABLED.to_string();
    }
    let mut hasher = DefaultHasher::new();
    base_signature.hash(&mut hasher);
    config.to_string().hash(&mut hasher);
    hash_paths(&mut hasher, config, paths);
    format!("{CACHE_VERSION}-{:016x}", hasher.finish())
}

pub(crate) fn scoped_signature(config: &Value, base_signature: &str) -> String {
    if !enabled(config) {
        return disabled_signature().to_string();
    }
    signature_with_base(config, base_signature, std::iter::empty::<&Path>())
}

fn hash_paths(
    hasher: &mut DefaultHasher,
    config: &Value,
    paths: impl IntoIterator<Item = impl AsRef<Path>>,
) {
    let mut normalized = paths
        .into_iter()
        .map(|path| path.as_ref().to_path_buf())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    let hash_method = config
        .get("render_conf")
        .and_then(|value| value.get("hash_method"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    for path in normalized {
        path.to_string_lossy().hash(hasher);
        if let Ok(metadata) = fs::metadata(&path) {
            if let Some(digest) = file_digest(&path, &hash_method) {
                digest.hash(hasher);
            } else {
                metadata.len().hash(hasher);
                if let Ok(modified) = metadata.modified()
                    && let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH)
                {
                    duration.as_secs().hash(hasher);
                    duration.subsec_nanos().hash(hasher);
                }
            }
        }
    }
}

fn file_digest(path: &Path, method: &str) -> Option<String> {
    if method.is_empty() || !path.is_file() {
        return None;
    }
    let mut file = fs::File::open(path).ok()?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).ok()?;
    let digest = match method {
        "md5" => format!("{:x}", Md5::digest(&data)),
        "sha1" => format!("{:x}", Sha1::digest(&data)),
        "sha256" => format!("{:x}", Sha256::digest(&data)),
        _ => return None,
    };
    Some(digest)
}

pub(crate) fn is_current(path: &Path, signature: &str) -> bool {
    if signature == CACHE_DISABLED {
        return false;
    }
    fs::read_to_string(path)
        .map(|value| value.trim() == signature)
        .unwrap_or(false)
}

pub(crate) fn write(path: &Path, signature: &str) -> Result<(), String> {
    if signature == CACHE_DISABLED {
        return Ok(());
    }
    fs::write(path, signature).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_defaults_to_enabled_when_not_configured() {
        assert!(enabled(&serde_json::json!({})));
        assert!(!enabled(&serde_json::json!({
            "render_conf": {"enable_cache": false}
        })));
    }

    #[test]
    fn hash_method_uses_file_content_digest() {
        let path = std::env::temp_dir().join(format!("pz-cache-hash-{}", std::process::id()));
        fs::write(&path, b"first").expect("write first digest input");
        let config = serde_json::json!({"render_conf": {"hash_method": "sha256"}});
        let first = signature(&config, [&path]);
        fs::write(&path, b"second").expect("write second digest input");
        let second = signature(&config, [&path]);
        assert_ne!(first, second);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn narrower_signature_changes_when_a_tile_source_changes() {
        let path = std::env::temp_dir().join(format!("pz-cache-tile-{}", std::process::id()));
        fs::write(&path, b"first tile").expect("write tile source");
        let config = serde_json::json!({"render_conf": {"hash_method": "sha256"}});
        let base = signature(&config, std::iter::empty::<&Path>());
        let first = signature_with_base(&config, &base, [&path]);
        fs::write(&path, b"second tile").expect("rewrite tile source");
        let second = signature_with_base(&config, &base, [&path]);
        assert_ne!(first, second);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn scoped_signature_changes_for_command_specific_settings() {
        let base = signature(
            &serde_json::json!({"render_conf": {"image_fmt": "webp"}}),
            std::iter::empty::<&Path>(),
        );
        let first = scoped_signature(
            &serde_json::json!({"render_conf": {"top_view_color_mode": "avg"}}),
            &base,
        );
        let second = scoped_signature(
            &serde_json::json!({"render_conf": {"top_view_color_mode": "carto-zed"}}),
            &base,
        );
        assert_ne!(first, second);
        assert_eq!(
            scoped_signature(
                &serde_json::json!({"render_conf": {"enable_cache": false}}),
                &base,
            ),
            disabled_signature()
        );
    }
}
