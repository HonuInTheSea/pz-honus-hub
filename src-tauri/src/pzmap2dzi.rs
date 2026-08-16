use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use sysinfo::Disks;
use tauri::{AppHandle, Manager, State};

use crate::pzmap2dzi_renderer;

// Local Ultra output calibration. The upstream performance notes provide the
// stage breakdown; this value keeps estimates anchored to the complete local
// output that the builder is expected to reproduce.
const ULTRA_REFERENCE_OUTPUT_BYTES: u64 = 430_463_565_575;
const REFERENCE_MAP_CELL_COUNT: f64 = 4_065.0;
const DOC_ISOMETRIC_BYTES: u64 = 404_000_000_000;
const DOC_TOP_BYTES: u64 = 67_000_000;
const DOC_ZOMBIE_BYTES: u64 = 369_000_000;
const DOC_FORAGING_BYTES: u64 = 6_200_000_000;
const DOC_ROOMS_BYTES: u64 = 927_000_000;
const DOC_OBJECTS_BYTES: u64 = 331_000_000;
const DOC_ISOMETRIC_SECONDS: u64 = 45_954;
const DOC_TOP_SECONDS: u64 = 3_161;
const DOC_ZOMBIE_SECONDS: u64 = 1_015;
const DOC_FORAGING_SECONDS: u64 = 19_354;
const DOC_ROOMS_SECONDS: u64 = 3_725;
const DOC_OBJECTS_SECONDS: u64 = 1_523;
const SAFETY_MARGIN_BYTES: u64 = 512 * 1024 * 1024;
const MINIMUM_BUILD_BYTES: u64 = 256 * 1024 * 1024;
const SAMPLE_SAFETY_MARGIN_BYTES: u64 = 32 * 1024 * 1024;
const SAMPLE_MINIMUM_BUILD_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct DiskEstimate {
    pub source_path: String,
    pub output_path: String,
    pub source_bytes: u64,
    pub output_bytes: u64,
    pub available_bytes: u64,
    pub enough_space: bool,
    pub safety_margin_bytes: u64,
    pub estimated_seconds: u64,
    pub peak_memory_bytes: u64,
    pub historical_run_count: u64,
    pub estimate_basis: String,
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputDirectoryStatus {
    pub path: String,
    pub exists: bool,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapBuildResumeCandidate {
    pub job_id: String,
    pub state: String,
    pub progress: f32,
    pub current_command: String,
    pub message: String,
    pub output_path: String,
    pub elapsed_seconds: u64,
    pub started_at_unix_ms: u64,
    pub config: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildStatus {
    pub job_id: Option<String>,
    pub state: String,
    pub progress: f32,
    pub current_command: String,
    pub message: String,
    pub logs: Vec<String>,
    pub estimate: Option<DiskEstimate>,
    pub started_at_unix_ms: Option<u64>,
    pub last_activity_unix_ms: Option<u64>,
    pub elapsed_seconds: u64,
    pub metrics_path: Option<String>,
    pub log_path: Option<String>,
    pub metrics: BuildMetrics,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BuildMetrics {
    pub sample_count: u64,
    pub progress_events: u64,
    pub cells_scanned: u64,
    pub elapsed_seconds: u64,
    pub disk_used_bytes: u64,
    pub available_bytes: u64,
    pub estimated_seconds: u64,
    pub estimated_output_bytes: u64,
    pub peak_memory_bytes: u64,
    pub stage: String,
    pub last_message: String,
    pub last_sample_at: Option<String>,
    #[serde(default)]
    pub sample_build: bool,
}

impl Default for BuildStatus {
    fn default() -> Self {
        Self {
            job_id: None,
            state: "idle".to_string(),
            progress: 0.0,
            current_command: String::new(),
            message: "Ready to build map data.".to_string(),
            logs: Vec::new(),
            estimate: None,
            started_at_unix_ms: None,
            last_activity_unix_ms: None,
            elapsed_seconds: 0,
            metrics_path: None,
            log_path: None,
            metrics: BuildMetrics::default(),
        }
    }
}

#[derive(Default)]
pub struct BuildManager {
    status: Arc<Mutex<BuildStatus>>,
    stop_file: Arc<Mutex<Option<PathBuf>>>,
    worker_pid: Arc<Mutex<Option<u32>>>,
}

impl BuildManager {
    fn snapshot(&self) -> BuildStatus {
        let mut status = self
            .status
            .lock()
            .expect("build status lock poisoned")
            .clone();
        if is_active_state(&status.state) {
            if let Some(started_at) = status.started_at_unix_ms {
                status.elapsed_seconds = unix_time_millis()
                    .saturating_sub(started_at)
                    .saturating_div(1_000);
            }
        }
        status
    }

    fn update(&self, update: impl FnOnce(&mut BuildStatus)) {
        let mut status = self.status.lock().expect("build status lock poisoned");
        update(&mut status);
        status.last_activity_unix_ms = Some(unix_time_millis());
    }
}

impl BuildStatus {
    fn add_log(&mut self, message: impl Into<String>) {
        self.logs.push(message.into());
    }
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn is_active_state(state: &str) -> bool {
    matches!(state, "starting" | "running" | "stopping")
}

fn update_terminal_elapsed(status: &mut BuildStatus) {
    if let Some(started_at) = status.started_at_unix_ms {
        status.elapsed_seconds = unix_time_millis()
            .saturating_sub(started_at)
            .saturating_div(1_000);
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[derive(Debug, Deserialize, Serialize)]
struct WorkerConfig {
    #[serde(default)]
    job_id: String,
    config_path: PathBuf,
    stop_path: PathBuf,
    #[serde(default)]
    telemetry_root: PathBuf,
    #[serde(default)]
    resume_progress: f32,
    #[serde(default)]
    resume_elapsed_seconds: u64,
    #[serde(default)]
    resume_current_command: String,
    #[serde(default)]
    resume_from_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BuildMetricEvent {
    job_id: String,
    state: String,
    progress: f32,
    command: String,
    message: String,
    metrics: BuildMetrics,
}

#[derive(Default)]
struct HistoricalEstimate {
    projected_seconds: Vec<u64>,
    projected_output_bytes: Vec<u64>,
    states: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistedBuildJob {
    job_id: String,
    state: String,
    progress: f32,
    current_command: String,
    message: String,
    output_path: String,
    elapsed_seconds: u64,
    started_at_unix_ms: u64,
    config: Value,
    metrics: BuildMetrics,
}

struct BuildRecorder {
    job_id: String,
    output_root: PathBuf,
    log_writer: BufWriter<File>,
    metrics_writer: BufWriter<File>,
    summary_path: PathBuf,
    started_at: Instant,
    started_at_unix_ms: u64,
    initial_available_bytes: u64,
    last_sample_at: Option<Instant>,
    last_sample_command: Option<String>,
    sample_count: u64,
    progress_events: u64,
    cells_scanned: u64,
    current_progress: f32,
    current_command: String,
    current_message: String,
    estimated_seconds: u64,
    estimated_output_bytes: u64,
    peak_memory_bytes: u64,
    sample_build: bool,
    resume_progress: f32,
    elapsed_offset_seconds: u64,
    resume_path: PathBuf,
    config: Value,
}

impl BuildRecorder {
    fn new(
        job_id: &str,
        output_root: &Path,
        telemetry_root: &Path,
        config: &Value,
        resume_progress: f32,
        elapsed_offset_seconds: u64,
    ) -> Result<Self, String> {
        let log_path = build_log_path(telemetry_root, output_root);
        let metrics_path = build_metrics_path(telemetry_root, output_root);
        let summary_path = build_summary_path(telemetry_root, output_root);
        let resume_path = build_job_path(telemetry_root, output_root);
        let log_writer = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_path)
            .map(BufWriter::new)
            .map_err(|error| {
                format!(
                    "Could not open map build log {}: {error}",
                    log_path.display()
                )
            })?;
        let metrics_writer = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&metrics_path)
            .map(BufWriter::new)
            .map_err(|error| {
                format!(
                    "Could not open map build metrics {}: {error}",
                    metrics_path.display()
                )
            })?;
        let mut log_writer = log_writer;
        writeln!(
            log_writer,
            "\n=== map build job {job_id} started at {}; output={} ===",
            Utc::now().to_rfc3339(),
            output_root.display()
        )
        .map_err(|error| format!("Could not initialize map build log: {error}"))?;
        Ok(Self {
            job_id: job_id.to_string(),
            output_root: output_root.to_path_buf(),
            log_writer,
            metrics_writer,
            summary_path,
            started_at: Instant::now(),
            // The elapsed timer represents the complete logical job, including
            // time spent in an earlier run before the resume.
            started_at_unix_ms: unix_time_millis()
                .saturating_sub(elapsed_offset_seconds.saturating_mul(1_000)),
            initial_available_bytes: available_space(output_root),
            last_sample_at: None,
            last_sample_command: None,
            sample_count: 0,
            progress_events: 0,
            cells_scanned: 0,
            current_progress: 0.0,
            current_command: "starting".to_string(),
            current_message: "Rust map builder is starting.".to_string(),
            estimated_seconds: 0,
            estimated_output_bytes: 0,
            peak_memory_bytes: 0,
            sample_build: false,
            resume_progress: resume_progress.clamp(0.0, 99.0),
            elapsed_offset_seconds,
            resume_path,
            config: config.clone(),
        })
    }

    fn set_estimate(&mut self, estimate: &DiskEstimate) {
        self.estimated_seconds = estimate.estimated_seconds;
        self.estimated_output_bytes = estimate.output_bytes;
        self.peak_memory_bytes = estimate.peak_memory_bytes;
    }

    fn emit(&mut self, progress: f32, command: &str, message: &str) {
        let progress = if self.resume_progress > 0.0 {
            self.resume_progress
                + (100.0 - self.resume_progress) * progress.clamp(0.0, 100.0) / 100.0
        } else {
            progress
        };
        self.current_progress = progress;
        self.current_command = command.to_string();
        self.current_message = message.to_string();
        self.progress_events = self.progress_events.saturating_add(1);
        if command.eq_ignore_ascii_case("scan") {
            if let Some(count) = message
                .split("scan found ")
                .nth(1)
                .and_then(|value| value.split_whitespace().next())
                .and_then(|value| value.parse::<u64>().ok())
            {
                self.cells_scanned = count;
            }
        }

        let timestamp = Utc::now().to_rfc3339();
        let _ = writeln!(
            self.log_writer,
            "{timestamp} +{:.1}s progress={progress:.3} [{command}] {message}",
            self.started_at.elapsed().as_secs_f64()
        );
        println!("PROGRESS|{progress}|{command}|{message}");
        std::io::stdout().flush().ok();

        let command_changed = self
            .last_sample_command
            .as_deref()
            .is_none_or(|value| value != command);
        let interval_elapsed = self
            .last_sample_at
            .is_none_or(|value| value.elapsed().as_secs() >= 15);
        if command_changed || interval_elapsed || progress >= 100.0 {
            self.record("running");
        }
    }

    fn record(&mut self, state: &str) {
        let available_bytes = available_space(&self.output_root);
        let metrics = BuildMetrics {
            sample_count: self.sample_count.saturating_add(1),
            progress_events: self.progress_events,
            cells_scanned: self.cells_scanned,
            elapsed_seconds: self
                .elapsed_offset_seconds
                .saturating_add(self.started_at.elapsed().as_secs()),
            disk_used_bytes: self.initial_available_bytes.saturating_sub(available_bytes),
            available_bytes,
            estimated_seconds: self.estimated_seconds,
            estimated_output_bytes: self.estimated_output_bytes,
            peak_memory_bytes: self.peak_memory_bytes,
            sample_build: self.sample_build,
            stage: self.current_command.clone(),
            last_message: self.current_message.clone(),
            last_sample_at: Some(Utc::now().to_rfc3339()),
        };
        let event = BuildMetricEvent {
            job_id: self.job_id.clone(),
            state: state.to_string(),
            progress: self.current_progress,
            command: self.current_command.clone(),
            message: self.current_message.clone(),
            metrics: metrics.clone(),
        };
        if let Ok(line) = serde_json::to_string(&event) {
            let _ = writeln!(self.metrics_writer, "{line}");
            let _ = self.metrics_writer.flush();
            let _ = self.log_writer.flush();
            println!("METRICS|{line}");
            std::io::stdout().flush().ok();
        }
        let _ = write_persisted_build_job(
            &self.resume_path,
            &PersistedBuildJob {
                job_id: self.job_id.clone(),
                state: state.to_string(),
                progress: self.current_progress,
                current_command: self.current_command.clone(),
                message: self.current_message.clone(),
                output_path: path_string(&self.output_root),
                elapsed_seconds: metrics.elapsed_seconds,
                started_at_unix_ms: self.started_at_unix_ms,
                config: self.config.clone(),
                metrics: metrics.clone(),
            },
        );
        self.sample_count = metrics.sample_count;
        self.last_sample_at = Some(Instant::now());
        self.last_sample_command = Some(self.current_command.clone());
    }

    fn finish(&mut self, state: &str, message: &str) {
        self.current_message = message.to_string();
        let timestamp = Utc::now().to_rfc3339();
        let _ = writeln!(
            self.log_writer,
            "{timestamp} [final] state={state}; {message}"
        );
        self.record(state);
        let summary = json!({
            "job_id": self.job_id,
            "state": state,
            "started_at": self.started_at_unix_ms,
            "finished_at": unix_time_millis(),
            "elapsed_seconds": self
                .elapsed_offset_seconds
                .saturating_add(self.started_at.elapsed().as_secs()),
            "progress": self.current_progress,
            "command": self.current_command,
            "message": self.current_message,
            "metrics": {
                "sample_count": self.sample_count,
                "progress_events": self.progress_events,
                "cells_scanned": self.cells_scanned,
                "disk_used_bytes": self
                    .initial_available_bytes
                    .saturating_sub(available_space(&self.output_root)),
                "available_bytes": available_space(&self.output_root),
                "estimated_seconds": self.estimated_seconds,
                "estimated_output_bytes": self.estimated_output_bytes,
                "peak_memory_bytes": self.peak_memory_bytes,
            }
        });
        if let Ok(data) = serde_json::to_vec_pretty(&summary) {
            let _ = fs::write(&self.summary_path, data);
        }
    }
}

#[tauri::command]
pub fn estimate_pzmap2dzi_build(app: AppHandle, config: Value) -> Result<DiskEstimate, String> {
    let telemetry_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve the application data directory: {error}"))?;
    estimate_build_with_history(&config, Some(&telemetry_root))
}

#[tauri::command]
pub fn inspect_pzmap2dzi_output(config: Value) -> Result<OutputDirectoryStatus, String> {
    let path = output_root_path(&config);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "Could not inspect the map output directory {}: {error}",
                path.display()
            ));
        }
    };
    Ok(OutputDirectoryStatus {
        path: path.display().to_string(),
        exists: metadata.is_some(),
        is_directory: metadata.is_some_and(|value| value.is_dir()),
    })
}

#[tauri::command]
pub fn inspect_pzmap2dzi_resume(
    app: AppHandle,
    config: Value,
) -> Result<Option<MapBuildResumeCandidate>, String> {
    let telemetry_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve the application data directory: {error}"))?;
    let output_root = output_root_path(&config);
    if !output_root.is_dir() {
        return Ok(None);
    }
    let Some(job) = read_persisted_build_job(&telemetry_root, &output_root)? else {
        return Ok(None);
    };
    if job.state == "completed" || job.progress >= 99.9 {
        return Ok(None);
    }
    Ok(Some(MapBuildResumeCandidate {
        job_id: job.job_id,
        state: job.state,
        progress: job.progress,
        current_command: job.current_command,
        message: job.message,
        output_path: job.output_path,
        elapsed_seconds: job.elapsed_seconds,
        started_at_unix_ms: job.started_at_unix_ms,
        config: job.config,
    }))
}

#[tauri::command]
pub fn prepare_pzmap2dzi_output(
    config: Value,
    confirmed: bool,
) -> Result<OutputDirectoryStatus, String> {
    if !confirmed {
        return Err("Replacing the existing map output was not confirmed.".to_string());
    }
    let path = output_root_path(&config);
    if fs::symlink_metadata(&path).is_ok() {
        remove_existing_output(&path)?;
    }
    inspect_pzmap2dzi_output(config)
}

#[tauri::command]
pub fn parse_pzmap2dzi_yaml(content: String) -> Result<Value, String> {
    let yaml: serde_yaml::Value = serde_yaml::from_str(&content)
        .map_err(|error| format!("Could not parse map builder YAML: {error}"))?;
    serde_json::to_value(yaml)
        .map_err(|error| format!("Could not convert map builder YAML to settings: {error}"))
}

#[tauri::command]
pub fn serialize_pzmap2dzi_yaml(config: Value) -> Result<String, String> {
    let yaml = serde_yaml::to_string(&config)
        .map_err(|error| format!("Could not serialize map builder settings: {error}"))?;
    Ok(format!(
        "# Honu Project Zomboid map builder settings\n# Importing this file opens the builder in Custom mode.\n---\n{yaml}"
    ))
}

#[tauri::command]
pub fn get_pzmap2dzi_build_status(manager: State<'_, BuildManager>) -> BuildStatus {
    manager.snapshot()
}

#[tauri::command]
pub fn start_pzmap2dzi_build(
    app: AppHandle,
    manager: State<'_, BuildManager>,
    config: Value,
    replace_existing_output: Option<bool>,
    resume_existing_output: Option<bool>,
) -> Result<BuildStatus, String> {
    let current = manager.snapshot();
    if current.state == "starting" || current.state == "running" || current.state == "stopping" {
        return Err("A Rust map build is already running.".to_string());
    }

    let telemetry_root = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not resolve the application data directory: {error}"))?;
    fs::create_dir_all(&telemetry_root).map_err(|error| {
        format!(
            "Could not create the application telemetry directory {}: {error}",
            telemetry_root.display()
        )
    })?;
    let resume_requested = resume_existing_output.unwrap_or(false);
    let resume_candidate = if resume_requested {
        let output_root = output_root_path(&config);
        Some(
            read_persisted_build_job(&telemetry_root, &output_root)?
                .filter(|job| job.state != "completed" && job.progress < 99.9)
                .ok_or_else(|| {
                    "No stopped map job is available to resume for this output directory."
                        .to_string()
                })?,
        )
    } else {
        None
    };
    let config = resume_candidate
        .as_ref()
        .map(|candidate: &PersistedBuildJob| candidate.config.clone())
        .unwrap_or(config);
    let output_root = output_root_path(&config);
    let resume_progress = resume_candidate
        .as_ref()
        .map(|candidate| candidate.progress.clamp(0.0, 99.0))
        .unwrap_or(0.0);
    let resume_elapsed_seconds = resume_candidate
        .as_ref()
        .map(|candidate| candidate.elapsed_seconds)
        .unwrap_or(0);
    let resume_current_command = resume_candidate
        .as_ref()
        .map(|candidate| candidate.current_command.clone())
        .unwrap_or_default();
    let resume_disk_used_bytes = resume_candidate
        .as_ref()
        .map(|candidate| candidate.metrics.disk_used_bytes)
        .unwrap_or(0);
    let output_was_replaced = match fs::symlink_metadata(&output_root) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(format!(
                "Could not inspect the map output directory {}: {error}",
                output_root.display()
            ));
        }
    };
    if output_was_replaced && !resume_requested {
        if !replace_existing_output.unwrap_or(false) {
            return Err(format!(
                "The map output directory already exists: {}. Confirm replacement before starting the build.",
                output_root.display()
            ));
        }
        remove_existing_output(&output_root)?;
    }
    if resume_requested && output_was_replaced && !output_root.is_dir() {
        return Err(format!(
            "The saved map job cannot be resumed because its output path is not a directory: {}",
            output_root.display()
        ));
    }

    let full_estimate = estimate_build_with_history(&config, Some(&telemetry_root))?;
    let estimate = if resume_requested {
        estimate_for_resume(
            full_estimate.clone(),
            resume_progress,
            &resume_current_command,
            resume_elapsed_seconds,
            resume_disk_used_bytes,
        )
    } else {
        full_estimate.clone()
    };
    if !estimate.enough_space {
        return Err(format!(
            "Not enough free space on the output drive. The build needs approximately {} but only {} is available.",
            format_bytes(estimate.output_bytes),
            format_bytes(estimate.available_bytes),
        ));
    }

    let job_id = format!(
        "pzmap2dzi-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis()
    );
    clear_build_log(&telemetry_root, &output_root)?;
    if !resume_requested {
        clear_persisted_build_job(&telemetry_root, &output_root)?;
    }
    let started_at_unix_ms =
        unix_time_millis().saturating_sub(resume_elapsed_seconds.saturating_mul(1_000));
    write_persisted_build_job(
        &build_job_path(&telemetry_root, &output_root),
        &PersistedBuildJob {
            job_id: job_id.clone(),
            state: "starting".to_string(),
            progress: resume_progress,
            current_command: "rust-pzmap2dzi --worker".to_string(),
            message: if resume_requested {
                format!(
                    "Resuming map job from {:.0}% using its saved settings…",
                    resume_progress
                )
            } else {
                "Starting the native Rust map builder…".to_string()
            },
            output_path: path_string(&output_root),
            elapsed_seconds: resume_elapsed_seconds,
            started_at_unix_ms,
            config: config.clone(),
            metrics: BuildMetrics {
                estimated_seconds: full_estimate.estimated_seconds,
                estimated_output_bytes: full_estimate.output_bytes,
                sample_build: config_bool(&config, "sample_build"),
                ..BuildMetrics::default()
            },
        },
    )?;
    let temp_root = std::env::temp_dir();
    let config_path = temp_root.join(format!("{job_id}.json"));
    let stop_path = temp_root.join(format!("{job_id}.stop"));
    let worker_config = WorkerConfig {
        job_id: job_id.clone(),
        config_path: config_path.clone(),
        stop_path: stop_path.clone(),
        telemetry_root: telemetry_root.clone(),
        resume_progress,
        resume_elapsed_seconds,
        resume_current_command,
        resume_from_job_id: resume_candidate
            .as_ref()
            .map(|candidate| candidate.job_id.clone()),
    };
    fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "config": config,
            "worker": worker_config,
        }))
        .map_err(|error| format!("Could not serialize build configuration: {error}"))?,
    )
    .map_err(|error| format!("Could not create the Rust build configuration: {error}"))?;

    fs::remove_file(&stop_path).ok();
    *manager.stop_file.lock().expect("stop file lock poisoned") = Some(stop_path.clone());
    manager.update(|status| {
        *status = BuildStatus {
            job_id: Some(job_id.clone()),
            state: "starting".to_string(),
            progress: resume_progress,
            current_command: "rust-pzmap2dzi --worker".to_string(),
            message: if resume_requested {
                format!(
                    "Resuming map job from {:.0}% using its saved settings…",
                    resume_progress
                )
            } else {
                "Starting the native Rust map builder…".to_string()
            },
            logs: vec![
                if resume_requested {
                    format!(
                        "Resuming stopped job {} without deleting {}",
                        resume_candidate
                            .as_ref()
                            .map(|candidate| candidate.job_id.as_str())
                            .unwrap_or("unknown"),
                        output_root.display()
                    )
                } else if output_was_replaced {
                    format!(
                        "Removed existing map output directory: {}",
                        output_root.display()
                    )
                } else {
                    format!("Map output directory: {}", output_root.display())
                },
                format!("Estimated output: {}", format_bytes(estimate.output_bytes)),
                format!(
                    "Estimated processing: {} seconds; planning peak memory: {}",
                    estimate.estimated_seconds,
                    format_bytes(estimate.peak_memory_bytes)
                ),
                format!("Estimate basis: {}", estimate.estimate_basis),
                if config_bool(&config, "sample_build") {
                    "Sample mode: one available map cell; save games and mod maps are skipped."
                        .to_string()
                } else {
                    "Full map mode: all configured cells, saves, and mod maps are eligible."
                        .to_string()
                },
                format!(
                    "Verbose log: {}",
                    build_log_path(&telemetry_root, &output_root).display()
                ),
                format!(
                    "Metrics history: {}",
                    build_metrics_path(&telemetry_root, &output_root).display()
                ),
            ],
            estimate: Some(estimate),
            started_at_unix_ms: Some(started_at_unix_ms),
            last_activity_unix_ms: Some(unix_time_millis()),
            elapsed_seconds: 0,
            metrics_path: Some(path_string(&build_metrics_path(
                &telemetry_root,
                &output_root,
            ))),
            log_path: Some(path_string(&build_log_path(&telemetry_root, &output_root))),
            metrics: BuildMetrics::default(),
        };
    });

    let status = Arc::clone(&manager.status);
    let stop_file = Arc::clone(&manager.stop_file);
    let worker_pid = Arc::clone(&manager.worker_pid);
    thread::spawn(move || {
        let spawn_result = spawn_worker(&config_path, &stop_path);
        let Ok(mut child) = spawn_result else {
            let error = spawn_result
                .err()
                .unwrap_or_else(|| "Unknown worker startup error".to_string());
            update_status(&status, |current| {
                current.state = "error".to_string();
                current.message = error.clone();
                current.logs.push(error);
                update_terminal_elapsed(current);
            });
            fs::remove_file(&config_path).ok();
            fs::remove_file(&stop_path).ok();
            *stop_file.lock().expect("stop file lock poisoned") = None;
            *worker_pid.lock().expect("worker pid lock poisoned") = None;
            return;
        };

        *worker_pid.lock().expect("worker pid lock poisoned") = Some(child.id());
        if stop_path.is_file() {
            let _ = kill_worker_process(child.id());
        }

        let stderr_log_path = status
            .lock()
            .ok()
            .and_then(|current| current.log_path.clone())
            .map(PathBuf::from);
        let stderr_thread = child.stderr.take().map(|stderr| {
            let status = Arc::clone(&status);
            let stderr_log_path = stderr_log_path.clone();
            thread::spawn(move || {
                let mut log_writer = stderr_log_path.and_then(|path| {
                    OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(path)
                        .ok()
                        .map(BufWriter::new)
                });
                BufReader::new(stderr)
                    .lines()
                    .map_while(Result::ok)
                    .map(|line| {
                        if let Some(writer) = log_writer.as_mut() {
                            let _ = writeln!(
                                writer,
                                "{} [worker stderr] {line}",
                                Utc::now().to_rfc3339()
                            );
                            let _ = writer.flush();
                        }
                        update_status(&status, |current| {
                            current.logs.push(format!("worker stderr: {line}"));
                        });
                        line
                    })
                    .collect::<Vec<_>>()
            })
        });

        update_status(&status, |current| {
            current.state = "running".to_string();
            current.message = "Rust map builder is running.".to_string();
        });

        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                handle_worker_line(&status, &line);
            }
        }

        let result = child.wait();
        let stderr_lines = stderr_thread
            .and_then(|thread| thread.join().ok())
            .unwrap_or_default();
        let stopped = stop_path.is_file();
        update_status(&status, |current| {
            if stopped || current.state == "stopping" {
                current.state = "stopped".to_string();
                current.message =
                    "Map build stopped. Job state and completed output were saved and can be continued."
                        .to_string();
                current.progress = current.progress.min(99.0);
                current.logs.push(current.message.clone());
            } else if result.as_ref().is_ok_and(std::process::ExitStatus::success) {
                current.state = "completed".to_string();
                current.progress = 100.0;
                current.current_command = "complete".to_string();
                current.message = "Rust map build completed.".to_string();
            } else {
                current.state = "error".to_string();
                let detail = stderr_lines
                    .last()
                    .map(|line| format!(" Last worker error: {line}"))
                    .unwrap_or_default();
                current.message =
                    format!("Rust map builder exited unexpectedly: {result:?}.{detail}");
                if !stderr_lines.is_empty() {
                    current.logs.push(format!(
                        "Worker stderr captured: {} line(s)",
                        stderr_lines.len()
                    ));
                }
            }
            update_terminal_elapsed(current);
        });
        fs::remove_file(&config_path).ok();
        fs::remove_file(&stop_path).ok();
        *stop_file.lock().expect("stop file lock poisoned") = None;
        *worker_pid.lock().expect("worker pid lock poisoned") = None;
    });

    Ok(manager.snapshot())
}

