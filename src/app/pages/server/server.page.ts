import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TextareaModule } from 'primeng/textarea';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { TabsModule } from 'primeng/tabs';
import { MessageService } from 'primeng/api';
import { SelectModule } from 'primeng/select';
import { ListboxModule } from 'primeng/listbox';
import { TooltipModule } from 'primeng/tooltip';
import { RadioButtonModule } from 'primeng/radiobutton';
import { TauriStoreService } from '../../services/tauri-store.service';
import { LoadoutsService } from '../../services/loadouts.service';
import { LoadoutsStateService } from '../../services/loadouts-state.service';
import type { Loadout } from '../../models/loadout.models';
import { TranslocoService } from '@jsverse/transloco';

interface ServerFileSet {
  iniPath: string;
  sandboxVarsPath: string;
  spawnpointsPath: string;
  spawnregionsPath: string;
}

interface IniLine {
  kind: 'entry' | 'comment' | 'blank';
  key?: string;
  value?: string;
  comment?: string;
  raw?: string;
}

@Component({
  selector: 'app-server-page',
  standalone: true,
  providers: [MessageService],
  imports: [
    CommonModule,
    FormsModule,
    CardModule,
    ButtonModule,
    InputTextModule,
    TextareaModule,
    DialogModule,
    ToastModule,
    TabsModule,
    SelectModule,
    ListboxModule,
    TooltipModule,
    RadioButtonModule,
  ],
  templateUrl: './server.page.html',
})
export class ServerPageComponent implements OnInit {
  serverNames: string[] = [];
  selectedServerName = '';
  userDir = '';

  iniText = '';
  iniLines: IniLine[] = [];
  iniOriginalValues = new Map<string, string>();
  sandboxVarsText = '';
  spawnpointsText = '';
  spawnregionsText = '';

  loadingServer = false;
  savingServer = false;

  createDialogVisible = false;
  newServerName = '';

  presets: Loadout[] = [];
  selectedPresetId = '';
  selectedIniKey = '';
  booleanOptions = [
    { label: 'True', value: 'true' },
    { label: 'False', value: 'false' },
  ];
  editIniVisible = false;
  editIniLine: IniLine | null = null;
  editIniValue = '';

  constructor(
    private readonly store: TauriStoreService,
    private readonly loadoutsApi: LoadoutsService,
    private readonly loadoutsState: LoadoutsStateService,
    private readonly messageService: MessageService,
    private readonly transloco: TranslocoService,
  ) {}

  async ngOnInit(): Promise<void> {
    const storedUserDir = await this.store.getItem<string>('pz_user_dir');
    this.userDir =
      (storedUserDir ?? '').trim() ||
      (await this.loadoutsApi.getDefaultZomboidUserDir()) ||
      '';
    this.presets = await this.loadoutsState.load();
    await this.refreshServerList();
  }

