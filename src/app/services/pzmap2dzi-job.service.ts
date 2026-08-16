import { Injectable, OnDestroy } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { BehaviorSubject } from 'rxjs';

export interface MapBuildEstimate {
  source_path: string;
  output_path: string;
  source_bytes: number;
  output_bytes: number;
  available_bytes: number;
  enough_space: boolean;
  safety_margin_bytes: number;
  estimated_seconds: number;
  peak_memory_bytes: number;
  historical_run_count: number;
  estimate_basis: string;
  explanation: string;
}

export interface MapBuildMetrics {
  sample_count: number;
  progress_events: number;
  cells_scanned: number;
  elapsed_seconds: number;
  disk_used_bytes: number;
  available_bytes: number;
  estimated_seconds: number;
  estimated_output_bytes: number;
  peak_memory_bytes: number;
  stage: string;
  last_message: string;
  last_sample_at: string | null;
}

export interface MapBuildStatus {
  job_id: string | null;
  state: string;
  progress: number;
  current_command: string;
  message: string;
  logs: string[];
  estimate: MapBuildEstimate | null;
  started_at_unix_ms: number | null;
  last_activity_unix_ms: number | null;
  elapsed_seconds: number;
  metrics_path: string | null;
  log_path: string | null;
  metrics: MapBuildMetrics;
}

export interface MapOutputStatus {
  path: string;
  exists: boolean;
  is_directory: boolean;
}

export interface MapBuildResumeCandidate {
  job_id: string;
  state: string;
  progress: number;
  current_command: string;
  message: string;
  output_path: string;
  elapsed_seconds: number;
  started_at_unix_ms: number;
  config: Record<string, unknown>;
}

@Injectable({ providedIn: 'root' })
export class Pzmap2DziJobService implements OnDestroy {
  private readonly statusSubject = new BehaviorSubject<MapBuildStatus | null>(null);
  readonly status$ = this.statusSubject.asObservable();
  private pollingTimer: number | null = null;
  private refreshPromise: Promise<MapBuildStatus | null> | null = null;

  constructor() {
    if (this.isTauriRuntime()) {
      void this.refresh();
    }
  }

  get statusSnapshot(): MapBuildStatus | null {
    return this.statusSubject.value;
  }

  isActive(status: MapBuildStatus | null = this.statusSnapshot): boolean {
    return status?.state === 'starting' || status?.state === 'running' || status?.state === 'stopping';
  }

  async refresh(): Promise<MapBuildStatus | null> {
    if (!this.isTauriRuntime()) {
      return this.statusSnapshot;
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      try {
        const status = await invoke<MapBuildStatus>('get_pzmap2dzi_build_status');
        this.statusSubject.next(status);
        if (this.isActive(status)) {
          this.startPolling();
        } else {
          this.stopPolling();
        }
        return status;
      } catch {
        return this.statusSnapshot;
      } finally {
        this.refreshPromise = null;
      }
    })();
    return this.refreshPromise;
  }

  async inspectOutput(config: Record<string, unknown>): Promise<MapOutputStatus> {
    return invoke<MapOutputStatus>('inspect_pzmap2dzi_output', { config });
  }

  async inspectResume(config: Record<string, unknown>): Promise<MapBuildResumeCandidate | null> {
    return invoke<MapBuildResumeCandidate | null>('inspect_pzmap2dzi_resume', { config });
  }

  async start(
    config: Record<string, unknown>,
    replaceExistingOutput: boolean,
    resumeExistingOutput = false,
  ): Promise<MapBuildStatus> {
    const status = await invoke<MapBuildStatus>('start_pzmap2dzi_build', {
      config,
      replaceExistingOutput,
      resumeExistingOutput,
    });
    this.statusSubject.next(status);
    this.startPolling();
    return status;
  }

  async stop(): Promise<MapBuildStatus> {
    const status = await invoke<MapBuildStatus>('stop_pzmap2dzi_build');
    this.statusSubject.next(status);
    this.startPolling();
    return status;
  }

  async terminate(): Promise<MapBuildStatus> {
    const status = await invoke<MapBuildStatus>('terminate_pzmap2dzi_build');
    this.statusSubject.next(status);
    this.startPolling();
    return status;
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  private startPolling(): void {
    if (this.pollingTimer !== null || !this.isTauriRuntime()) {
      return;
    }
    this.pollingTimer = window.setInterval(() => {
      void this.refresh();
    }, 750);
  }

  private stopPolling(): void {
    if (this.pollingTimer !== null) {
      window.clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' &&
      (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));
  }
}
