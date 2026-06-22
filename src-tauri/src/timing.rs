use std::env;
use std::time::Instant;

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
    let enabled = env::var("PZ_PROFILE_TIMING")
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