  get serverPresetOptions(): Array<{ label: string; value: string }> {
    return (this.presets ?? [])
      .filter((l) =>
        (l.targetModes ?? []).some((m) => m === 'host' || m === 'dedicated'),
      )
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ label: p.name, value: p.id }));
  }

  get iniEntryRows(): IniLine[] {
    return this.iniLines
      .filter((line) => line.kind === 'entry')
      .slice()
      .sort((a, b) => {
        const aLabel = this.formatIniLabel(a.key);
        const bLabel = this.formatIniLabel(b.key);
        return aLabel.localeCompare(bLabel, undefined, { sensitivity: 'base' });
      });
  }

  get iniEntryOptions(): Array<{ label: string; key: string }> {
    return this.iniEntryRows.map((line) => ({
      label: this.formatIniLabel(line.key),
      key: line.key ?? '',
    }));
  }

  async refreshServerList(): Promise<void> {
    if (!this.userDir) {
      this.serverNames = [];
      return;
    }
    try {
      this.serverNames = await this.loadoutsApi.listServerNames(this.userDir);
      if (this.serverNames.length === 1) {
        await this.selectServer(this.serverNames[0]);
      }
    } catch {
      this.serverNames = [];
    }
  }

  async selectServer(name: string): Promise<void> {
    if (!name || this.loadingServer) {
      return;
    }
    this.selectedServerName = name;
    await this.loadServerFiles();
  }

  openCreateDialog(): void {
    this.newServerName = '';
    this.createDialogVisible = true;
  }

  async confirmCreateServer(): Promise<void> {
    const trimmed = this.newServerName.trim();
    const error = this.validateServerName(trimmed);
    if (error) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.invalidName.summary'),
        detail: error,
        life: 7000,
      });
      return;
    }

    const exists = this.serverNames.some(
      (n) => n.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.nameExists.summary'),
        detail: this.transloco.translate('toasts.server.nameExists.detail'),
        life: 7000,
      });
      return;
    }

    if (!this.userDir) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.missingUserFolder.summary'),
        detail: this.transloco.translate('toasts.server.missingUserFolder.detail'),
        life: 7000,
      });
      return;
    }

    const files = this.buildServerFileSet(trimmed);
    try {
      await this.loadoutsApi.writeTextFile(
        files.iniPath,
        '# Generated by PZ Honus Hub\nMods=\nWorkshopItems=\nMap=\n',
      );
      await this.loadoutsApi.writeTextFile(
        files.sandboxVarsPath,
        '-- SandboxVars\nSandboxVars = {\n}\n',
      );
      await this.loadoutsApi.writeTextFile(
        files.spawnpointsPath,
        '-- Spawnpoints\nfunction SpawnPoints()\n    return {\n    }\nend\n',
      );
      await this.loadoutsApi.writeTextFile(
        files.spawnregionsPath,
        '-- Spawnregions\nfunction SpawnRegions()\n    return {\n    }\nend\n',
      );
      this.createDialogVisible = false;
      await this.refreshServerList();
      await this.selectServer(trimmed);
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.createFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.createFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    }
  }

  async loadServerFiles(): Promise<void> {
    if (!this.selectedServerName || !this.userDir) {
      return;
    }
    const files = this.buildServerFileSet(this.selectedServerName);
    this.loadingServer = true;
    try {
      this.iniText = await this.safeReadFile(files.iniPath);
      this.iniLines = this.parseIniText(this.iniText);
      this.iniOriginalValues = this.buildIniOriginalValues(this.iniLines);
      this.sandboxVarsText = await this.safeReadFile(files.sandboxVarsPath);
      this.spawnpointsText = await this.safeReadFile(files.spawnpointsPath);
      this.spawnregionsText = await this.safeReadFile(files.spawnregionsPath);
    } finally {
      this.loadingServer = false;
    }
  }

  async saveServerFiles(): Promise<void> {
    if (!this.selectedServerName || !this.userDir) {
      return;
    }
    const files = this.buildServerFileSet(this.selectedServerName);
    this.savingServer = true;
    try {
      const iniPayload = this.serializeIni(this.iniLines);
      await this.loadoutsApi.writeTextFile(files.iniPath, iniPayload);
      await this.loadoutsApi.writeTextFile(
        files.sandboxVarsPath,
        this.sandboxVarsText ?? '',
      );
      await this.loadoutsApi.writeTextFile(
        files.spawnpointsPath,
        this.spawnpointsText ?? '',
      );
      await this.loadoutsApi.writeTextFile(
        files.spawnregionsPath,
        this.spawnregionsText ?? '',
      );
      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.server.saved.summary'),
        detail: this.transloco.translate('toasts.server.saved.detail'),
        life: 3000,
      });
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.saveFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.saveFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    } finally {
      this.savingServer = false;
    }
  }

  applyPresetToIni(): void {
    if (!this.selectedPresetId) {
      return;
    }
    const preset = this.presets.find((p) => p.id === this.selectedPresetId);
    if (!preset) {
      return;
    }
    const values = this.buildServerConfigValues(preset);
    this.upsertIniEntry(this.iniLines, 'Mods', values.mods);
    this.upsertIniEntry(this.iniLines, 'WorkshopItems', values.workshopItems);
    this.upsertIniEntry(this.iniLines, 'Map', values.map);
    this.iniText = this.serializeIni(this.iniLines);
  }

  onIniEntrySelect(value: unknown): void {
    const key =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object' && 'key' in value
          ? String((value as { key: string }).key)
          : '';
    this.selectedIniKey = key;
    if (!key) {
      return;
    }
    this.openIniEditDialog(key);
  }

  onIniEntryClick(event: unknown): void {
    const key =
      event && typeof event === 'object'
        ? 'value' in event
          ? String((event as { value: string }).value ?? '')
          : 'option' in event
            ? String((event as { option: { key?: string; value?: string } }).option?.key ??
                (event as { option: { key?: string; value?: string } }).option?.value ??
                '')
            : ''
        : '';
    const resolved = key || this.selectedIniKey;
    if (resolved) {
      this.openIniEditDialog(resolved);
    }
  }

  private buildServerFileSet(name: string): ServerFileSet {
    const base = `${this.userDir}\\Server\\${name}`;
    return {
      iniPath: `${base}.ini`,
      sandboxVarsPath: `${base}_SandboxVars.lua`,
      spawnpointsPath: `${base}_spawnpoints.lua`,
      spawnregionsPath: `${base}_spawnregions.lua`,
    };
  }

  private async safeReadFile(path: string): Promise<string> {
    try {
      return await this.loadoutsApi.readTextFile(path);
    } catch {
      return '';
    }
  }

  private validateServerName(name: string): string | null {
    if (!name) {
      return this.transloco.translate('toasts.server.invalidName.detailMissing');
    }
    if (/[<>:"/\\|?*]/.test(name)) {
      return this.transloco.translate('toasts.server.invalidName.detailInvalidChars');
    }
    if (name.endsWith('.') || name.endsWith(' ')) {
      return this.transloco.translate('toasts.server.invalidName.detailTrailing');
    }
    return null;
  }

  private upsertIniKey(text: string, key: string, value: string): string {
    const lines = (text ?? '').split(/\r?\n/);
    const pattern = new RegExp(`^\\s*${key}\\s*=`, 'i');
    let found = false;
    const next = lines.map((line) => {
      if (pattern.test(line)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) {
      if (next.length && next[next.length - 1].trim() !== '') {
        next.push('');
      }
      next.push(`${key}=${value}`);
    }
    return next.join('\n');
  }

  private buildServerConfigValues(loadout: Loadout): {
    mods: string;
    workshopItems: string;
    map: string;
  } {
    const disabled = new Set(this.expandModIds(loadout.disabledModIds ?? []));
    const modIds = this.expandModIds(loadout.modIds ?? []).filter(
      (id) => !disabled.has(id),
    );
    const modsValue = modIds.map((id) => `\\${id}`).join(';');
    const workshopIds: string[] = [];
    const seen = new Set<string>();
    const pushId = (id: string): void => {
      const cleaned = (id ?? '').trim();
      if (!cleaned || seen.has(cleaned)) {
        return;
      }
      seen.add(cleaned);
      workshopIds.push(cleaned);
    };
    for (const modId of modIds) {
      pushId(loadout.workshopByModId?.[modId] || '');
    }
    for (const id of loadout.workshopIds ?? []) {
      pushId(id);
    }
    const workshopValue = workshopIds.join(';');
    const mapValue = (loadout.mapEntries ?? [])
      .filter((entry) => entry?.mapFolder && modIds.includes(entry.modId))
      .map((entry) => entry.mapFolder)
      .join(';');
    return { mods: modsValue, workshopItems: workshopValue, map: mapValue };
  }

  private expandModIds(input: string[] | null | undefined): string[] {
    const out: string[] = [];
    for (const raw of input ?? []) {
      const parts = String(raw ?? '')
        .split(';')
        .map((id) => id.trim())
        .filter((id) => !!id);
      out.push(...parts);
    }
    return out;
  }

  isLongValue(value: string | undefined): boolean {
    return (value ?? '').length > 120;
  }

  isBooleanValue(value: string | undefined): boolean {
    const normalized = (value ?? '').trim().toLowerCase();
    return normalized === 'true' || normalized === 'false';
  }

  formatIniLabel(key: string | undefined): string {
    const raw = (key ?? '').trim();
    if (!raw) {
      return '';
    }
    const spaced = raw
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  isIniValueChanged(key: string | undefined, value: string | undefined): boolean {
    const normalizedKey = (key ?? '').trim();
    if (!normalizedKey) {
      return false;
    }
    const original = this.iniOriginalValues.get(normalizedKey);
    return (original ?? '') !== (value ?? '');
  }

  fieldWrapperId(key: string | undefined): string {
    const safe = (key ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
    return `ini-field-${safe}`;
  }

  fieldInputId(key: string | undefined): string {
    const safe = (key ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
    return `ini-input-${safe}`;
  }

  getIniValueByKey(key: string | undefined): string {
    const normalizedKey = (key ?? '').trim();
    if (!normalizedKey) {
      return '';
    }
    const line = this.iniLines.find((l) => l.kind === 'entry' && l.key === normalizedKey);
    return line?.value ?? '';
  }

  openIniEditDialog(key: string): void {
    const normalizedKey = (key ?? '').trim();
    const line = this.iniLines.find(
      (l) => l.kind === 'entry' && l.key === normalizedKey,
    );
    if (!line) {
      return;
    }
    this.editIniLine = line;
    this.editIniValue = line.value ?? '';
    this.editIniVisible = true;
  }

  cancelIniEdit(): void {
    this.editIniVisible = false;
    this.editIniLine = null;
    this.editIniValue = '';
  }

  saveIniEdit(): void {
    if (!this.editIniLine) {
      this.cancelIniEdit();
      return;
    }
    this.editIniLine.value = this.editIniValue ?? '';
    this.editIniVisible = false;
    this.editIniLine = null;
    this.editIniValue = '';
  }

  isWelcomeMessageKey(key: string | undefined): boolean {
    return (key ?? '').trim() === 'ServerWelcomeMessage';
  }

  private parseIniText(text: string): IniLine[] {
    const lines = (text ?? '').split(/\r?\n/);
    let pendingComment = '';
    return lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        pendingComment = '';
        return { kind: 'blank', raw: line };
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
        const comment = trimmed.replace(/^(#|\/\/)\s?/, '');
        pendingComment = pendingComment
          ? `${pendingComment}\n${comment}`
          : comment;
        return { kind: 'comment', raw: line };
      }
      const idx = line.indexOf('=');
      if (idx >= 0) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1);
        const entry: IniLine = {
          kind: 'entry',
          key,
          value,
          comment: pendingComment,
        };
        pendingComment = '';
        return entry;
      }
      pendingComment = '';
      return { kind: 'comment', raw: line };
    });
  }

  private serializeIni(lines: IniLine[]): string {
    return lines
      .map((line) => {
        if (line.kind === 'entry') {
          return `${line.key ?? ''}=${line.value ?? ''}`;
        }
        return line.raw ?? '';
      })
      .join('\n');
  }

  private upsertIniEntry(lines: IniLine[], key: string, value: string): void {
    const target = key.trim();
    const entry = lines.find(
      (line) =>
        line.kind === 'entry' && (line.key ?? '').trim().toLowerCase() === target.toLowerCase(),
    );
    if (entry) {
      entry.key = target;
      entry.value = value;
      return;
    }
    lines.push({ kind: 'entry', key: target, value });
  }

  private buildIniOriginalValues(lines: IniLine[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of lines) {
      if (line.kind !== 'entry' || !line.key) {
        continue;
      }
      map.set(line.key, line.value ?? '');
    }
    return map;
  }
}