#[tauri::command]
pub fn stop_pzmap2dzi_build(manager: State<'_, BuildManager>) -> Result<BuildStatus, String> {
    request_stop(&manager)
}

#[tauri::command]
pub fn terminate_pzmap2dzi_build(manager: State<'_, BuildManager>) -> Result<BuildStatus, String> {
    let current = manager.snapshot();
    if current.state != "starting" && current.state != "running" && current.state != "stopping" {
        return Ok(current);
    }
    if current.state != "stopping" {
        request_stop(&manager)?;
    }
    let worker_pid = manager
        .worker_pid
        .lock()
        .expect("worker pid lock poisoned")
        .to_owned();
    if let Some(pid) = worker_pid {
        kill_worker_process(pid)?;
    }
    Ok(manager.snapshot())
}

fn request_stop(manager: &BuildManager) -> Result<BuildStatus, String> {
    let current = manager.snapshot();
    if current.state != "starting" && current.state != "running" {
        return Ok(current);
    }

    let stop_path = manager
        .stop_file
        .lock()
        .expect("stop file lock poisoned")
        .clone()
        .ok_or_else(|| "The active build has no stop signal.".to_string())?;
    File::create(stop_path)
        .map_err(|error| format!("Could not signal the Rust worker: {error}"))?;
    let save_message = "STOP requested by user. Saving the current job state and completed output so this map build can be continued.";
    manager.update(|status| {
        status.state = "stopping".to_string();
        status.message = "Saving map job state for continuation…".to_string();
        status.logs.push(save_message.to_string());
    });
    if let Some(log_path) = current.log_path.as_deref() {
        let _ = append_build_log(Path::new(log_path), save_message);
    }
    Ok(manager.snapshot())
}

