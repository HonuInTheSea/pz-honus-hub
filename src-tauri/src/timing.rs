use std::env;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

static PROFILE_ENABLED: AtomicBool = AtomicBool::new(false);

pub(crate) struct ScopedTimer {
    name: &'static str,
    started_at: Instant,
    enabled: bool,
}

impl Drop for ScopedTimer {
    fn drop(&mut self) {
        if !self.enabled {
            return;
        }
        let elapsed_ms = self.started_at.elapsed().as_secs_f64() * 1000.0;
        println!("[perf][tauri] {}: {:.1}ms", self.name, elapsed_ms);
    }
}

pub(crate) fn scoped_timer(name: &'static str) -> ScopedTimer {
    let enabled = PROFILE_ENABLED.load(Ordering::Relaxed)
        || env::var("PZ_PROFILE_TIMING")
            .map(|v| {
                let lower = v.trim().to_ascii_lowercase();
                lower == "1" || lower == "true" || lower == "on"
            })
            .unwrap_or(false);

    ScopedTimer {
        name,
        started_at: Instant::now(),
        enabled,
    }
}

pub(crate) fn set_profile_enabled(enabled: bool) {
    PROFILE_ENABLED.store(enabled, Ordering::Relaxed);
}
