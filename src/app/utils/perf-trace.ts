const PERF_ENABLED_KEY = 'pz_perf_profile';

type PerfStats = {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
};

type PerfStatsMap = Record<string, PerfStats>;

function getWindowObj(): (Window & { __pzPerfStats?: PerfStatsMap }) | null {
  if (typeof window === 'undefined') {
    return null;
  }
  return window as Window & { __pzPerfStats?: PerfStatsMap };
}

export function isPerfProfilingEnabled(): boolean {
  const win = getWindowObj();
  if (!win) {
    return false;
  }

  try {
    const raw = win.localStorage.getItem(PERF_ENABLED_KEY);
    return raw === '1' || raw === 'true' || raw === 'on';
  } catch {
    return false;
  }
}

export function setPerfProfilingEnabled(enabled: boolean): void {
  const win = getWindowObj();
  if (!win) {
    return;
  }
  try {
    win.localStorage.setItem(PERF_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    // Ignore storage access failures.
  }
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function recordPerf(label: string, elapsedMs: number): void {
  const win = getWindowObj();
  if (!win) {
    return;
  }

  const statsMap = (win.__pzPerfStats ??= {});
  const existing = statsMap[label];

  if (existing) {
    existing.count += 1;
    existing.totalMs += elapsedMs;
    existing.maxMs = Math.max(existing.maxMs, elapsedMs);
    existing.lastMs = elapsedMs;
    return;
  }

  statsMap[label] = {
    count: 1,
    totalMs: elapsedMs,
    maxMs: elapsedMs,
    lastMs: elapsedMs,
  };
}

export function profileSync<T>(label: string, fn: () => T): T {
  if (!isPerfProfilingEnabled()) {
    return fn();
  }

  const start = nowMs();
  try {
    return fn();
  } finally {
    const elapsedMs = nowMs() - start;
    recordPerf(label, elapsedMs);
    console.info(`[perf] ${label}: ${elapsedMs.toFixed(1)}ms`);
  }
}

export async function profileAsync<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!isPerfProfilingEnabled()) {
    return fn();
  }

  const start = nowMs();
  try {
    return await fn();
  } finally {
    const elapsedMs = nowMs() - start;
    recordPerf(label, elapsedMs);
    console.info(`[perf] ${label}: ${elapsedMs.toFixed(1)}ms`);
  }
}

export function logPerfSummary(top = 10): void {
  const win = getWindowObj();
  const statsMap = win?.__pzPerfStats;
  if (!statsMap) {
    console.info('[perf] No profiling data collected yet.');
    return;
  }

  const rows = Object.entries(statsMap)
    .map(([label, stats]) => ({
      label,
      count: stats.count,
      totalMs: Number(stats.totalMs.toFixed(1)),
      avgMs: Number((stats.totalMs / Math.max(1, stats.count)).toFixed(1)),
      maxMs: Number(stats.maxMs.toFixed(1)),
      lastMs: Number(stats.lastMs.toFixed(1)),
    }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, Math.max(1, Math.floor(top)));

  console.table(rows);
}

export function installPerfConsoleHelpers(): void {
  const win = getWindowObj() as
    | (Window & { pzPerf?: { enable: () => void; disable: () => void; summary: (top?: number) => void } })
    | null;
  if (!win) {
    return;
  }

  win.pzPerf = {
    enable: () => setPerfProfilingEnabled(true),
    disable: () => setPerfProfilingEnabled(false),
    summary: (top = 10) => logPerfSummary(top),
  };
}