#[cfg(windows)]
fn kill_worker_process(pid: u32) -> Result<(), String> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|error| format!("Could not kill the Rust map worker: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "The Rust map worker could not be killed (exit status {status})."
        ))
    }
}

#[cfg(unix)]
fn kill_worker_process(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status()
        .map_err(|error| format!("Could not stop the Rust map worker: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "The Rust map worker could not be stopped (exit status {status})."
        ))
    }
}

#[cfg(not(any(windows, unix)))]
fn kill_worker_process(_pid: u32) -> Result<(), String> {
    Err("This platform does not support terminating the Rust map worker.".to_string())
}

pub fn run_worker_if_requested() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--pzmap2dzi-worker") {
        return false;
    }

    let Some(config_path) = args.next() else {
        eprintln!("pzmap2dzi worker requires a configuration path");
        std::process::exit(2);
    };
    let result = run_worker(Path::new(&config_path));
    if let Err(error) = result {
        println!("ERROR|{error}");
        std::process::exit(1);
    }
    std::process::exit(0);
}

fn spawn_worker(config_path: &Path, stop_path: &Path) -> Result<std::process::Child, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not locate the Rust map builder executable: {error}"))?;
    let mut command = Command::new(executable);
    command
        .arg("--pzmap2dzi-worker")
        .arg(config_path)
        .env("PZMAP2DZI_STOP_FILE", stop_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .spawn()
        .map_err(|error| format!("Could not start the Rust map worker: {error}"))
}

