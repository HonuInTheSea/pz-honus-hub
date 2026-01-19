import { Component, DestroyRef, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MultiSelectModule } from 'primeng/multiselect';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { TauriStoreService } from '../../services/tauri-store.service';
import { PzDefaultPathsService } from '../../services/pz-default-paths.service';
import { LocalizationService } from '../../services/localization.service';
import { formatLocalizedDateTime } from '../../i18n/date-time';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

type LogLevel = 'ERROR' | 'WARN' | 'LOG' | 'DEBUG' | 'TRACE' | 'OTHER';

type LogEntry = {
  timestampRaw: string | null;
  timestamp: Date | null;
  timestampMs: number | null;
  timestampDisplay: string;
  level: LogLevel;
  message: string;
  sourceLine: string;
  isNew?: boolean;
};

function toDateFromTimestampRaw(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const dmY = trimmed.match(
    /^(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/,
  );
  if (dmY) {
    const dd = Number(dmY[1]);
    const mm = Number(dmY[2]);
    const yy = Number(dmY[3]);
    const hh = Number(dmY[4]);
    const min = Number(dmY[5]);
    const ss = Number(dmY[6]);
    const ms = dmY[7] ? Number(dmY[7].padEnd(3, '0')) : 0;
    const year = 2000 + yy;
    const dt = new Date(year, mm - 1, dd, hh, min, ss, ms);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  if (/^\d{10,13}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isFinite(numeric)) return null;
    const ms = numeric >= 1e12 ? numeric : numeric * 1000;
    const dt = new Date(ms);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  const dt = new Date(trimmed);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function getLevel(line: string): LogLevel {
  const m = line.match(
    /^\s*(?:\[[^\]]+\]\s*)?(ERROR|WARN(?:ING)?|LOG|DEBUG|TRACE)\b/i,
  );
  if (!m) return 'OTHER';
  const upper = m[1].toUpperCase();
  if (upper === 'WARNING') return 'WARN';
  if (upper === 'WARN') return 'WARN';
  if (upper === 'ERROR') return 'ERROR';
  if (upper === 'LOG') return 'LOG';
  if (upper === 'DEBUG') return 'DEBUG';
  if (upper === 'TRACE') return 'TRACE';
  return 'OTHER';
}

function parseTimestampRaw(line: string): string | null {
  const tField = line.match(/\bt\s*=\s*([^\s,>\]]+)/i);
  if (tField?.[1]) return tField[1];

  const tColonField = line.match(/\bt\s*:\s*([^\s,>\]]+)/i);
  if (tColonField?.[1]) return tColonField[1];

  const bracket = line.match(/^\s*\[([^\]]+)\]/);
  if (bracket?.[1]) return bracket[1];

  const beforeArrow = line.match(/,\s*([0-9]{10,13})\s*>/);
  if (beforeArrow?.[1]) return beforeArrow[1];

  const justArrow = line.match(/\b([0-9]{10,13})\s*>/);
  if (justArrow?.[1]) return justArrow[1];

  const isoish = line.match(/\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\b/);
  if (isoish?.[1]) return isoish[1];

  return null;
}

function extractMessage(line: string): string {
  const gt = line.indexOf('>');
  if (gt >= 0 && gt + 1 < line.length) return line.slice(gt + 1).trim();

  const colon = line.indexOf(':');
  if (colon >= 0 && colon + 1 < line.length) return line.slice(colon + 1).trim();

  return line.trim();
}

function parseLogText(text: string): LogEntry[] {
  const lines = (text ?? '').replace(/\r\n/g, '\n').split('\n');
  const entries: LogEntry[] = [];
  let current: LogEntry | null = null;

  for (const line of lines) {
    const isNew =
      /^\s*(ERROR|WARN(?:ING)?|LOG|DEBUG|TRACE)\b/i.test(line) ||
      /^\s*\[[^\]]+\]\s*(ERROR|WARN(?:ING)?|LOG|DEBUG|TRACE)\b/i.test(line);
    if (!isNew && current) {
      const trimmed = line.trimEnd();
      if (trimmed) current.message = `${current.message}\n${trimmed}`;
      continue;
    }

    if (!line.trim()) continue;

    const timestampRaw = parseTimestampRaw(line);
    const timestamp = timestampRaw ? toDateFromTimestampRaw(timestampRaw) : null;
    const level = getLevel(line);
    const entry: LogEntry = {
      timestampRaw,
      timestamp,
      timestampMs: timestamp ? timestamp.getTime() : null,
      timestampDisplay: timestamp ? timestamp.toISOString() : (timestampRaw ?? ''),
      level,
      message: extractMessage(line),
      sourceLine: line,
    };
    entries.push(entry);
    current = entry;
  }

  return entries;
}

