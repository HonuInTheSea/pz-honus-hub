//! Map-description loading and dependency resolution.
//!
//! The Python renderer uses small YAML files (`vanilla.txt`, `mod/*.txt`,
//! etc.) to describe map roots and texture-pack dependencies. This module
//! keeps that concern separate from image rendering and resolves the same
//! `{config_key}` / `{map_key}` placeholders without a Python runtime.

use serde_json::Value;
use serde_yaml::Value as YamlValue;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Clone, Debug)]
pub(crate) struct TextureSource {
    pub(crate) path: PathBuf,
    pub(crate) patterns: Vec<String>,
}

#[derive(Clone, Debug)]
struct MapDefinition {
    fields: HashMap<String, YamlValue>,
    source_dir: PathBuf,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct MapCatalog {
    maps: HashMap<String, MapDefinition>,
}

impl MapCatalog {
    pub(crate) fn load(config: &Value) -> Result<Self, String> {
        let roots = config_roots(config);
        let mut files = Vec::new();
        for name in configured_paths(config, "map_conf") {
            for root in &roots {
                let path = root.join(&name);
                if path.is_file() || path.is_dir() {
                    collect_description_files(&path, &mut files)?;
                    break;
                }
            }
        }
        let mut catalog = Self::default();
        for file in files {
            catalog.load_file(&file)?;
        }

        if let Some(default_path) = configured_paths(config, "map_conf_default").first() {
            for root in &roots {
                let path = root.join(default_path);
                if path.is_file() {
                    let defaults = parse_file(&path)?;
                    if defaults.is_empty() {
                        catalog.apply_global_defaults(parse_flat_fields(&path)?);
                    } else {
                        catalog.apply_defaults(defaults);
                    }
                    break;
                }
            }
        }
        Ok(catalog)
    }

    pub(crate) fn map_path(&self, config: &Value, name: &str) -> Option<PathBuf> {
        let definition = self.maps.get(name)?;
        let template = definition.string("map_path")?;
        Some(resolve_template(config, definition, &template))
    }

    pub(crate) fn encoding(&self, name: &str) -> String {
        self.maps
            .get(name)
            .and_then(|definition| definition.string("encoding"))
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "utf8".to_string())
    }

    pub(crate) fn texture_sources(
        &self,
        config: &Value,
        names: &[String],
        dependency_only: bool,
    ) -> Vec<TextureSource> {
        let selected = if dependency_only {
            self.dependency_order(names)
        } else {
            let mut all = self.maps.keys().cloned().collect::<Vec<_>>();
            all.sort_by_key(|name| (name != "default", name.clone()));
            all
        };
        let mut sources = Vec::new();
        for name in selected {
            let Some(definition) = self.maps.get(&name) else {
                continue;
            };
            if definition.boolean("texture") == Some(false) {
                continue;
            }
            let Some(template) = definition.string("texture_path") else {
                continue;
            };
            let patterns = definition
                .strings("texture_files")
                .unwrap_or_else(|| vec![r".*[.]pack".to_string()]);
            sources.push(TextureSource {
                path: resolve_template(config, definition, &template),
                patterns,
            });
        }
        sources
    }

    fn load_file(&mut self, path: &Path) -> Result<(), String> {
        for (name, definition) in parse_file(path)? {
            self.maps.insert(name, definition);
        }
        Ok(())
    }

    fn apply_defaults(&mut self, defaults: HashMap<String, MapDefinition>) {
        for (name, default) in defaults {
            if let Some(existing) = self.maps.get_mut(&name) {
                for (key, value) in default.fields {
                    existing.fields.entry(key).or_insert(value);
                }
            } else {
                self.maps.insert(name, default);
            }
        }
    }

    fn apply_global_defaults(&mut self, defaults: HashMap<String, YamlValue>) {
        for definition in self.maps.values_mut() {
            for (key, value) in &defaults {
                definition
                    .fields
                    .entry(key.clone())
                    .or_insert_with(|| value.clone());
            }
        }
    }