fn run_worker(path: &Path) -> Result<(), String> {
    let envelope: Value = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("Could not read worker configuration: {error}"))?,
    )
    .map_err(|error| format!("Could not parse worker configuration: {error}"))?;
    let config = envelope
        .get("config")
        .ok_or_else(|| "Worker configuration is missing the form data.".to_string())?;
    let worker: WorkerConfig = serde_json::from_value(
        envelope
            .get("worker")
            .cloned()
            .ok_or_else(|| "Worker configuration is missing worker settings.".to_string())?,
    )
    .map_err(|error| format!("Could not parse worker settings: {error}"))?;

    let output_root = output_root_path(config);
    let telemetry_root = if worker.telemetry_root.as_os_str().is_empty() {
        std::env::temp_dir().join("pz-honus-hub")
    } else {
        worker.telemetry_root.clone()
    };
    fs::create_dir_all(&telemetry_root).map_err(|error| {
        format!(
            "Could not create the application telemetry directory {}: {error}",
            telemetry_root.display()
        )
    })?;
    fs::create_dir_all(&output_root)
        .map_err(|error| format!("Could not create map output root: {error}"))?;
    let output_html = output_html_path(config);
    let mut recorder = BuildRecorder::new(
        &worker.job_id,
        &output_root,
        &telemetry_root,
        config,
        worker.resume_progress,
        worker.resume_elapsed_seconds,
    )?;
    let sample_build = config_bool(config, "sample_build");
    recorder.sample_build = sample_build;
    if let Ok(estimate) = estimate_build_with_history(config, Some(&telemetry_root)) {
        recorder.set_estimate(&estimate);
    }
    if let Some(previous_job_id) = worker.resume_from_job_id.as_deref() {
        recorder.emit(
            0.0,
            "resume",
            &format!(
                "Resuming from stopped job {previous_job_id}; completed output tiles will be reused when their cache markers are valid"
            ),
        );
    }
    let worker_count = configure_rayon(config);
    let pyramid_backend = pzmap2dzi_renderer::configured_pyramid_backend(config);
    let verbose = config_bool(config, "verbose");
    let profile = config_bool(config, "profile");
    crate::timing::set_profile_enabled(profile);
    recorder.emit(
        0.0,
        "telemetry",
        &format!(
            "Full verbose output log: {}",
            build_log_path(&telemetry_root, &output_root).display()
        ),
    );
    recorder.emit(
        0.0,
        "telemetry",
        &format!(
            "Full metrics history: {}",
            build_metrics_path(&telemetry_root, &output_root).display()
        ),
    );
    recorder.emit(
        0.0,
        "telemetry",
        &format!(
            "Build job {} started; output root={}; worker process logical cores={worker_count}; pyramid backend={}",
            worker.job_id,
            output_root.display(),
            pyramid_backend.label()
        ),
    );
    let result = (|| {
        if verbose {
            recorder.emit(
                0.0,
                "config",
                &format!(
                    "Rust renderer configured for {worker_count} worker(s); requested_cpu_cores={}; pyramid_backend={}; enable_cache={}, cache_limit_mb={} (cell rendering remains disk-streamed)",
                    config_value_string(config, "worker_count").unwrap_or_else(|| "auto".into()),
                    pyramid_backend.label(),
                    config_bool_default(config, "enable_cache", false),
                    config_value_string(config, "cache_limit_mb").unwrap_or_else(|| "0".into())
                ),
            );
            recorder.emit(
                0.0,
                "config",
                if sample_build {
                    "sample_build=true; rendering one available static-map cell"
                } else {
                    "verbose logging enabled; progress and telemetry are being recorded"
                },
            );
            if let Some(break_key) = config_string(config, "break_key")
                && !break_key.trim().is_empty()
            {
                recorder.emit(
                    0.0,
                    "config",
                    &format!("break_key={break_key} mapped to the native stop-file control"),
                );
            }
        }

        run_stage(
            &worker.stop_path,
            0.0,
            "deploy",
            &format!("rust-pzmap2dzi deploy --output={}", output_root.display()),
            &mut recorder,
            |_recorder| {
                fs::create_dir_all(output_html.join("map_data"))
                    .map_err(|error| format!("Could not create map output: {error}"))?;
                write_deploy_config(&output_html, config)
            },
        )?;
        let source_root = config_string(config, "pz_root")
            .map(|value| filesystem_path(&value))
            .unwrap_or_else(|| PathBuf::from("."));
        run_stage(
            &worker.stop_path,
            30.0,
            "scan",
            &format!(
                "rust-pzmap2dzi scan --headers --source={}",
                source_root.display()
            ),
            &mut recorder,
            |recorder| {
                let cell_count = pzmap2dzi_renderer::preflight_map_sources(config)?;
                recorder.emit(
                    45.0,
                    "scan",
                    &format!("rust-pzmap2dzi scan found {cell_count} base-map cell headers"),
                );
                Ok(())
            },
        )?;
        run_stage(
            &worker.stop_path,
            60.0,
            "render",
            if sample_build {
                "rust-pzmap2dzi render --sample-cell --cpu-rayon --disk-stream"
            } else {
                if config_bool_default(config, "enable_cache", false) {
                    "rust-pzmap2dzi render --cpu-rayon --ram-cache --disk-stream"
                } else {
                    "rust-pzmap2dzi render --cpu-rayon --disk-stream"
                }
            },
            &mut recorder,
            |recorder| {
                let started = Instant::now();
                let result = pzmap2dzi_renderer::render_map_views(
                    config,
                    &output_html,
                    &worker.stop_path,
                    |progress, command, message| recorder.emit(progress, command, message),
                );
                if profile {
                    recorder.emit(
                        81.0,
                        "profile",
                        &format!(
                            "Rust render stage completed in {:.1}s",
                            started.elapsed().as_secs_f64()
                        ),
                    );
                }
                result
            },
        )?;
        recorder.emit(100.0, "complete", "rust-pzmap2dzi build complete");
        Ok(())
    })();
    let stopped = worker.stop_path.is_file();
    let final_state = if stopped {
        "stopped"
    } else if result.is_ok() {
        "completed"
    } else {
        "error"
    };
    let final_message = if stopped {
        "Map build stopped. Job state and completed output were saved and can be continued."
            .to_string()
    } else {
        result
            .as_ref()
            .err()
            .cloned()
            .unwrap_or_else(|| "rust-pzmap2dzi build complete".to_string())
    };
    recorder.finish(final_state, &final_message);
    result
}

fn run_stage<F>(
    stop_path: &Path,
    progress: f32,
    command: &str,
    display_command: &str,
    recorder: &mut BuildRecorder,
    action: F,
) -> Result<(), String>
where
    F: FnOnce(&mut BuildRecorder) -> Result<(), String>,
{
    recorder.emit(progress, command, display_command);
    ensure_not_stopped(stop_path)?;
    let started = Instant::now();
    action(recorder)?;
    let completed_progress = recorder.current_progress;
    recorder.emit(
        completed_progress,
        command,
        &format!(
            "{command} stage completed in {:.1}s",
            started.elapsed().as_secs_f64()
        ),
    );
    ensure_not_stopped(stop_path)
}