function joinPath(a: string, b: string): string {
  const left = (a ?? '').replace(/[\\/]+$/, '');
  const right = (b ?? '').replace(/^[\\/]+/, '');
  return left && right ? `${left}\\${right}` : (left || right);
}

@Component({
  selector: 'app-log-inspector-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CardModule,
    ButtonModule,
    InputTextModule,
    MultiSelectModule,
    MessageModule,
    TagModule,
    TableModule,
    ToggleSwitchModule,
    TranslocoModule,
  ],
  templateUrl: './log-inspector.page.html',
  styleUrls: ['./log-inspector.page.css'],
})
export class LogInspectorPageComponent implements OnInit, OnDestroy {
  filePath = '';
  filePathPlaceholder = '';
  entries: LogEntry[] = [];
  filteredEntries: LogEntry[] = [];

  levelOptions: Array<{ label: string; value: LogLevel }> = [];
  selectedLevels: LogLevel[] = ['ERROR'];

  fromLocal = '';
  toLocal = '';
  maxEntries = 50;
  searchText = '';

  pollingEnabled = false;
  pollingSeconds = 1;
  private pollingHandle: number | null = null;
  private loadInFlight = false;
  private lastLoadedTextLength = -1;
  private newPulseHandle: number | null = null;
  private newPulseId = 0;
  private currentLocale = 'en-US';

  loadError: string | null = null;
  tableFirst = 0;
  tableRows = 100;

