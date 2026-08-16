use chrono::{DateTime, Utc};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

pub(crate) fn to_iso_string(time: SystemTime) -> Option<String> {
    let dt: DateTime<Utc> = time.into();
    Some(dt.to_rfc3339())
}

pub(crate) fn sanitize_filename_component(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub(crate) fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn safe_relative_path(base: &Path, relative: &str) -> Result<PathBuf, String> {
    let trimmed = relative.trim();
    if trimmed.is_empty() {
        return Err("Relative path is empty.".to_string());
    }

    let relative_path = Path::new(trimmed);
    if relative_path.is_absolute()
        || relative_path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(
            "Relative path must stay inside the Project Zomboid user directory.".to_string(),
        );
    }

    Ok(base.join(relative_path))
}