fn write_deploy_config(output_html: &Path, config: &Value) -> Result<(), String> {
    let entry = config_string(config, "output_entry").unwrap_or_else(|| "default".to_string());
    let route = config_string(config, "output_route").unwrap_or_else(|| "map_data/".to_string());
    let data = json!({
        "route": { entry: route },
        "features": {
            "map": true, "grid": true, "marker": true, "trimmer": true,
            "zombie": true, "foraging": true, "rooms": true, "objects": true,
            "streets": true, "coords": true
        },
        "version": "rust-pzmap2dzi",
        "git_branch": "",
        "git_commit": ""
    });
    fs::write(
        output_html.join("pzmap_config.json"),
        serde_json::to_vec_pretty(&data).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn ensure_not_stopped(path: &Path) -> Result<(), String> {
    if path.is_file() {
        return Err("Build stopped by user.".to_string());
    }
    Ok(())
}

fn handle_worker_line(status: &Arc<Mutex<BuildStatus>>, line: &str) {
    if let Some(rest) = line.strip_prefix("PROGRESS|") {
        let mut parts = rest.splitn(3, '|');
        let progress = parts
            .next()
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(0.0);
        let command = parts.next().unwrap_or("worker").to_string();
        let message = parts.next().unwrap_or(line).to_string();
        update_status(status, |current| {
            current.progress = progress;
            current.current_command = command;
            current.message = message.clone();
            current.add_log(message);
        });
        return;
    }
    if let Some(rest) = line.strip_prefix("METRICS|") {
        if let Ok(event) = serde_json::from_str::<BuildMetricEvent>(rest) {
            update_status(status, |current| {
                current.progress = event.progress;
                current.current_command = event.command;
                current.message = event.message;
                current.metrics = event.metrics;
            });
            return;
        }
    }
    update_status(status, |current| {
        current.add_log(line);
    });
}

fn update_status(status: &Arc<Mutex<BuildStatus>>, update: impl FnOnce(&mut BuildStatus)) {
    let mut current = status.lock().expect("build status lock poisoned");
    update(&mut current);
    current.last_activity_unix_ms = Some(unix_time_millis());
}

#[cfg(test)]
fn estimate_build(config: &Value) -> Result<DiskEstimate, String> {
    estimate_build_with_history(config, None)
}

fn estimate_build_with_history(
    config: &Value,
    telemetry_root: Option<&Path>,
) -> Result<DiskEstimate, String> {
    let output_path = output_root_path(config).to_string_lossy().to_string();
    let source_path = config_string(config, "pz_root")
        .map(|value| filesystem_path(&value))
        .unwrap_or_else(|| PathBuf::from("."));
    let source_bytes = ULTRA_REFERENCE_OUTPUT_BYTES;
    let map_count = additional_map_count(config);
    let sample_build = config_bool(config, "sample_build");
    let base_config = estimate_command_config(config, "base");
    let top_config = estimate_command_config(config, "base_top");
    let base_render = estimate_render_settings(&base_config, false);
    let top_render = estimate_render_settings(&top_config, true);
    let coverage = estimate_coverage(config);
    let worker_count = estimate_worker_count(config);
    let pyramid_backend = pzmap2dzi_renderer::configured_pyramid_backend(config);
    let peak_memory_bytes = estimate_peak_memory(worker_count);

    let (computed, estimated_seconds, estimate_basis, explanation) = if sample_build {
        let sample_bytes =
            (64 * 1024 * 1024) as f64 * base_render.size_factor.min(1.0) * coverage.factor;
        (
            sample_bytes.max(SAMPLE_MINIMUM_BUILD_BYTES as f64) as u64,
            120,
            "Sample estimate: one sampled map cell, with the full renderer skipped for global scans."
                .to_string(),
            format!(
                "Sample estimate for one sampled map cell; {}. The full-map estimate uses the documented stage benchmarks and the local Ultra output calibration.",
                base_render.description
            ),
        )
    } else {
        let overlay = estimate_overlays(config, &base_config);
        let documented_total = DOC_ISOMETRIC_BYTES
            + DOC_TOP_BYTES
            + DOC_ZOMBIE_BYTES
            + DOC_FORAGING_BYTES
            + DOC_ROOMS_BYTES
            + DOC_OBJECTS_BYTES;
        let reference_iso = scale_reference(DOC_ISOMETRIC_BYTES, documented_total);
        let reference_top = scale_reference(DOC_TOP_BYTES, documented_total);
        let reference_zombie = scale_reference(DOC_ZOMBIE_BYTES, documented_total);
        let reference_foraging = scale_reference(DOC_FORAGING_BYTES, documented_total);
        let reference_rooms = scale_reference(DOC_ROOMS_BYTES, documented_total)
            .saturating_mul(overlay.rooms_factor_percent as u64)
            .saturating_div(100);
        let reference_objects = scale_reference(DOC_OBJECTS_BYTES, documented_total)
            .saturating_mul(overlay.objects_factor_percent as u64)
            .saturating_div(100);
        let known_reference = reference_iso
            .saturating_add(reference_top)
            .saturating_add(reference_zombie)
            .saturating_add((reference_foraging as f64 * overlay.foraging_factor) as u64)
            .saturating_add(reference_rooms)
            .saturating_add(reference_objects);
        let residual_reference = source_bytes.saturating_sub(known_reference);
        let primary_render_factor = base_render.size_factor * coverage.factor;
        let primary_top_factor = top_render.size_factor * coverage.factor;
        let base_bytes = (reference_iso as f64 * primary_render_factor) as u64;
        let top_bytes = (reference_top as f64 * primary_top_factor) as u64;
        let overlay_reference_bytes = scale_reference(overlay.zombie_bytes, documented_total)
            .saturating_add(
                (scale_reference(overlay.foraging_bytes, documented_total) as f64
                    * overlay.foraging_factor) as u64,
            )
            .saturating_add(
                scale_reference(overlay.rooms_bytes, documented_total)
                    .saturating_mul(overlay.rooms_factor_percent)
                    .saturating_div(100),
            )
            .saturating_add(
                scale_reference(overlay.objects_bytes, documented_total)
                    .saturating_mul(overlay.objects_factor_percent)
                    .saturating_div(100),
            );
        let overlay_bytes = (overlay_reference_bytes as f64 * coverage.factor) as u64;
        let residual_bytes = (residual_reference as f64
            * primary_render_factor.max(primary_top_factor).max(0.15)
            * coverage.factor) as u64;
        let primary_bytes = base_bytes
            .saturating_add(top_bytes)
            .saturating_add(overlay_bytes)
            .saturating_add(residual_bytes);
        let additional_bytes = (primary_bytes as f64 * map_count as f64 * 0.25) as u64;
        let (save_count, save_scope) = estimate_save_selection(config);
        let save_bytes =
            ((base_bytes.saturating_add(top_bytes)) as f64 * save_count as f64 * 0.08) as u64;
        let computed = primary_bytes
            .saturating_add(additional_bytes)
            .saturating_add(save_bytes);

        let appearance_factor = plant_time_factor(&base_config);
        let base_seconds = (render_seconds(base_render.size_factor, DOC_ISOMETRIC_SECONDS) as f64
            * appearance_factor) as u64;
        let top_seconds = (render_seconds(top_render.size_factor, DOC_TOP_SECONDS) as f64
            * appearance_factor) as u64;
        let overlay_seconds = overlay.total_seconds();
        let residual_seconds = ((DOC_TOP_SECONDS / 2) as f64
            * primary_render_factor.max(primary_top_factor).max(0.15)
            * coverage.factor) as u64;
        let primary_seconds = base_seconds
            .saturating_add(top_seconds)
            .saturating_add(((overlay_seconds as f64) * coverage.factor) as u64)
            .saturating_add(residual_seconds);
        let additional_seconds = (primary_seconds as f64 * map_count as f64 * 0.25) as u64;
        let save_seconds =
            ((base_seconds.saturating_add(top_seconds)) as f64 * save_count as f64 * 0.08) as u64;
        let estimated_seconds = scale_for_workers(
            primary_seconds
                .saturating_add(additional_seconds)
                .saturating_add(save_seconds),
            worker_count,
            config_bool_default(config, "enable_cache", false),
        );
        let estimate_basis = format!(
            "B42.6 performance notes (16 workers, NVMe) plus the local Ultra output calibration; {}; pyramid backend={} (GPU acceleration is kept conservative until local metrics calibrate it).",
            coverage.description,
            pyramid_backend.label()
        );
        let explanation = format!(
            "Base {} + top view {} + overlays {} + {} additional map(s) + {}; {}. {}",
            base_render.description,
            top_render.description,
            overlay.description,
            map_count,
            save_scope,
            coverage.description,
            estimate_basis
        );
        (computed, estimated_seconds, estimate_basis, explanation)
    };
    let (minimum_build_bytes, safety_margin_bytes) = if sample_build {
        (SAMPLE_MINIMUM_BUILD_BYTES, SAMPLE_SAFETY_MARGIN_BYTES)
    } else {
        (MINIMUM_BUILD_BYTES, SAFETY_MARGIN_BYTES)
    };
    let base_output_bytes = computed
        .max(minimum_build_bytes)
        .saturating_add(safety_margin_bytes);
    let historical = if sample_build {
        HistoricalEstimate::default()
    } else {
        telemetry_root
            .map(|root| {
                read_historical_estimate(
                    root,
                    Path::new(&output_path),
                    base_output_bytes,
                    estimated_seconds,
                )
            })
            .unwrap_or_default()
    };
    let (output_bytes, estimated_seconds, estimate_basis, explanation) = if historical
        .projected_seconds
        .is_empty()
        && historical.projected_output_bytes.is_empty()
    {
        (
            base_output_bytes,
            estimated_seconds,
            estimate_basis,
            explanation,
        )
    } else {
        let observed_seconds = median(&historical.projected_seconds);
        let observed_output = median(&historical.projected_output_bytes)
            .map(|bytes| bytes.saturating_add(safety_margin_bytes));
        let history_weight = if historical.states.len() >= 2 {
            0.65
        } else {
            0.5
        };
        let calibrated_seconds = observed_seconds
            .map(|value| blend_estimate(estimated_seconds, value, history_weight))
            .unwrap_or(estimated_seconds);
        let calibrated_output = observed_output
            .map(|value| blend_estimate(base_output_bytes, value, history_weight))
            .unwrap_or(base_output_bytes);
        let states = historical
            .states
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let history_note = format!(
            "Metric-calibrated from {} prior run(s), including states: {states}; observed partial runs are projected from their completed progress.",
            historical
                .projected_seconds
                .len()
                .max(historical.projected_output_bytes.len())
        );
        (
            calibrated_output,
            calibrated_seconds,
            format!("{estimate_basis}; {history_note}"),
            format!("{explanation} {history_note}"),
        )
    };
    let available_bytes = available_space(Path::new(&output_path));
    let enough_space = available_bytes >= output_bytes;
    Ok(DiskEstimate {
        source_path: source_path.display().to_string(),
        output_path: output_path.clone(),
        source_bytes,
        output_bytes,
        available_bytes,
        enough_space,
        safety_margin_bytes,
        estimated_seconds,
        peak_memory_bytes,
        historical_run_count: historical
            .projected_seconds
            .len()
            .max(historical.projected_output_bytes.len()) as u64,
        estimate_basis,
        explanation,
    })
}

fn read_historical_estimate(
    telemetry_root: &Path,
    output_root: &Path,
    current_output_bytes: u64,
    current_seconds: u64,
) -> HistoricalEstimate {
    let path = build_metrics_path(telemetry_root, output_root);
    let Ok(content) = fs::read_to_string(path) else {
        return HistoricalEstimate::default();
    };
    let mut latest_by_job = HashMap::<String, BuildMetricEvent>::new();
    for line in content.lines() {
        let Ok(event) = serde_json::from_str::<BuildMetricEvent>(line) else {
            continue;
        };
        if event.metrics.sample_build
            || event.metrics.estimated_output_bytes == 0
            || event.metrics.estimated_seconds == 0
        {
            continue;
        }
        let output_ratio =
            event.metrics.estimated_output_bytes as f64 / current_output_bytes.max(1) as f64;
        let time_ratio = event.metrics.estimated_seconds as f64 / current_seconds.max(1) as f64;
        if !(0.25..=4.0).contains(&output_ratio) || !(0.2..=5.0).contains(&time_ratio) {
            continue;
        }
        latest_by_job
            .entry(event.job_id.clone())
            .and_modify(|latest| {
                if event.metrics.elapsed_seconds >= latest.metrics.elapsed_seconds {
                    *latest = event.clone();
                }
            })
            .or_insert(event);
    }

    let mut history = HistoricalEstimate::default();
    for event in latest_by_job.into_values() {
        let progress = (event.progress as f64).clamp(0.0, 100.0);
        let elapsed = event.metrics.elapsed_seconds;
        if progress < 10.0 || elapsed < 60 {
            continue;
        }
        let projected_seconds = if event.state == "completed" || progress >= 99.0 {
            elapsed
        } else {
            (elapsed as f64 * 100.0 / progress).round() as u64
        };
        if (60..=60 * 60 * 24 * 30).contains(&projected_seconds) {
            history.projected_seconds.push(projected_seconds);
        }
        if event.metrics.disk_used_bytes >= 64 * 1024 * 1024 {
            let projected_bytes = if event.state == "completed" || progress >= 99.0 {
                event.metrics.disk_used_bytes
            } else {
                (event.metrics.disk_used_bytes as f64 * 100.0 / progress).round() as u64
            };
            if projected_bytes >= 64 * 1024 * 1024 {
                history.projected_output_bytes.push(projected_bytes);
            }
        }
        history.states.insert(event.state);
    }
    history
}

fn median(values: &[u64]) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    Some(sorted[sorted.len() / 2])
}

fn blend_estimate(base: u64, observed: u64, history_weight: f64) -> u64 {
    let lower = (base as f64 * 0.35) as u64;
    let upper = (base as f64 * 4.0) as u64;
    let observed = observed.clamp(lower, upper);
    ((base as f64 * (1.0 - history_weight) + observed as f64 * history_weight).round()) as u64
}

fn output_html_path(config: &Value) -> PathBuf {
    output_root_path(config).join("html")
}

fn output_root_path(config: &Value) -> PathBuf {
    let output_root = config_string(config, "output_root")
        .or_else(|| config_string(config, "output_path"))
        .unwrap_or_else(|| "C:/pzmap".to_string());
    filesystem_path(&output_root)
}

fn telemetry_file_stem(output_root: &Path) -> String {
    let raw = output_root
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("map-output");
    let stem = raw
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if stem.is_empty() {
        "map-output".to_string()
    } else {
        stem
    }
}

fn build_log_path(telemetry_root: &Path, output_root: &Path) -> PathBuf {
    telemetry_root.join(format!("{}.build.log", telemetry_file_stem(output_root)))
}

fn clear_build_log(telemetry_root: &Path, output_root: &Path) -> Result<(), String> {
    let path = build_log_path(telemetry_root, output_root);
    OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map(|_| ())
        .map_err(|error| {
            format!(
                "Could not clear the previous map build log {}: {error}",
                path.display()
            )
        })
}

fn append_build_log(path: &Path, message: &str) -> Result<(), String> {
    let mut writer = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            format!(
                "Could not append to map build log {}: {error}",
                path.display()
            )
        })?;
    writeln!(writer, "{} [stop] {message}", Utc::now().to_rfc3339())
        .map_err(|error| format!("Could not write map build log {}: {error}", path.display()))?;
    writer
        .flush()
        .map_err(|error| format!("Could not flush map build log {}: {error}", path.display()))
}

fn build_metrics_path(telemetry_root: &Path, output_root: &Path) -> PathBuf {
    telemetry_root.join(format!(
        "{}.build-metrics.jsonl",
        telemetry_file_stem(output_root)
    ))
}

fn build_summary_path(telemetry_root: &Path, output_root: &Path) -> PathBuf {
    telemetry_root.join(format!(
        "{}.build-metrics.json",
        telemetry_file_stem(output_root)
    ))
}