  constructor(
    private readonly store: TauriStoreService,
    private readonly pzDefaults: PzDefaultPathsService,
    private readonly transloco: TranslocoService,
    private readonly destroyRef: DestroyRef,
    private readonly localization: LocalizationService,
  ) {
    this.currentLocale = this.localization.locale || 'en-US';
    this.localization.locale$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((locale) => {
        this.currentLocale = locale;
      });
    this.updateTranslations();
    this.transloco.langChanges$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.updateTranslations());
  }

  async ngOnInit(): Promise<void> {
    this.filePathPlaceholder = await this.pzDefaults.getDefaultConsoleLogPathExample();
    const storedUserDir = await this.store.getItem<string>('pz_user_dir');
    const defaultUserDir = (storedUserDir ?? '').trim();
    const defaultFile = defaultUserDir ? joinPath(defaultUserDir, 'console.txt') : '';

    const storedPath = await this.store.getItem<string>('log_inspector_file_path');
    const stored = (storedPath ?? '').trim();
    this.filePath = stored || defaultFile;

    await this.reload();
  }

  ngOnDestroy(): void {
    this.stopPolling();
    this.clearNewPulse();
  }

  get filePathInputWidth(): string {
    return this.inputWidthForText(this.filePath, { minCh: 28, maxCh: 85 });
  }

  get searchInputWidth(): string {
    return this.inputWidthForText(this.searchText, { minCh: 32, maxCh: 110 });
  }

  async onBrowse(): Promise<void> {
    const storedUserDir = await this.store.getItem<string>('pz_user_dir');
    const defaultPath = (storedUserDir ?? '').trim() || undefined;
    const selected = await openDialog({
      multiple: false,
      directory: false,
      defaultPath,
      filters: [
        {
          name: this.transloco.translate('logInspector.dialog.logFilesFilter'),
          extensions: ['txt', 'log'],
        },
      ],
    });
    if (!selected || Array.isArray(selected)) return;
    this.filePath = selected;
    await this.store.setItem('log_inspector_file_path', this.filePath);
    await this.reload(true);
  }

  async reload(force = false): Promise<void> {
    if (!this.filePath.trim()) {
      this.entries = [];
      this.applyFilters();
      this.loadError = this.transloco.translate('logInspector.errors.noFilePath');
      return;
    }

    if (this.loadInFlight) return;
    this.loadInFlight = true;
    try {
      this.loadError = null;
      const prevBySourceLine = this.pollingEnabled
        ? new Set((this.entries ?? []).map((e) => e.sourceLine))
        : null;
      const text = await invoke<string>('read_text_file', { path: this.filePath });
      if (!force && text.length === this.lastLoadedTextLength) {
        this.applyFilters();
        return;
      }
      this.lastLoadedTextLength = text.length;
      this.entries = parseLogText(text);
      if (prevBySourceLine) this.pulseNewEntries(prevBySourceLine);
      this.applyFilters();
    } catch (e: any) {
      this.entries = [];
      this.filteredEntries = [];
      this.loadError = String(
        e?.message ?? e ?? this.transloco.translate('logInspector.errors.loadFailed'),
      );
    } finally {
      this.loadInFlight = false;
    }
  }

  async onClear(): Promise<void> {
    if (!this.filePath.trim()) return;
    try {
      await invoke<void>('truncate_text_file', { path: this.filePath });
      this.lastLoadedTextLength = 0;
      await this.reload(true);
    } catch (e: any) {
      this.loadError = String(
        e?.message ?? e ?? this.transloco.translate('logInspector.errors.clearFailed'),
      );
    }
  }

  onFiltersChanged(): void {
    this.applyFilters();
  }

  onPollingChanged(): void {
    if (this.pollingEnabled) this.startPolling();
    else this.stopPolling();
  }

  startPolling(): void {
    this.stopPolling();
    const secondsRaw = Number(this.pollingSeconds || 0);
    const seconds = Math.max(0.25, Number.isFinite(secondsRaw) ? secondsRaw : 0);
    const ms = Math.max(250, Math.floor(seconds * 1000));
    this.pollingSeconds = ms / 1000;
    this.pollingHandle = window.setInterval(() => {
      void this.reload();
    }, ms);
  }

  stopPolling(): void {
    if (this.pollingHandle != null) {
      window.clearInterval(this.pollingHandle);
      this.pollingHandle = null;
    }
  }

  applyFilters(): void {
    const allowed = new Set<LogLevel>(this.selectedLevels ?? []);
    const from = this.fromLocal ? new Date(this.fromLocal) : null;
    const to = this.toLocal ? new Date(this.toLocal) : null;
    const needle = (this.searchText ?? '').trim().toLowerCase();

    const filtered = (this.entries ?? []).filter((e) => {
      if (allowed.size > 0 && !allowed.has(e.level)) return false;
      if (from && e.timestamp && e.timestamp < from) return false;
      if (to && e.timestamp && e.timestamp > to) return false;
      if (needle) {
        const hay = `${e.message}\n${e.sourceLine}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });

    const max = Math.max(1, Math.floor(this.maxEntries || 0));
    this.maxEntries = max;
    this.filteredEntries = filtered.length > max ? filtered.slice(filtered.length - max) : filtered;
  }

  tagSeverity(
    level: LogLevel,
  ): 'success' | 'info' | 'warn' | 'secondary' | 'contrast' | 'danger' | undefined {
    if (level === 'ERROR') return 'danger';
    if (level === 'WARN') return 'warn';
    if (level === 'DEBUG') return 'secondary';
    if (level === 'TRACE') return 'info';
    if (level === 'LOG') return 'success';
    return undefined;
  }

  rowClass(entry: LogEntry): string {
    const classes: string[] = [];
    if (entry.level === 'ERROR') classes.push('log-row-error');
    if (this.pollingEnabled && entry.isNew) classes.push('log-row-new');
    return classes.join(' ');
  }

  private inputWidthForText(
    text: string,
    opts: { minCh: number; maxCh: number },
  ): string {
    const value = (text ?? '').trim();
    const min = Math.max(6, Math.floor(opts.minCh || 0));
    const max = Math.max(min, Math.floor(opts.maxCh || 0));
    const length = Math.max(0, value.length);
    const padded = length + 2;
    const clamped = Math.min(max, Math.max(min, padded));
    return `${clamped}ch`;
  }

  private pulseNewEntries(prevBySourceLine: Set<string>): void {
    const newlyAdded: LogEntry[] = [];
    for (const entry of this.entries ?? []) {
      if (!prevBySourceLine.has(entry.sourceLine)) {
        entry.isNew = true;
        newlyAdded.push(entry);
      } else {
        entry.isNew = false;
      }
    }

    if (newlyAdded.length === 0) return;
    this.clearNewPulse();
    const pulseId = ++this.newPulseId;
    this.newPulseHandle = window.setTimeout(() => {
      if (pulseId !== this.newPulseId) return;
      for (const entry of this.entries ?? []) entry.isNew = false;
      this.newPulseHandle = null;
    }, 1200);
  }

  private clearNewPulse(): void {
    if (this.newPulseHandle != null) {
      window.clearTimeout(this.newPulseHandle);
      this.newPulseHandle = null;
    }
  }

  private updateTranslations(): void {
    this.levelOptions = [
      { label: this.transloco.translate('logInspector.levels.error'), value: 'ERROR' },
      { label: this.transloco.translate('logInspector.levels.warn'), value: 'WARN' },
      { label: this.transloco.translate('logInspector.levels.log'), value: 'LOG' },
      { label: this.transloco.translate('logInspector.levels.debug'), value: 'DEBUG' },
      { label: this.transloco.translate('logInspector.levels.trace'), value: 'TRACE' },
      { label: this.transloco.translate('logInspector.levels.other'), value: 'OTHER' },
    ];
  }

  formatTimestamp(entry: LogEntry): string {
    if (entry.timestamp && !Number.isNaN(entry.timestamp.getTime())) {
      return formatLocalizedDateTime(entry.timestamp, this.currentLocale);
    }
    return entry.timestampRaw || '';
  }
}