    fn dependency_order(&self, names: &[String]) -> Vec<String> {
        let mut output = Vec::new();
        let mut visited = HashSet::new();
        fn visit(
            catalog: &MapCatalog,
            name: &str,
            visited: &mut HashSet<String>,
            output: &mut Vec<String>,
        ) {
            if !visited.insert(name.to_string()) {
                return;
            }
            let Some(definition) = catalog.maps.get(name) else {
                return;
            };
            for dependency in definition.strings("depend").unwrap_or_default() {
                visit(catalog, &dependency, visited, output);
            }
            output.push(name.to_string());
        }
        for name in names {
            visit(self, name, &mut visited, &mut output);
        }
        output
    }
}

impl MapDefinition {
    fn string(&self, key: &str) -> Option<String> {
        self.fields
            .get(key)
            .and_then(YamlValue::as_str)
            .map(str::to_string)
    }

    fn boolean(&self, key: &str) -> Option<bool> {
        self.fields.get(key).and_then(YamlValue::as_bool)
    }

    fn strings(&self, key: &str) -> Option<Vec<String>> {
        let value = self.fields.get(key)?;
        if let Some(text) = value.as_str() {
            return Some(
                text.lines()
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
                    .collect(),
            );
        }
        Some(
            value
                .as_sequence()?
                .iter()
                .filter_map(YamlValue::as_str)
                .map(str::to_string)
                .collect(),
        )
    }
}

fn config_roots(config: &Value) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for key in ["map_conf_root", "custom_root"] {
        if let Some(value) = config
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            roots.push(expand_environment(super::filesystem_path(&value)));
        }
    }
    if let Ok(current) = std::env::current_dir() {
        roots.push(current);
    }
    roots.dedup();
    roots
}

fn configured_paths(config: &Value, key: &str) -> Vec<String> {
    let Some(value) = config.get(key) else {
        return Vec::new();
    };
    if let Some(text) = value.as_str() {
        return text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect();
    }
    if let Some(values) = value.as_array() {
        return values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect();
    }
    Vec::new()
}

fn collect_description_files(path: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_file() {
        files.push(path.to_path_buf());
        return Ok(());
    }
    for entry in WalkDir::new(path).follow_links(false).into_iter() {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_file()
            && entry.path().extension().is_some_and(|extension| {
                extension.eq_ignore_ascii_case("txt") || extension.eq_ignore_ascii_case("yaml")
            })
        {
            files.push(entry.into_path());
        }
    }
    files.sort();
    Ok(())
}

fn parse_file(path: &Path) -> Result<HashMap<String, MapDefinition>, String> {
    let source =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let value: YamlValue = serde_yaml::from_str(&source)
        .map_err(|error| format!("{}: invalid map description: {error}", path.display()))?;
    let YamlValue::Mapping(mapping) = value else {
        return Err(format!(
            "{}: map description must be a mapping",
            path.display()
        ));
    };
    let mut result = HashMap::new();
    for (name, fields) in mapping {
        let Some(name) = name.as_str() else { continue };
        let YamlValue::Mapping(fields) = fields else {
            continue;
        };
        result.insert(
            name.to_string(),
            MapDefinition {
                fields: fields
                    .into_iter()
                    .filter_map(|(key, value)| Some((key.as_str()?.to_string(), value)))
                    .collect(),
                source_dir: path
                    .parent()
                    .unwrap_or_else(|| Path::new("."))
                    .to_path_buf(),
            },
        );
    }
    Ok(result)
}

fn parse_flat_fields(path: &Path) -> Result<HashMap<String, YamlValue>, String> {
    let source =
        fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    let value: YamlValue = serde_yaml::from_str(&source)
        .map_err(|error| format!("{}: invalid map defaults: {error}", path.display()))?;
    let YamlValue::Mapping(mapping) = value else {
        return Err(format!(
            "{}: map defaults must be a mapping",
            path.display()
        ));
    };
    Ok(mapping
        .into_iter()
        .filter_map(|(key, value)| Some((key.as_str()?.to_string(), value)))
        .collect())
}