fn build_job_path(telemetry_root: &Path, output_root: &Path) -> PathBuf {
    telemetry_root.join(format!(
        "{}.build-job.json",
        telemetry_file_stem(output_root)
    ))
}

fn read_persisted_build_job(
    telemetry_root: &Path,
    output_root: &Path,
) -> Result<Option<PersistedBuildJob>, String> {
    let path = build_job_path(telemetry_root, output_root);
    let data = match fs::read_to_string(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not read the previous map job settings {}: {error}",
                path.display()
            ));
        }
    };
    let job = serde_json::from_str::<PersistedBuildJob>(&data).map_err(|error| {
        format!(
            "Could not parse the previous map job settings {}: {error}",
            path.display()
        )
    })?;
    if filesystem_path(&job.output_path) != output_root {
        return Ok(None);
    }
    Ok(Some(job))
}

fn write_persisted_build_job(path: &Path, job: &PersistedBuildJob) -> Result<(), String> {
    let data = serde_json::to_vec_pretty(job).map_err(|error| error.to_string())?;
    fs::write(path, data).map_err(|error| {
        format!(
            "Could not persist map job resume settings {}: {error}",
            path.display()
        )
    })
}

fn clear_persisted_build_job(telemetry_root: &Path, output_root: &Path) -> Result<(), String> {
    let path = build_job_path(telemetry_root, output_root);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Could not clear the previous map job settings {}: {error}",
            path.display()
        )),
    }
}

fn estimate_for_resume(
    mut estimate: DiskEstimate,
    progress: f32,
    current_command: &str,
    elapsed_seconds: u64,
    disk_used_bytes: u64,
) -> DiskEstimate {
    let stage_progress = resume_stage_progress(current_command);
    let effective_progress = progress.clamp(0.0, 99.0).max(stage_progress);
    let remaining_factor = (1.0 - effective_progress as f64 / 100.0).max(0.01);
    let projected_remaining_bytes = estimate.output_bytes.saturating_sub(disk_used_bytes);
    estimate.output_bytes = projected_remaining_bytes.max(estimate.safety_margin_bytes);
    estimate.estimated_seconds =
        (estimate.estimated_seconds as f64 * remaining_factor).ceil() as u64;
    if elapsed_seconds >= 60 && effective_progress >= 10.0 {
        let projected_total_seconds =
            (elapsed_seconds as f64 * 100.0 / effective_progress as f64).ceil() as u64;
        let observed_remaining_seconds = projected_total_seconds.saturating_sub(elapsed_seconds);
        estimate.estimated_seconds =
            blend_estimate(estimate.estimated_seconds, observed_remaining_seconds, 0.35);
    }
    estimate.enough_space = estimate.available_bytes >= estimate.output_bytes;
    estimate.estimate_basis = format!(
        "{}; resume remaining estimate from {:.1}% complete in {}",
        estimate.estimate_basis,
        effective_progress,
        if current_command.trim().is_empty() {
            "the saved build state"
        } else {
            current_command
        }
    );
    estimate.explanation = format!(
        "{} Remaining time and disk usage are recalculated from the saved {:.1}% progress in {}{}.",
        estimate.explanation,
        effective_progress,
        if current_command.trim().is_empty() {
            "the saved build state"
        } else {
            current_command
        },
        if disk_used_bytes > 0 {
            format!(
                " after {} of output-drive usage",
                format_bytes(disk_used_bytes)
            )
        } else {
            String::new()
        }
    );
    estimate
}

fn resume_stage_progress(command: &str) -> f32 {
    let command = command.to_ascii_lowercase();
    if command.contains("pyramid") {
        80.0
    } else if command.contains("overlay") {
        65.0
    } else if command.contains("texture") {
        62.0
    } else if command.contains("render") {
        60.0
    } else if command.contains("scan") {
        30.0
    } else {
        0.0
    }
}

fn remove_existing_output(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        format!(
            "Could not inspect existing map output {}: {error}",
            path.display()
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "The map output path is a symbolic link and will not be deleted: {}",
            path.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!(
            "The map output path exists but is not a directory: {}",
            path.display()
        ));
    }
    let has_normal_component = path
        .components()
        .any(|component| matches!(component, std::path::Component::Normal(_)));
    let has_parent_component = path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir));
    if !has_normal_component || has_parent_component {
        return Err(format!(
            "Refusing to delete an unsafe map output path: {}",
            path.display()
        ));
    }
    fs::remove_dir_all(path).map_err(|error| {
        format!(
            "Could not delete existing map output {}: {error}",
            path.display()
        )
    })
}

#[derive(Debug, Clone)]
struct RenderEstimate {
    size_factor: f64,
    description: String,
}

#[derive(Debug, Clone)]
struct OverlayEstimate {
    zombie_bytes: u64,
    foraging_bytes: u64,
    rooms_bytes: u64,
    objects_bytes: u64,
    zombie_seconds: u64,
    foraging_seconds: u64,
    rooms_seconds: u64,
    objects_seconds: u64,
    rooms_factor_percent: u64,
    objects_factor_percent: u64,
    foraging_factor: f64,
    description: String,
}

impl OverlayEstimate {
    fn total_seconds(&self) -> u64 {
        self.zombie_seconds
            .saturating_add((self.foraging_seconds as f64 * self.foraging_factor) as u64)
            .saturating_add(
                self.rooms_seconds
                    .saturating_mul(self.rooms_factor_percent)
                    .saturating_div(100),
            )
            .saturating_add(
                self.objects_seconds
                    .saturating_mul(self.objects_factor_percent)
                    .saturating_div(100),
            )
    }
}

#[derive(Debug, Clone, Copy)]
struct CoverageEstimate {
    factor: f64,
    description: &'static str,
}

fn estimate_command_config(config: &Value, command: &str) -> Value {
    let mut prepared = config.clone();
    if let Some(map_name) = config_string(config, "base_map") {
        prepared["__render_map_name"] = Value::String(map_name);
    }
    pzmap2dzi_renderer::effective_command_config(&prepared, command)
}

fn estimate_render_settings(config: &Value, top_view: bool) -> RenderEstimate {
    let format = config_string_nested(config, &["render_conf", "image_fmt"])
        .unwrap_or_else(|| "webp".to_string())
        .trim()
        .to_ascii_lowercase();
    let format = if format == "jpeg" {
        "jpg"
    } else {
        format.as_str()
    };
    let layer_range = config_string_nested(config, &["render_conf", "layer_range"])
        .unwrap_or_else(|| "all".to_string())
        .trim()
        .to_ascii_lowercase();
    let quality = jpeg_quality(config);
    let omit_levels = nested_number(config, &["render_conf", "omit_levels"])
        .unwrap_or(0.0)
        .max(0.0)
        .min(8.0);
    let top_view_square_size = nested_number(config, &["render_conf", "top_view_square_size"])
        .unwrap_or(1.0)
        .max(1.0);

    let exact_preset_multiplier = match (format, layer_range.as_str(), quality.round() as u64) {
        ("jpg", "ground", 25) if omit_levels == 0.0 => Some(0.12),
        ("jpg", "ground_and_positive", 50) if omit_levels == 0.0 => Some(0.30),
        ("jpg", "all", 75) if omit_levels == 0.0 => Some(0.55),
        ("webp", "all", _) if omit_levels == 0.0 => Some(1.0),
        _ => None,
    };
    let format_multiplier = match format {
        "png" => 1.9,
        "jpg" => 0.25 + (quality / 100.0).clamp(0.01, 1.0) * 0.75,
        _ => 1.0,
    };
    let layer_multiplier = match layer_range.as_str() {
        "ground" | "layer0" | "ground_only" => 0.3,
        "ground_and_positive" | "nonnegative" | "positive" => 0.5,
        "all" => 1.0,
        value => {
            let mut parts = value.split(',').map(|part| part.trim().parse::<f64>().ok());
            match (parts.next().flatten(), parts.next().flatten()) {
                (Some(start), Some(end)) => ((end - start).abs() / 64.0).clamp(0.1, 1.0),
                _ => 1.0,
            }
        }
    };
    let pyramid_multiplier = 0.55_f64.powf(omit_levels);
    let top_view_multiplier = if top_view {
        1.0 / top_view_square_size.sqrt()
    } else {
        1.0
    };
    let multiplier = exact_preset_multiplier
        .unwrap_or((format_multiplier * layer_multiplier * pyramid_multiplier).max(0.02))
        * top_view_multiplier;
    let image_description = match format {
        "jpg" => format!("JPG quality {}", quality.round() as u64),
        "png" => "PNG".to_string(),
        _ => "WebP".to_string(),
    };
    let layer_description = match layer_range.as_str() {
        "ground" | "layer0" | "ground_only" => "ground-only layers".to_string(),
        "ground_and_positive" | "nonnegative" | "positive" => {
            "ground and positive floors".to_string()
        }
        "all" => "all floors".to_string(),
        _ => format!("layer range {layer_range}"),
    };
    RenderEstimate {
        size_factor: multiplier.max(0.02),
        description: format!("{layer_description} with {image_description}"),
    }
}

fn estimate_overlays(config: &Value, _base_config: &Value) -> OverlayEstimate {
    let rooms_config = estimate_command_config(config, "rooms");
    let objects_config = estimate_command_config(config, "objects");
    let foraging_config = estimate_command_config(config, "foraging");
    let rooms_use_marks = config_bool_default(&rooms_config, "use_mark", true);
    let objects_use_marks = config_bool_default(&objects_config, "use_mark", true);
    let rooms_factor_percent = if rooms_use_marks { 4 } else { 100 };
    let objects_factor_percent = if objects_use_marks { 4 } else { 100 };
    let foraging_factor = foraging_color_factor(&foraging_config);
    let rooms_bytes = DOC_ROOMS_BYTES;
    let objects_bytes = DOC_OBJECTS_BYTES;
    OverlayEstimate {
        zombie_bytes: DOC_ZOMBIE_BYTES,
        foraging_bytes: DOC_FORAGING_BYTES,
        rooms_bytes,
        objects_bytes,
        zombie_seconds: DOC_ZOMBIE_SECONDS,
        foraging_seconds: DOC_FORAGING_SECONDS,
        rooms_seconds: DOC_ROOMS_SECONDS,
        objects_seconds: DOC_OBJECTS_SECONDS,
        rooms_factor_percent,
        objects_factor_percent,
        foraging_factor,
        description: format!(
            "zombie and foraging rasters ({:.0}% foraging colors active); rooms/objects {} metadata marks",
            foraging_factor * 100.0,
            if rooms_use_marks && objects_use_marks {
                "use"
            } else {
                "use raster edges when marks are disabled"
            }
        ),
    }
}

fn foraging_color_factor(config: &Value) -> f64 {
    let Some(colors) = config
        .get("render_conf")
        .and_then(|render| render.get("foraging_color"))
        .and_then(Value::as_object)
    else {
        return 1.0;
    };
    if colors.is_empty() {
        return 1.0;
    }
    let active = colors
        .values()
        .filter(|value| {
            !value
                .as_str()
                .is_some_and(|color| color.eq_ignore_ascii_case("skip"))
        })
        .count();
    (active as f64 / colors.len() as f64).clamp(0.25, 1.0)
}

fn estimate_save_selection(config: &Value) -> (u64, String) {
    let Some(value) = config.get("save_games") else {
        return (0, "no save folders".to_string());
    };
    if value
        .as_str()
        .is_some_and(|text| text.trim().eq_ignore_ascii_case("all"))
    {
        let Some(root) = config_string(config, "save_game_root") else {
            return (0, "all save folders (root not set)".to_string());
        };
        let root = expand_environment_path(filesystem_path(&root));
        let count = visible_save_count(&root);
        return (
            count,
            format!("all save folders ({count} visible folder(s))"),
        );
    }
    let count = config_list_count(config, "save_games");
    (count, format!("{count} explicit save folder(s)"))
}

fn visible_save_count(root: &Path) -> u64 {
    let Ok(modes) = fs::read_dir(root) else {
        return 0;
    };
    let mut count = 0_u64;
    for mode in modes
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
    {
        let mode_path = mode.path();
        if mode_path.join("map").is_dir()
            || fs::read_dir(&mode_path)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "bin")
                })
        {
            count = count.saturating_add(1);
            continue;
        }
        count = count.saturating_add(
            fs::read_dir(mode_path)
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .count() as u64,
        );
    }
    count
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

fn scale_reference(component_bytes: u64, documented_total: u64) -> u64 {
    (ULTRA_REFERENCE_OUTPUT_BYTES as f64 * component_bytes as f64 / documented_total as f64) as u64
}

fn render_seconds(size_factor: f64, reference_seconds: u64) -> u64 {
    let normalized = size_factor.clamp(0.02, 1.0);
    (reference_seconds as f64 * (0.17 + normalized * 0.83)).max(30.0) as u64
}

fn estimate_worker_count(config: &Value) -> usize {
    let requested = nested_value(config, &["render_conf", "worker_count"]);
    match requested {
        Some(Value::Number(value)) => value
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .filter(|value| *value > 0),
        Some(Value::String(value)) if !value.trim().eq_ignore_ascii_case("auto") => value
            .trim()
            .parse::<usize>()
            .ok()
            .filter(|value| *value > 0),
        _ => None,
    }
    .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, usize::from))
}

fn estimate_peak_memory(worker_count: usize) -> u64 {
    const MB: u64 = 1024 * 1024;
    let isometric = 4 * 1024 * MB + worker_count as u64 * 500 * MB;
    let top = 200 * MB + worker_count as u64 * 200 * MB;
    isometric.max(top)
}

fn scale_for_workers(seconds: u64, worker_count: usize, cache_enabled: bool) -> u64 {
    let worker_factor = (16.0 / worker_count.max(1) as f64)
        .powf(0.72)
        .clamp(0.45, 2.5);
    let cache_factor = if cache_enabled { 0.92 } else { 1.0 };
    (seconds as f64 * worker_factor * cache_factor).max(30.0) as u64
}

fn config_bool_default(config: &Value, key: &str, fallback: bool) -> bool {
    config
        .get(key)
        .and_then(Value::as_bool)
        .or_else(|| {
            config
                .get("render_conf")
                .and_then(|value| value.get(key))
                .and_then(Value::as_bool)
        })
        .unwrap_or(fallback)
}

fn nested_bool_default(config: &Value, path: &[&str], fallback: bool) -> bool {
    nested_value(config, path)
        .and_then(Value::as_bool)
        .unwrap_or(fallback)
}

fn plant_time_factor(config: &Value) -> f64 {
    let plants = ["render_conf", "plants_conf"];
    let mut factor: f64 = 1.0;
    if nested_bool_default(config, &[plants[0], plants[1], "snow"], false) {
        factor += 0.02;
    }
    if nested_bool_default(config, &[plants[0], plants[1], "large_bush"], false) {
        factor += 0.01;
    }
    if nested_bool_default(config, &[plants[0], plants[1], "flower"], false) {
        factor += 0.01;
    }
    if nested_bool_default(config, &[plants[0], plants[1], "no_ground_cover"], false) {
        factor -= 0.03;
    }
    factor.clamp(0.9, 1.1)
}

fn estimate_coverage(config: &Value) -> CoverageEstimate {
    let dzi = configured_range_area(config, "dzi_cell_range");
    let render = configured_range_area(config, "render_cell_range");
    let factor = dzi
        .into_iter()
        .chain(render)
        .fold(1.0_f64, |current, area| {
            current.min((area / REFERENCE_MAP_CELL_COUNT).clamp(0.01, 1.0))
        });
    if factor >= 0.999 {
        CoverageEstimate {
            factor: 1.0,
            description: "full configured cell coverage",
        }
    } else {
        CoverageEstimate {
            factor,
            description: "explicit cell ranges scaled against the 4,065-cell full-map reference",
        }
    }
}

fn configured_range_area(config: &Value, key: &str) -> Option<f64> {
    let value = nested_value(config, &["render_conf", key])?;
    if let Some(text) = value.as_str() {
        let normalized = text.trim();
        if normalized.is_empty()
            || normalized.eq_ignore_ascii_case("all")
            || normalized.eq_ignore_ascii_case("auto")
            || normalized.eq_ignore_ascii_case("all_mod_maps")
        {
            return None;
        }
        let numbers = normalized
            .split(|character: char| !character.is_ascii_digit() && character != '-')
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.parse::<f64>().ok())
            .collect::<Vec<_>>();
        return range_area_from_numbers(&numbers);
    }
    if let Some(values) = value.as_array() {
        if values.first().is_some_and(Value::is_number) {
            let numbers = values.iter().filter_map(Value::as_f64).collect::<Vec<_>>();
            return range_area_from_numbers(&numbers);
        }
        let mut total = 0.0;
        for range in values.iter().filter_map(Value::as_array) {
            let numbers = range.iter().filter_map(Value::as_f64).collect::<Vec<_>>();
            if let Some(area) = range_area_from_numbers(&numbers) {
                total += area;
            }
        }
        return (total > 0.0).then_some(total);
    }
    None
}

fn range_area_from_numbers(numbers: &[f64]) -> Option<f64> {
    match numbers {
        [_, _] => Some(1.0),
        [_, _, width, height, ..] => Some(width.max(1.0) * height.max(1.0)),
        _ => None,
    }
}

fn jpeg_quality(config: &Value) -> f64 {
    let Some(options) = config
        .get("render_conf")
        .and_then(|render| render.get("image_save_options"))
    else {
        return 75.0;
    };
    let parsed = match options {
        Value::String(text) => serde_json::from_str::<Value>(text).ok(),
        Value::Object(_) => Some(options.clone()),
        _ => None,
    };
    parsed
        .as_ref()
        .and_then(|value| value.get("jpg").or_else(|| value.get("jpeg")))
        .and_then(|value| value.get("quality"))
        .and_then(Value::as_f64)
        .unwrap_or(75.0)
        .clamp(1.0, 100.0)
}

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetDiskFreeSpaceExW(
        directory_name: *const u16,
        free_bytes_available: *mut u64,
        total_bytes: *mut u64,
        total_free_bytes: *mut u64,
    ) -> i32;
}

fn available_space(path: &Path) -> u64 {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        let absolute_path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|root| root.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        };
        let mut wide = absolute_path.as_os_str().encode_wide().collect::<Vec<_>>();
        wide.push(0);
        let mut available = 0_u64;
        let success = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut available,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if success != 0 {
            return available;
        }
    }

    available_space_from_sysinfo(path)
}

fn available_space_from_sysinfo(path: &Path) -> u64 {
    let disks = Disks::new_with_refreshed_list();
    let candidate = path.canonicalize().unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|root| root.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    });
    disks
        .iter()
        .filter(|disk| disk_mount_matches_path(&candidate, disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
        .unwrap_or(0)
}

fn disk_mount_matches_path(candidate: &Path, mount_point: &Path) -> bool {
    if cfg!(windows) {
        let normalize = |path: &Path| {
            let mut text = path
                .to_string_lossy()
                .replace('/', "\\")
                .to_ascii_lowercase();
            if let Some(rest) = text.strip_prefix("\\\\?\\unc\\") {
                text = format!("\\\\{rest}");
            } else if let Some(rest) = text.strip_prefix("\\\\?\\") {
                text = rest.to_string();
            }
            text
        };
        let candidate_text = normalize(candidate);
        let mut mount_text = normalize(mount_point);

        if mount_text.len() == 2 && mount_text.as_bytes().get(1) == Some(&b':') {
            mount_text.push('\\');
        } else if !mount_text.ends_with('\\') {
            mount_text.push('\\');
        }

        let mount_without_separator = mount_text.strip_suffix('\\').unwrap_or(&mount_text);
        candidate_text == mount_without_separator || candidate_text.starts_with(&mount_text)
    } else {
        candidate == mount_point || candidate.starts_with(mount_point)
    }
}

fn config_string(config: &Value, key: &str) -> Option<String> {
    config.get(key).and_then(Value::as_str).map(str::to_string)
}

fn filesystem_path(value: &str) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(value.replace('/', "\\"))
    } else {
        PathBuf::from(value)
    }
}

fn config_list_count(config: &Value, key: &str) -> u64 {
    let Some(value) = config.get(key) else {
        return 0;
    };
    if let Some(text) = value.as_str() {
        return text
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.trim().eq_ignore_ascii_case("all"))
            .count() as u64;
    }
    value
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter(|value| match value {
                    Value::String(text) => !text.trim().is_empty(),
                    Value::Object(object) => object
                        .get("name")
                        .or_else(|| object.get("map_name"))
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.trim().is_empty()),
                    _ => false,
                })
                .count() as u64
        })
        .unwrap_or(0)
}

fn additional_map_count(config: &Value) -> u64 {
    for key in ["additional_maps", "custom_maps", "mod_maps"] {
        if config.get(key).is_some() {
            return config_list_count(config, key);
        }
    }
    0
}

fn config_value_string(config: &Value, key: &str) -> Option<String> {
    config
        .get(key)
        .or_else(|| config.get("render_conf").and_then(|value| value.get(key)))
        .map(|value| match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        })
}

fn config_bool(config: &Value, key: &str) -> bool {
    config
        .get(key)
        .and_then(Value::as_bool)
        .or_else(|| {
            config
                .get("render_conf")
                .and_then(|value| value.get(key))
                .and_then(Value::as_bool)
        })
        .unwrap_or(false)
}

fn configure_rayon(config: &Value) -> usize {
    let requested = config
        .get("render_conf")
        .and_then(|value| value.get("worker_count"));
    let count = match requested {
        Some(Value::Number(value)) => value.as_u64().and_then(|value| usize::try_from(value).ok()),
        Some(Value::String(value)) if value.trim().eq_ignore_ascii_case("auto") => None,
        Some(Value::String(value)) => value.trim().parse::<usize>().ok(),
        _ => None,
    }
    .filter(|value| *value > 0)
    .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, usize::from));
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(count)
        .build_global();
    rayon::current_num_threads()
}