fn resolve_template(config: &Value, definition: &MapDefinition, template: &str) -> PathBuf {
    let mut value = template.to_string();
    for (key, replacement) in config
        .as_object()
        .into_iter()
        .flat_map(|object| object.iter())
    {
        if let Some(replacement) = replacement.as_str() {
            value = value.replace(&format!("{{{key}}}"), replacement);
        }
    }
    for (key, replacement) in &definition.fields {
        if let Some(replacement) = replacement.as_str() {
            value = value.replace(&format!("{{{key}}}"), replacement);
        }
    }
    let path = expand_environment(super::filesystem_path(&value));
    if path.is_absolute() {
        path
    } else {
        definition.source_dir.join(path)
    }
}

fn expand_environment(mut path: PathBuf) -> PathBuf {
    if let Some(text) = path.to_str() {
        let mut expanded = text.to_string();
        for (key, value) in std::env::vars() {
            expanded = expanded.replace(&format!("%{key}%"), &value);
        }
        path = super::filesystem_path(&expanded);
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_defaults_dependencies_and_templates() {
        let root = std::env::temp_dir().join(format!("pz-map-config-{}", std::process::id()));
        fs::create_dir_all(root.join("mods")).expect("create config root");
        fs::write(
            root.join("default.txt"),
            "default:\n  texture: true\n  texture_path: '{pz_root}/media/texturepacks'\n  texture_files: ['.*[.]pack']\n",
        )
        .expect("write default");
        fs::write(
            root.join("mods/maps.txt"),
            "base:\n  map_path: '{mod_root}/{map_name}'\n  map_name: map\n  depend: [default]\n",
        )
        .expect("write map");
        let config = serde_json::json!({
            "custom_root": root,
            "map_conf": ["mods/"],
            "map_conf_default": "default.txt",
            "mod_root": "C:/mods",
            "pz_root": "C:/game"
        });
        let catalog = MapCatalog::load(&config).expect("load catalog");
        assert_eq!(
            catalog.map_path(&config, "base"),
            Some(PathBuf::from("C:/mods/map"))
        );
        assert_eq!(
            catalog.dependency_order(&["base".into()]),
            vec!["default", "base"]
        );
        assert_eq!(
            catalog.dependency_order(&["default".into(), "base".into()]),
            vec!["default", "base"]
        );
        assert_eq!(catalog.encoding("base"), "utf8");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn applies_flat_defaults_to_each_map_definition() {
        let root =
            std::env::temp_dir().join(format!("pz-map-flat-defaults-{}", std::process::id()));
        fs::create_dir_all(root.join("mods")).expect("create config root");
        fs::write(
            root.join("defaults.txt"),
            "map_path: '{mod_root}/{map_name}'\ntexture_path: '{mod_root}/textures'\nencoding: utf8\ntexture_files: ['.*[.]pack']\n",
        )
        .expect("write flat defaults");
        fs::write(
            root.join("mods/maps.txt"),
            "default:\n  texture: true\n  texture_path: '{mod_root}/vanilla'\nbase:\n  map_name: map\n  texture: true\n",
        )
        .expect("write map definitions");
        let config = serde_json::json!({
            "custom_root": root,
            "map_conf": ["mods/"],
            "map_conf_default": "defaults.txt",
            "mod_root": "C:/mods"
        });

        let catalog = MapCatalog::load(&config).expect("load catalog");
        assert_eq!(
            catalog.map_path(&config, "base"),
            Some(PathBuf::from("C:/mods/map"))
        );
        let sources = catalog.texture_sources(&config, &["base".into()], true);
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, PathBuf::from("C:/mods/textures"));
        assert_eq!(sources[0].patterns, vec![r".*[.]pack"]);
        let ordered = catalog.texture_sources(&config, &["default".into(), "base".into()], true);
        assert_eq!(ordered.len(), 2);
        assert_eq!(ordered[0].path, PathBuf::from("C:/mods/vanilla"));
        assert_eq!(ordered[1].path, PathBuf::from("C:/mods/textures"));
        assert_eq!(catalog.encoding("base"), "utf8");
        let _ = fs::remove_dir_all(root);
    }
}