fn config_string_nested(config: &Value, path: &[&str]) -> Option<String> {
    let mut value = config;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_str().map(str::to_string)
}

fn nested_value<'a>(config: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut value = config;
    for key in path {
        value = value.get(*key)?;
    }
    Some(value)
}

fn nested_number(config: &Value, path: &[&str]) -> Option<f64> {
    let mut value = config;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_f64()
}

fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_binary_sizes_for_status_messages() {
        assert_eq!(format_bytes(0), "0.0 B");
        assert_eq!(format_bytes(1024), "1.0 KB");
        assert_eq!(format_bytes(1024 * 1024), "1.0 MB");
    }

    #[test]
    fn round_trips_nested_yaml_builder_settings() {
        let config = json!({
            "base_map": "default",
            "custom_maps": [{"name": "Bedford Falls", "folder": "D:/maps/bedford"}],
            "render_conf": {
                "image_fmt": "webp",
                "omit_levels": 2,
                "layer_range": "all"
            }
        });
        let yaml = serialize_pzmap2dzi_yaml(config.clone()).expect("settings should serialize");
        assert!(yaml.starts_with("# Honu Project Zomboid map builder settings"));
        let parsed = parse_pzmap2dzi_yaml(yaml).expect("settings should parse");
        assert_eq!(parsed, config);
    }

    #[test]
    fn estimates_a_build_from_renderer_settings() {
        let config = json!({
            "output_root": "D:/pzmap",
            "mod_maps": "mod-a\nmod-b",
            "save_games": "all",
            "render_conf": {
                "tile_size": 1024,
                "image_fmt": "webp"
            }
        });
        let estimate = estimate_build(&config).expect("estimate should be produced");
        assert!(estimate.output_path.ends_with("pzmap"));
        assert!(estimate.output_bytes >= MINIMUM_BUILD_BYTES + SAFETY_MARGIN_BYTES);
        assert!(estimate.explanation.contains("WebP"));
    }

    #[test]
    fn estimates_describe_the_selected_jpeg_profile() {
        let config = json!({
            "output_root": "D:/pzmap",
            "render_conf": {
                "layer_range": "ground_and_positive",
                "image_fmt": "jpg",
                "image_save_options": "{\"jpg\":{\"quality\":50}}"
            }
        });
        let estimate = estimate_build(&config).expect("estimate should be produced");
        assert!(
            estimate
                .explanation
                .contains("ground and positive floors with JPG quality 50")
        );
        assert_eq!(estimate.source_bytes, ULTRA_REFERENCE_OUTPUT_BYTES);
        assert!(estimate.output_bytes > 100 * 1024 * 1024 * 1024);
    }

    #[test]
    fn estimates_change_with_profile_quality_and_report_resources() {
        let low = json!({
            "output_root": "C:/pzmap",
            "render_conf": {
                "layer_range": "ground",
                "image_fmt": "jpg",
                "image_save_options": "{\"jpg\":{\"quality\":25}}",
                "worker_count": 16
            }
        });
        let high = json!({
            "output_root": "C:/pzmap",
            "render_conf": {
                "layer_range": "all",
                "image_fmt": "jpg",
                "image_save_options": "{\"jpg\":{\"quality\":75}}",
                "worker_count": 16
            }
        });
        let low_estimate = estimate_build(&low).expect("low estimate should be produced");
        let high_estimate = estimate_build(&high).expect("high estimate should be produced");
        assert!(low_estimate.output_bytes < high_estimate.output_bytes);
        assert!(low_estimate.estimated_seconds < high_estimate.estimated_seconds);
        assert!(high_estimate.peak_memory_bytes >= 4 * 1024 * 1024 * 1024);
        assert!(!high_estimate.estimate_basis.is_empty());
    }

    #[test]
    fn accepts_upstream_output_path_alias() {
        let config = json!({
            "output_path": "C:/pzmap",
            "render_conf": {"image_fmt": "webp"}
        });
        let estimate = estimate_build(&config).expect("upstream output_path should be accepted");
        assert!(estimate.output_path.ends_with("pzmap"));
    }

    #[test]
    fn counts_array_form_values_for_build_estimates() {
        let config = json!({
            "mod_maps": ["mod-a", "mod-b"],
            "save_games": ["Sandbox/one", "Sandbox/two"]
        });
        assert_eq!(config_list_count(&config, "mod_maps"), 2);
        assert_eq!(config_list_count(&config, "save_games"), 2);
    }

    #[test]
    fn counts_canonical_additional_map_entries_for_build_estimates() {
        let config = json!({
            "additional_maps": [
                {"name": "mod-a", "folder": "D:/maps/a"},
                {"name": "mod-b"}
            ]
        });
        assert_eq!(additional_map_count(&config), 2);
    }

    #[test]
    fn sample_estimate_is_bounded_for_live_smoke_tests() {
        let config = json!({
            "output_root": "D:/pzmap",
            "sample_build": true,
            "render_conf": {"tile_size": 4096, "image_fmt": "webp"}
        });
        let estimate = estimate_build(&config).expect("sample estimate should be produced");
        assert_eq!(estimate.safety_margin_bytes, SAMPLE_SAFETY_MARGIN_BYTES);
        assert!(estimate.output_bytes < MINIMUM_BUILD_BYTES + SAFETY_MARGIN_BYTES);
        assert!(estimate.explanation.contains("one sampled map cell"));
    }

    #[test]
    fn removes_a_confirmed_existing_output_directory() {
        let root = std::env::temp_dir().join(format!(
            "pzmap2dzi-output-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be valid")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("nested")).expect("test output directory should be created");
        fs::write(root.join("nested/map.txt"), b"test").expect("test output should be written");

        remove_existing_output(&root).expect("confirmed output should be removed");
        assert!(!root.exists());
    }

    #[test]
    fn records_verbose_metrics_in_persistent_sidecars() {
        let root = std::env::temp_dir().join(format!(
            "pzmap2dzi-metrics-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be valid")
                .as_nanos()
        ));
        let telemetry_root = root.join("telemetry");
        fs::create_dir_all(&root).expect("metrics test directory should be created");
        fs::create_dir_all(&telemetry_root).expect("metrics telemetry directory should be created");
        fs::write(
            build_log_path(&telemetry_root, &root),
            "old output from a previous job\n",
        )
        .expect("previous verbose log should be written");
        {
            let mut recorder = BuildRecorder::new(
                "test-job",
                &root,
                &telemetry_root,
                &json!({"output_root": root}),
                0.0,
                0,
            )
            .expect("metrics recorder should open");
            recorder.emit(
                45.0,
                "scan",
                "rust-pzmap2dzi scan found 3 base-map cell headers",
            );
            recorder.finish("completed", "done");
        }

        let metrics = fs::read_to_string(build_metrics_path(&telemetry_root, &root))
            .expect("metrics history should be written");
        assert!(metrics.contains("\"job_id\":\"test-job\""));
        assert!(metrics.contains("\"cells_scanned\":3"));
        assert!(metrics.contains("\"elapsed_seconds\""));
        assert!(
            fs::read_to_string(build_log_path(&telemetry_root, &root))
                .expect("verbose log should be written")
                .contains("base-map cell headers")
        );
        assert!(
            !fs::read_to_string(build_log_path(&telemetry_root, &root))
                .expect("verbose log should be readable")
                .contains("old output from a previous job")
        );
        assert!(
            fs::read_to_string(build_summary_path(&telemetry_root, &root))
                .expect("metrics summary should be written")
                .contains("\"state\": \"completed\"")
        );

        fs::remove_dir_all(&root).expect("metrics test directory should be removed");
        fs::remove_dir_all(&telemetry_root).ok();
    }

    #[test]
    fn historical_estimates_include_stopped_and_error_runs() {
        let root = std::env::temp_dir().join(format!(
            "pzmap2dzi-history-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be valid")
                .as_nanos()
        ));
        let telemetry_root = root.join("telemetry");
        let output_root = root.join("map-output");
        fs::create_dir_all(&telemetry_root).expect("history telemetry directory should be created");

        let event = |job_id: &str,
                     state: &str,
                     progress: f32,
                     elapsed_seconds: u64,
                     disk_used_bytes: u64| {
            BuildMetricEvent {
                job_id: job_id.to_string(),
                state: state.to_string(),
                progress,
                command: "render".to_string(),
                message: "test".to_string(),
                metrics: BuildMetrics {
                    elapsed_seconds,
                    disk_used_bytes,
                    estimated_seconds: 1_200,
                    estimated_output_bytes: 10_000_000_000,
                    ..BuildMetrics::default()
                },
            }
        };
        let history = [
            event("stopped-job", "stopped", 50.0, 600, 5_000_000_000),
            event("error-job", "error", 100.0, 1_000, 10_000_000_000),
        ]
        .into_iter()
        .map(|value| serde_json::to_string(&value).expect("history event should serialize"))
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(
            build_metrics_path(&telemetry_root, &output_root),
            format!("{history}\n"),
        )
        .expect("history metrics should be written");

        let estimate =
            read_historical_estimate(&telemetry_root, &output_root, 10_000_000_000, 1_200);
        assert_eq!(estimate.projected_seconds.len(), 2);
        assert_eq!(estimate.projected_output_bytes.len(), 2);
        assert!(estimate.states.contains("stopped"));
        assert!(estimate.states.contains("error"));

        fs::remove_dir_all(root).expect("history test directory should be removed");
    }

    #[test]
    fn resume_estimates_use_saved_stage_time_and_disk_usage() {
        let estimate = DiskEstimate {
            source_path: "D:/pz".to_string(),
            output_path: "D:/pzmap".to_string(),
            source_bytes: 1,
            output_bytes: 100_000_000_000,
            available_bytes: 200_000_000_000,
            enough_space: true,
            safety_margin_bytes: SAFETY_MARGIN_BYTES,
            estimated_seconds: 10_000,
            peak_memory_bytes: 1,
            historical_run_count: 0,
            estimate_basis: "test".to_string(),
            explanation: "test".to_string(),
        };
        let resumed = estimate_for_resume(
            estimate,
            63.0,
            "overlay_raster",
            3_000,
            8 * 1024 * 1024 * 1024,
        );
        assert!(resumed.output_bytes < 92_000_000_000);
        assert!(resumed.estimated_seconds > 0);
        assert!(resumed.estimate_basis.contains("overlay_raster"));
        assert!(resumed.explanation.contains("8.0 GB"));
    }

    #[test]
    fn matches_windows_drive_mount_points_without_a_trailing_separator() {
        if cfg!(windows) {
            assert!(disk_mount_matches_path(
                Path::new(r"D:\pzmap"),
                Path::new("D:")
            ));
            assert!(disk_mount_matches_path(
                Path::new(r"\\?\D:\pzmap"),
                Path::new("D:")
            ));
            assert!(!disk_mount_matches_path(
                Path::new(r"C:\pzmap"),
                Path::new("D:")
            ));
        }
    }
}
