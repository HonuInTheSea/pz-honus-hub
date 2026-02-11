import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MultiSelectModule } from 'primeng/multiselect';
import { TextareaModule } from 'primeng/textarea';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { TableModule } from 'primeng/table';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { ModsStateService } from '../../services/mods-state.service';
import { LoadoutsStateService } from '../../services/loadouts-state.service';
import { LoadoutsService } from '../../services/loadouts.service';
import { TauriStoreService } from '../../services/tauri-store.service';
import { ModPresetsImportService } from '../../services/mod-presets-import.service';
import { SaveModsImportService } from '../../services/save-mods-import.service';
import { PzDefaultPathsService } from '../../services/pz-default-paths.service';
import type { ModSummary } from '../../models/mod.models';
import type {
  Loadout,
  LoadoutAnalysis,
  LoadoutResolvedMod,
  LoadoutTargetMode,
} from '../../models/loadout.models';
import { modsToResolvedMods } from '../../models/loadout.models';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { TranslocoService } from '@jsverse/transloco';

interface WebPresetMod {
  workshopId?: string | null;
  modId?: string | null;
  modName?: string | null;
  enabled?: boolean | null;
  isMap?: boolean | null;
  mapFolder?: string | null;
}

interface WebPresetFile {
  version?: string | null;
  date?: string | null;
  mods?: WebPresetMod[] | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `loadout_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function parseActiveModsRelDir(presetName: string | null | undefined): string | null {
  const name = (presetName ?? '').trim();
  const prefix = 'Active Mods (';
  if (!name.startsWith(prefix) || !name.endsWith(')')) {
    return null;
  }
  const inner = name.slice(prefix.length, -1).trim();
  return inner ? inner : null;
}

@Component({
  selector: 'app-loadouts-page',
  standalone: true,
  providers: [MessageService],
  imports: [
    CommonModule,
    FormsModule,
    CardModule,
    ButtonModule,
    InputTextModule,
    MultiSelectModule,
    TextareaModule,
    DialogModule,
    MessageModule,
    TagModule,
    TableModule,
    ToastModule,
  ],
  templateUrl: './loadouts.page.html',
})
export class LoadoutsPageComponent implements OnInit {
  private static readonly importCooldownMs = 15000;
  private static readonly presetImportAtByUserDir = new Map<string, number>();
  private static readonly savesImportAtByUserDir = new Map<string, number>();

  mods: ModSummary[] = [];
  loadouts: Loadout[] = [];
  private installedModsCache: ModSummary[] = [];
  private modIdOptionsCache: Array<{ label: string; value: string }> = [];
  private availableModIdsCache = new Set<string>();
  private modOptionsVersion = 0;
  private draftDerivedCache:
    | {
        draftRef: Loadout | null;
        modIdsRef: string[] | undefined;
        modOptionsVersion: number;
        data: {
          missingDraftModIds: string[];
          missingDraftModEntriesCount: number;
          missingDraftModIdCounts: Array<{ modId: string; count: number }>;
          draftModEntryCount: number;
          draftModIdOptions: Array<{ label: string; value: string }>;
        };
      }
    | null = null;

  editorVisible = false;
  selected: Loadout | null = null;
  draft: Loadout | null = null;

  codeVisible = false;
  codeLoadout: Loadout | null = null;
  codeModsLine = '';
  codeWorkshopLine = '';
  codeMapLine = '';

  analysis: LoadoutAnalysis | null = null;
  analysisCycleDisplay: string[] = [];
  analysisConflictDisplay: Array<{ relativePath: string; modsDisplay: string }> = [];
  analyzing = false;
  confirmVisible = false;
  confirmMessage = '';
  private pendingSave:
    | { analysis: LoadoutAnalysis; orderedIds: string[]; originalIds: string[] }
    | null = null;

  exportVisible = false;
  exportPresetName = '';
  exportZomboidUserDir = '';
  exportPlanText = '';
  exporting = false;
  exportingLoadout: Loadout | null = null;
  exportTargetPath = '';
  userDirExample = '';
  deleteConfirmVisible = false;
  pendingDeleteLoadout: Loadout | null = null;

  spVisible = false;
  spZomboidUserDir = '';
  spSaveRelPath = 'Saves/Survival/';
  spPlanText = '';
  spTargetPath = '';
  applyingSp = false;

  availableModes: Array<{ label: string; value: LoadoutTargetMode }> = [
    { label: 'Singleplayer', value: 'singleplayer' },
    { label: 'Host', value: 'host' },
    { label: 'Dedicated Server', value: 'dedicated' },
    { label: 'Co-op', value: 'coop' },
  ];

  get sortedLoadouts(): Loadout[] {
    return (this.loadouts ?? [])
      .slice()
      .sort((a, b) =>
        (a?.name ?? '').localeCompare(b?.name ?? '', undefined, {
          sensitivity: 'base',
          numeric: true,
        }),
      );
  }

  get clientLoadouts(): Loadout[] {
    return this.sortedLoadouts.filter((l) =>
      (l.targetModes ?? []).some((m) => m === 'singleplayer' || m === 'coop'),
    );
  }

  private get installedMods(): ModSummary[] {
    return this.installedModsCache;
  }

  get installedModsCount(): number {
    return this.installedMods.length;
  }

  get availableModOptionsCount(): number {
    return this.modIdOptions.length;
  }

  constructor(
    private readonly modsState: ModsStateService,
    private readonly loadoutsState: LoadoutsStateService,
    private readonly loadoutsApi: LoadoutsService,
    private readonly store: TauriStoreService,
    private readonly presetsImport: ModPresetsImportService,
    private readonly saveModsImport: SaveModsImportService,
    private readonly pzDefaults: PzDefaultPathsService,
    private readonly messageService: MessageService,
    private readonly transloco: TranslocoService,
  ) {}

  async ngOnInit(): Promise<void> {
    this.userDirExample = await this.pzDefaults.getDefaultUserDirExample();
    const persisted = await this.modsState.loadPersistedMods();
    this.setMods((persisted?.local ?? []).filter((m) => !m.hidden));

    this.loadouts = await this.loadoutsState.load();
    const userDir = await this.resolveUserDir();
    await this.importPzModPresets(userDir);
    await this.importActiveModsFromSaves(userDir);
  }

  private async resolveUserDir(): Promise<string> {
    const storedUserDir = await this.store.getItem<string>('pz_user_dir');
    return (
      (storedUserDir ?? '').trim() ||
      (await this.loadoutsApi.getDefaultZomboidUserDir()) ||
      ''
    );
  }

  private shouldRunImport(
    cache: Map<string, number>,
    userDir: string,
    force = false,
  ): boolean {
    if (force) {
      cache.set(userDir, Date.now());
      return true;
    }
    const lastAt = cache.get(userDir) ?? 0;
    const now = Date.now();
    if (now - lastAt < LoadoutsPageComponent.importCooldownMs) {
      return false;
    }
    cache.set(userDir, now);
    return true;
  }

  private async importPzModPresets(userDir: string, force = false): Promise<void> {
    if (!userDir) {
      return;
    }
    if (
      !this.shouldRunImport(
        LoadoutsPageComponent.presetImportAtByUserDir,
        userDir,
        force,
      )
    ) {
      return;
    }

    const candidates = [
      `${userDir}\\Lua\\pz_modlist_settings.cfg`
    ];

    let text: string | null = null;
    for (const path of candidates) {
      try {
        text = await this.loadoutsApi.readTextFile(path, { cacheTtlMs: 5000 });
        break;
      } catch {
        // ignore and try next candidate
      }
    }
    if (!text) {
      return;
    }

    const presets = this.presetsImport.parsePzModlistSettingsFavorites(text);
    if (!presets.length) {
      return;
    }

    const result = this.presetsImport.upsertLoadoutsFromPresets(
      this.loadouts,
      presets,
      this.mods,
    );
    if (result.created || result.updated) {
      await this.loadoutsState.save(result.loadouts);
      this.loadouts = result.loadouts;
    }
  }

  private async importActiveModsFromSaves(
    userDir: string,
    force = false,
  ): Promise<void> {
    if (!userDir) {
      return;
    }
    if (
      !this.shouldRunImport(
        LoadoutsPageComponent.savesImportAtByUserDir,
        userDir,
        force,
      )
    ) {
      return;
    }

    let files: string[] = [];
    try {
      files = await this.loadoutsApi.listSaveModsFiles(userDir);
    } catch {
      return;
    }
    if (!files.length) {
      return;
    }

    const existingByName = new Map<string, Loadout>();
    for (const l of this.loadouts) {
      existingByName.set(l.name, l);
    }

    let changed = false;
    const next = this.loadouts.slice();

    for (const file of files) {
      let text: string;
      try {
        text = await this.loadoutsApi.readTextFile(file, { cacheTtlMs: 5000 });
      } catch {
        continue;
      }

      const parsed = this.saveModsImport.parseModsTxt(text);
      if (!parsed.modIds.length && !parsed.mapIds.length) {
        continue;
      }

      const relDir = this.deriveSaveRelDir(userDir, file);
      if (!relDir) {
        continue;
      }

      const name = `Active Mods (${relDir})`;
      const description =
        parsed.mapIds.length > 0
          ? `Imported from save mods.txt. Maps: ${parsed.mapIds.join('; ')}`
          : 'Imported from save mods.txt.';

      const existing = existingByName.get(name) ?? null;
      const mergedModIds = this.mergeUnique(existing?.modIds ?? [], parsed.modIds);

      if (!existing) {
        const ts = nowIso();
        next.unshift({
          id: newId(),
          name,
          description,
          createdAt: ts,
          updatedAt: ts,
          targetModes: ['singleplayer'],
          modIds: mergedModIds,
          workshopIds: this.resolveWorkshopIdsForDraft(mergedModIds),
        });
        existingByName.set(name, next[0]);
        changed = true;
        continue;
      }

      const modsChanged =
        mergedModIds.length !== (existing.modIds ?? []).length ||
        mergedModIds.some((m, i) => (existing.modIds ?? [])[i] !== m);
      const descChanged = (existing.description ?? '') !== description;

      if (!modsChanged && !descChanged) {
        continue;
      }

      const idx = next.findIndex((l) => l.id === existing.id);
      if (idx < 0) {
        continue;
      }

      next[idx] = {
        ...existing,
        description,
        updatedAt: nowIso(),
        modIds: mergedModIds,
        workshopIds: this.resolveWorkshopIdsForDraft(mergedModIds),
      };
      existingByName.set(name, next[idx]);
      changed = true;
    }

    if (changed) {
      await this.loadoutsState.save(next);
      this.loadouts = next;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('pz-presets-updated'));
      }
    }
  }

  private deriveSaveRelDir(userDir: string, modsTxtPath: string): string | null {
    const base = `${userDir.replace(/\//g, '\\')}\\Saves\\`;
    const full = modsTxtPath.replace(/\//g, '\\');
    const idx = full.toLowerCase().indexOf(base.toLowerCase());
    if (idx < 0) {
      return null;
    }
    const after = full.slice(idx + base.length);
    const parts = after.split('\\').filter((p) => p.length > 0);
    if (parts.length < 2) {
      return null;
    }
    // drop trailing mods.txt
    const relParts = parts.slice(0, -1);
    return relParts.join('\\');
  }

  private mergeUnique(a: string[], b: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of [...(a ?? []), ...(b ?? [])]) {
      const id = (v ?? '').trim();
      if (!id) {
        continue;
      }
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  async refreshModsFromDisk(): Promise<void> {
    const persisted = await this.modsState.loadPersistedMods();
    this.setMods((persisted?.local ?? []).filter((m) => !m.hidden));
  }

  get modIdOptions(): Array<{ label: string; value: string }> {
    return this.modIdOptionsCache;
  }

  get missingDraftModIds(): string[] {
    return this.getDraftDerivedData().missingDraftModIds;
  }

  get missingDraftModEntriesCount(): number {
    return this.getDraftDerivedData().missingDraftModEntriesCount;
  }

  get missingDraftModIdCounts(): Array<{ modId: string; count: number }> {
    return this.getDraftDerivedData().missingDraftModIdCounts;
  }

  get draftModEntryCount(): number {
    return this.getDraftDerivedData().draftModEntryCount;
  }

  get draftModIdOptions(): Array<{ label: string; value: string }> {
    return this.getDraftDerivedData().draftModIdOptions;
  }

  openNew(): void {
    const ts = nowIso();
    this.selected = null;
    this.setAnalysis(null);
    this.analyzing = false;
    this.confirmVisible = false;
    this.pendingSave = null;
    this.draft = {
      id: newId(),
      name: 'New Preset',
      description: null,
      createdAt: ts,
      updatedAt: ts,
      targetModes: ['singleplayer'],
      modIds: [],
      workshopIds: [],
      workshopByModId: {},
      disabledModIds: [],
      mapEntries: [],
    };
    this.editorVisible = true;
  }

  openEdit(loadout: Loadout): void {
    this.selected = loadout;
    this.setAnalysis(null);
    this.analyzing = false;
    this.confirmVisible = false;
    this.pendingSave = null;
    this.draft = JSON.parse(JSON.stringify(loadout)) as Loadout;
    this.draft.workshopByModId = { ...(this.draft.workshopByModId ?? {}) };
    this.draft.disabledModIds = [...(this.draft.disabledModIds ?? [])];
    this.draft.mapEntries = (this.draft.mapEntries ?? []).map((entry) => ({
      modId: (entry?.modId ?? '').trim(),
      mapFolder: (entry?.mapFolder ?? '').trim(),
    }));
    this.editorVisible = true;
  }

  async saveDraft(): Promise<void> {
    if (!this.draft) {
      return;
    }

    this.normalizeDraft();

    const name = this.draft.name.trim();
    if (!name) {
      this.draft.name = 'Unnamed Preset';
    } else {
      this.draft.name = name;
    }

    if (this.isDuplicatePresetName(this.draft.name, this.draft.id)) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.loadouts.presetNameExists.summary'),
        detail: this.transloco.translate('toasts.loadouts.presetNameExists.detail', {
          name: this.draft.name,
        }),
        life: 8000,
        closable: true,
      });
      return;
    }

    const originalModIds = [...(this.draft.modIds ?? [])];
    const resolvedMods = modsToResolvedMods(this.installedMods, originalModIds);
    let analysis: LoadoutAnalysis;
    this.analyzing = true;
    try {
      analysis = this.analyzeResolvedMods(resolvedMods);
    } finally {
      this.analyzing = false;
    }

    const orderedIds = analysis?.orderedModIds?.length
      ? this.mergeOrderedModIds(analysis.orderedModIds, originalModIds)
      : [...originalModIds];

    const confirmText = this.buildConfirmMessage(
      analysis,
      originalModIds,
      orderedIds,
    );
    if (confirmText) {
      this.pendingSave = { analysis, orderedIds, originalIds: originalModIds };
      this.confirmMessage = confirmText;
      this.confirmVisible = true;
      return;
    }

    await this.finalizeSave(analysis, orderedIds, originalModIds);
  }

  async confirmSave(): Promise<void> {
    if (!this.pendingSave) {
      this.confirmVisible = false;
      return;
    }
    const pending = this.pendingSave;
    this.pendingSave = null;
    this.confirmVisible = false;
    await this.finalizeSave(pending.analysis, pending.orderedIds, pending.originalIds);
  }

  cancelConfirm(): void {
    this.confirmVisible = false;
    this.pendingSave = null;
  }

  openCode(loadout: Loadout): void {
    if (!loadout?.modIds?.length) {
      this.messageService.add({
        severity: 'warn',
        summary: this.transloco.translate('toasts.loadouts.noModsToExport.summary'),
        detail: this.transloco.translate('toasts.loadouts.noModsToExport.detailCode'),
        life: 4000,
      });
      return;
    }
    this.codeLoadout = loadout;
    const output = this.buildCodeOutput(loadout);
    this.codeModsLine = output.mods;
    this.codeWorkshopLine = output.workshop;
    this.codeMapLine = output.map;
    this.codeVisible = true;
  }

  copyCodeLine(value: string, label: string): void {
    if (!value) {
      return;
    }
    navigator.clipboard.writeText(value).then(() => {
      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.loadouts.copied.summary'),
        detail: this.transloco.translate('toasts.loadouts.copied.detail', { label }),
        life: 2500,
      });
    });
  }

  async deleteLoadout(loadout: Loadout): Promise<void> {
    this.pendingDeleteLoadout = loadout;
    this.deleteConfirmVisible = true;
  }

  async confirmDeleteLoadout(): Promise<void> {
    if (!this.pendingDeleteLoadout) {
      this.deleteConfirmVisible = false;
      return;
    }
    const loadout = this.pendingDeleteLoadout;
    this.pendingDeleteLoadout = null;
    this.deleteConfirmVisible = false;
    this.loadouts = this.loadouts.filter((l) => l.id !== loadout.id);
    await this.loadoutsState.save(this.loadouts);
    await this.removePresetFromModlistSettings(loadout.name);
    if (this.selected?.id === loadout.id) {
      this.selected = null;
      this.draft = null;
      this.editorVisible = false;
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('pz-presets-updated'));
    }
  }

  cancelDeleteLoadout(): void {
    this.deleteConfirmVisible = false;
    this.pendingDeleteLoadout = null;
  }

  openPresetImport(input: HTMLInputElement): void {
    input.click();
  }

  async importPresetJson(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as WebPresetFile | WebPresetMod[];
      const mods = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.mods)
          ? parsed.mods
          : null;
      if (!mods) {
        throw new Error('Invalid preset format.');
      }

      const modIds: string[] = [];
      const disabledModIds: string[] = [];
      const workshopIds = new Set<string>();
      const workshopByModId: Record<string, string> = {};
      const mapEntries = new Map<string, string>();

      for (const mod of mods) {
        const modIdRaw = ((mod?.modId ?? mod?.modName ?? '') as string).trim();
        if (!modIdRaw) {
          continue;
        }
        const ids = modIdRaw
          .split(';')
          .map((id) => id.trim())
          .filter((id) => !!id);
        for (const id of ids) {
          modIds.push(id);
          if (mod?.enabled === false) {
            disabledModIds.push(id);
          }
          if (mod?.isMap && mod?.mapFolder) {
            mapEntries.set(id, String(mod.mapFolder).trim());
          }
          const workshopId = String(mod?.workshopId ?? '').trim();
          if (workshopId && !workshopByModId[id]) {
            workshopByModId[id] = workshopId;
          }
        }
        const workshopId = String(mod?.workshopId ?? '').trim();
        if (workshopId) {
          workshopIds.add(workshopId);
        }
      }

      const uniqueModIds = this.mergeUnique([], modIds);
      const nameBase = file.name.replace(/\.json$/i, '').trim();
      const name = this.resolveImportedPresetName(
        nameBase || `Imported Preset ${new Date().toISOString().split('T')[0]}`,
      );

      const ts = nowIso();
      const loadout: Loadout = {
        id: newId(),
        name,
        description: 'Imported from PZ Mod Manager preset JSON.',
        createdAt: ts,
        updatedAt: ts,
        targetModes: ['singleplayer'],
        modIds: uniqueModIds,
        workshopIds: Array.from(workshopIds),
        workshopByModId,
        disabledModIds: this.mergeUnique([], disabledModIds),
        mapEntries: Array.from(mapEntries.entries()).map(([modId, mapFolder]) => ({
          modId,
          mapFolder,
        })),
      };

      this.loadouts = [loadout, ...this.loadouts];
      await this.loadoutsState.save(this.loadouts);
      this.openEdit(loadout);

      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.loadouts.presetImported.summary'),
        detail: this.transloco.translate('toasts.loadouts.presetImported.detail', {
          count: uniqueModIds.length,
        }),
        life: 4000,
      });
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.loadouts.importFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.loadouts.importFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    } finally {
      if (input) {
        input.value = '';
      }
    }
  }

  exportPresetJson(loadout: Loadout): void {
    if (!loadout?.modIds?.length) {
      this.messageService.add({
        severity: 'warn',
        summary: this.transloco.translate('toasts.loadouts.noModsToExport.summary'),
        detail: this.transloco.translate('toasts.loadouts.noModsToExport.detailPreset'),
        life: 4000,
      });
      return;
    }
    const preset = this.buildWebPreset(loadout);
    const dataStr = JSON.stringify(preset, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `pzmods_preset_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  addMapEntry(): void {
    if (!this.draft) {
      return;
    }
    this.draft.mapEntries = [...(this.draft.mapEntries ?? [])];
    this.draft.mapEntries.push({ modId: '', mapFolder: '' });
  }

  removeMapEntry(index: number): void {
    if (!this.draft?.mapEntries) {
      return;
    }
    this.draft.mapEntries = this.draft.mapEntries.filter((_, i) => i !== index);
  }

  resolveWorkshopIdsForDraft(modIds: string[]): string[] {
    const ids = new Set<string>();
    const byModId = new Map<string, ModSummary>();
    for (const mod of this.installedMods) {
      const modId = (mod.mod_id ?? '').trim();
      if (modId) {
        byModId.set(modId, mod);
      }
    }

    for (const modId of this.expandModIds(modIds)) {
      const mod = byModId.get(modId);
      const direct = (mod?.workshop_id ?? '').trim();
      if (direct) {
        ids.add(direct);
        continue;
      }
      const fileid =
        mod?.workshop?.fileid != null ? String(mod.workshop.fileid) : '';
      if (fileid) {
        ids.add(fileid);
      }
    }

    return Array.from(ids).sort();
  }

  resolveWorkshopMapForDraft(modIds: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const byModId = new Map<string, ModSummary>();
    for (const mod of this.installedMods) {
      const modId = (mod.mod_id ?? '').trim();
      if (modId) {
        byModId.set(modId, mod);
      }
    }

    for (const modId of this.expandModIds(modIds)) {
      const cleaned = (modId ?? '').trim();
      if (!cleaned || out[cleaned]) {
        continue;
      }
      const mod = byModId.get(cleaned);
      const direct = (mod?.workshop_id ?? '').trim();
      if (direct) {
        out[cleaned] = direct;
        continue;
      }
      const fileid =
        mod?.workshop?.fileid != null ? String(mod.workshop.fileid) : '';
      if (fileid) {
        out[cleaned] = fileid;
      }
    }

    return out;
  }

  async analyze(): Promise<void> {
    if (!this.draft) {
      return;
    }
    this.analyzing = true;
    try {
      const resolvedMods = modsToResolvedMods(
        this.installedMods,
        this.draft.modIds,
      );
      this.setAnalysis(this.analyzeResolvedMods(resolvedMods));
    } finally {
      this.analyzing = false;
    }
  }

  async openScannedModsFolder(): Promise<void> {
    const storedUserDir = await this.store.getItem<string>('pz_user_dir');
    const userDir = (storedUserDir ?? '').trim();
    if (userDir) {
      const activeModsRelDir = parseActiveModsRelDir(this.draft?.name);
      if (activeModsRelDir) {
        await revealItemInDir(`${userDir}\\Saves\\${activeModsRelDir}\\mods.txt`);
        return;
      }
      await revealItemInDir(`${userDir}\\Lua\\pz_modlist_settings.cfg`);
      return;
    }

    const stored = await this.store.getItem<string>('pz_mod_folder');
    const folder = (stored ?? '').trim();
    if (folder) {
      const fallback = (this.installedMods?.[0]?.mod_info_path ?? '').trim();
      if (fallback) {
        await revealItemInDir(fallback);
        return;
      }
      await openPath(folder);
      return;
    }

    const fallback = (this.installedMods?.[0]?.mod_info_path ?? '').trim();
    if (fallback) {
      await revealItemInDir(fallback);
    }
  }

  async removeMissingModsAndSave(): Promise<void> {
    if (!this.draft) {
      return;
    }

    const installedIds = new Set(
      this.installedMods
        .map((m) => (m?.mod_id ?? '').trim())
        .filter((id) => !!id),
    );

    const before = this.draft.modIds ?? [];
    const after = before.filter((raw) => {
      const id = (raw ?? '').trim();
      return id && installedIds.has(id);
    });

    this.draft.modIds = after;
    this.setAnalysis(null);
    await this.saveDraft();
  }

  async openExport(loadout: Loadout): Promise<void> {
    this.setAnalysis(null);
    this.exportingLoadout = loadout;
    this.exportPresetName = loadout.name.replace(/[^\w\- ]+/g, '').trim() || 'servertest';
    this.exportVisible = true;
    this.exportPlanText = '';

    if (!this.exportZomboidUserDir) {
      const guess = await this.loadoutsApi.getDefaultZomboidUserDir();
      if (guess) {
        this.exportZomboidUserDir = guess;
      }
    }

    const plan = await this.loadoutsApi.planServerPreset(
      this.exportZomboidUserDir,
      this.exportPresetName,
      loadout.modIds,
      loadout.workshopIds,
    );
    this.exportPlanText = plan.iniPreview;
    this.exportTargetPath = plan.targetPath;
  }

  async writeExport(loadout: Loadout): Promise<void> {
    this.exporting = true;
    try {
      await this.loadoutsApi.writeServerPreset(
        this.exportZomboidUserDir,
        this.exportPresetName,
        loadout.modIds,
        loadout.workshopIds,
      );
      this.exportVisible = false;
    } finally {
      this.exporting = false;
    }
  }

  async openSingleplayerApply(loadout: Loadout): Promise<void> {
    this.setAnalysis(null);
    this.exportingLoadout = loadout;
    this.spVisible = true;
    this.spPlanText = '';
    this.spTargetPath = '';

    if (!this.spZomboidUserDir) {
      const guess = await this.loadoutsApi.getDefaultZomboidUserDir();
      if (guess) {
        this.spZomboidUserDir = guess;
      }
    }

    await this.refreshSingleplayerPlan();
  }

  async browseSpSaveFolder(): Promise<void> {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: this.spZomboidUserDir || undefined,
    });

    if (typeof selected !== 'string' || !selected) {
      return;
    }

    // Convert absolute path to a Zomboid-relative `saveRelPath` when possible.
    const user = (this.spZomboidUserDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const abs = selected.replace(/\\/g, '/');
    if (user && abs.toLowerCase().startsWith(user.toLowerCase() + '/')) {
      this.spSaveRelPath = abs.slice(user.length + 1);
    }

    await this.refreshSingleplayerPlan();
  }

  async refreshSingleplayerPlan(): Promise<void> {
    const l = this.exportingLoadout;
    if (!l) {
      return;
    }
    if (!this.spZomboidUserDir.trim()) {
      return;
    }
    const plan = await this.loadoutsApi.planSingleplayerSaveMods(
      this.spZomboidUserDir,
      this.spSaveRelPath,
      l.modIds,
      l.workshopIds,
    );
    this.spPlanText = plan.iniPreview;
    this.spTargetPath = plan.targetPath;
  }

  async applySingleplayer(loadout: Loadout): Promise<void> {
    this.applyingSp = true;
    try {
      await this.loadoutsApi.writeSingleplayerSaveMods(
        this.spZomboidUserDir,
        this.spSaveRelPath,
        loadout.modIds,
        loadout.workshopIds,
      );
      this.spVisible = false;
    } finally {
      this.applyingSp = false;
    }
  }

  get exportModsLine(): string {
    const l = this.exportingLoadout;
    if (!l) {
      return '';
    }
    return `Mods=${l.modIds.join(';')}`;
  }

  get exportWorkshopLine(): string {
    const l = this.exportingLoadout;
    if (!l) {
      return '';
    }
    return `WorkshopItems=${l.workshopIds.join(';')}`;
  }

  get exportMapLine(): string {
    const l = this.exportingLoadout;
    if (!l) {
      return '';
    }
    const mapFolders = this.collectMapFolders(l);
    return mapFolders.length ? `Map=${mapFolders.join(';')}` : '';
  }

  get exportManifestJson(): string {
    const l = this.exportingLoadout;
    if (!l) {
      return '';
    }
    return JSON.stringify(l, null, 2);
  }

  private analyzeResolvedMods(mods: LoadoutResolvedMod[]): LoadoutAnalysis {
    const modIds = mods.map((m) => (m.modId ?? '').trim()).filter((id) => !!id);
    const selected = new Set(modIds);
    const byId = new Map<string, LoadoutResolvedMod>();
    for (const mod of mods) {
      const id = (mod.modId ?? '').trim();
      if (id) {
        byId.set(id, mod);
      }
    }

    const edges = new Map<string, Set<string>>();
    const indegree = new Map<string, number>();
    const missingModIds = new Set<string>();

    const ensureNode = (id: string): void => {
      if (!edges.has(id)) {
        edges.set(id, new Set<string>());
      }
      if (!indegree.has(id)) {
        indegree.set(id, 0);
      }
    };

    const addEdge = (from: string, to: string): void => {
      ensureNode(from);
      ensureNode(to);
      const next = edges.get(from);
      if (!next || next.has(to)) {
        return;
      }
      next.add(to);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    };

    const collectRefs = (
      ...inputs: Array<string[] | null | undefined>
    ): string[] => {
      const out: string[] = [];
      for (const list of inputs) {
        for (const raw of list ?? []) {
          const cleaned = (raw ?? '').toString().replace(/^\\+/, '').trim();
          if (!cleaned) {
            continue;
          }
          out.push(cleaned);
        }
      }
      return out;
    };

    for (const id of modIds) {
      ensureNode(id);
    }

    for (const mod of mods) {
      const id = (mod.modId ?? '').trim();
      if (!id) {
        continue;
      }

      const deps = collectRefs(mod.dependencies, mod.requires);
      const loadAfter = collectRefs(mod.loadAfter);
      const loadBefore = collectRefs(mod.loadBefore);

      for (const dep of [...deps, ...loadAfter]) {
        if (!selected.has(dep)) {
          missingModIds.add(dep);
          continue;
        }
        addEdge(dep, id);
      }

      for (const dep of loadBefore) {
        if (!selected.has(dep)) {
          missingModIds.add(dep);
          continue;
        }
        addEdge(id, dep);
      }
    }

    const originalOrder = new Map<string, number>();
    modIds.forEach((id, index) => {
      originalOrder.set(id, index);
    });

    const ready = Array.from(indegree.entries())
      .filter(([, count]) => count === 0)
      .map(([id]) => id)
      .sort((a, b) => (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0));

    const ordered: string[] = [];
    const queue = ready.slice();

    while (queue.length) {
      const id = queue.shift() as string;
      ordered.push(id);
      const next = edges.get(id);
      if (!next) {
        continue;
      }
      for (const to of next) {
        indegree.set(to, (indegree.get(to) ?? 0) - 1);
        if ((indegree.get(to) ?? 0) === 0) {
          queue.push(to);
        }
      }
      queue.sort(
        (a, b) => (originalOrder.get(a) ?? 0) - (originalOrder.get(b) ?? 0),
      );
    }

    const leftover = modIds.filter((id) => !ordered.includes(id));
    if (leftover.length) {
      ordered.push(...leftover);
    }

    const incompatiblePairs: Array<{ a: string; b: string }> = [];
    const incompatibleKeys = new Set<string>();
    for (const mod of mods) {
      const id = (mod.modId ?? '').trim();
      if (!id) {
        continue;
      }
      for (const raw of mod.incompatible ?? []) {
        const other = (raw ?? '').toString().replace(/^\\+/, '').trim();
        if (!other || !selected.has(other)) {
          continue;
        }
        const a = id.toLowerCase();
        const b = other.toLowerCase();
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (incompatibleKeys.has(key)) {
          continue;
        }
        incompatibleKeys.add(key);
        incompatiblePairs.push({ a: id, b: other });
      }
    }

    const missingWorkshopIds: string[] = [];
    for (const mod of mods) {
      const id = (mod.modId ?? '').trim();
      if (!id) {
        continue;
      }
      const workshopId = (mod.workshopId ?? '').trim();
      if (!workshopId) {
        missingWorkshopIds.push(id);
      }
    }

    const cycles = leftover.length ? [leftover] : [];

    return {
      orderedModIds: ordered,
      missingModIds: Array.from(missingModIds).sort((a, b) => a.localeCompare(b)),
      missingWorkshopIds,
      cycles,
      incompatiblePairs,
      conflicts: [],
      warnings: [],
    };
  }

  private mergeOrderedModIds(ordered: string[], original: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ordered) {
      const cleaned = (id ?? '').trim();
      if (!cleaned || seen.has(cleaned)) {
        continue;
      }
      seen.add(cleaned);
      out.push(cleaned);
    }
    for (const id of original) {
      const cleaned = (id ?? '').trim();
      if (!cleaned || seen.has(cleaned)) {
        continue;
      }
      seen.add(cleaned);
      out.push(cleaned);
    }
    return out;
  }

  private buildSaveNotice(
    analysis: LoadoutAnalysis,
    originalModIds: string[],
  ): { severity: 'info' | 'warn'; text: string } | null {
    const changes: string[] = [];
    if (!this.arraysEqual(originalModIds, analysis.orderedModIds)) {
      changes.push(
        this.transloco.translate('toasts.loadouts.presetSaveNotice.reordered'),
      );
    }
    if (analysis.missingModIds.length) {
      changes.push(
        this.transloco.translate(
          'toasts.loadouts.presetSaveNotice.missingDependencies',
          { count: analysis.missingModIds.length },
        ),
      );
    }
    if (analysis.missingWorkshopIds.length) {
      changes.push(
        this.transloco.translate(
          'toasts.loadouts.presetSaveNotice.missingWorkshopIds',
          { count: analysis.missingWorkshopIds.length },
        ),
      );
    }
    if (analysis.incompatiblePairs.length) {
      changes.push(
        this.transloco.translate(
          'toasts.loadouts.presetSaveNotice.incompatibilities',
          { count: analysis.incompatiblePairs.length },
        ),
      );
    }
    if (analysis.cycles.length) {
      changes.push(
        this.transloco.translate('toasts.loadouts.presetSaveNotice.cycles', {
          count: analysis.cycles.length,
        }),
      );
    }
    if (analysis.conflicts.length) {
      changes.push(
        this.transloco.translate('toasts.loadouts.presetSaveNotice.conflicts', {
          count: analysis.conflicts.length,
        }),
      );
    }
    if (!changes.length) {
      return null;
    }

    const severity =
      analysis.missingModIds.length ||
      analysis.incompatiblePairs.length ||
      analysis.cycles.length ||
      analysis.conflicts.length
        ? 'warn'
        : 'info';

    return { severity, text: changes.join(' ') };
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => value === b[index]);
  }

  private isDuplicatePresetName(name: string, excludeId: string | null): boolean {
    const target = name.trim().toLowerCase();
    if (!target) {
      return false;
    }
    return this.loadouts.some((l) => {
      if (excludeId && l.id === excludeId) {
        return false;
      }
      return (l.name ?? '').trim().toLowerCase() === target;
    });
  }

  private buildConfirmMessage(
    analysis: LoadoutAnalysis,
    originalModIds: string[],
    orderedIds: string[],
  ): string {
    const messages: string[] = [];
    if (!this.arraysEqual(originalModIds, orderedIds)) {
      messages.push('Mods will be reordered to satisfy dependencies.');
    }
    if (analysis.missingModIds.length) {
      messages.push(`Missing dependencies: ${analysis.missingModIds.length}.`);
    }
    if (analysis.missingWorkshopIds.length) {
      messages.push(`Missing workshop IDs: ${analysis.missingWorkshopIds.length}.`);
    }
    if (analysis.incompatiblePairs.length) {
      messages.push(`Incompatibilities: ${analysis.incompatiblePairs.length}.`);
    }
    if (analysis.cycles.length) {
      messages.push(`Cycles detected: ${analysis.cycles.length}.`);
    }
    if (analysis.conflicts.length) {
      messages.push(`File conflicts: ${analysis.conflicts.length}.`);
    }
    return messages.join(' ');
  }

  private async finalizeSave(
    analysis: LoadoutAnalysis,
    orderedIds: string[],
    originalModIds: string[],
  ): Promise<void> {
    if (!this.draft) {
      return;
    }

    this.setAnalysis(analysis);
    this.draft.modIds = orderedIds;
    this.draft.updatedAt = nowIso();
    const resolvedMap = this.resolveWorkshopMapForDraft(this.draft.modIds);
    const mergedWorkshopMap = {
      ...(this.draft.workshopByModId ?? {}),
      ...resolvedMap,
    };
    this.draft.workshopByModId = mergedWorkshopMap;
    this.draft.workshopIds = Array.from(
      new Set(Object.values(mergedWorkshopMap).filter((id) => !!id)),
    ).sort();
    const presetName = (this.draft.name ?? '').trim();

    const idx = this.loadouts.findIndex((l) => l.id === this.draft!.id);
    if (idx >= 0) {
      this.loadouts[idx] = this.draft;
    } else {
      this.loadouts.unshift(this.draft);
    }

    await this.loadoutsState.save(this.loadouts);
    this.editorVisible = false;
    this.selected = null;
    this.draft = null;

    await this.updatePzModlistSettingsPreset(
      presetName,
      originalModIds,
      orderedIds,
    );
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('pz-presets-updated'));
    }

    const notice = this.buildSaveNotice(analysis, originalModIds);
    if (notice) {
      this.messageService.add({
        severity: notice.severity,
        summary: this.transloco.translate('toasts.loadouts.presetSaved.summary'),
        detail: notice.text,
        life: 10000,
        closable: true,
      });
    }
  }

  private setAnalysis(analysis: LoadoutAnalysis | null): void {
    this.analysis = analysis;
    if (!analysis) {
      this.analysisCycleDisplay = [];
      this.analysisConflictDisplay = [];
      return;
    }

    this.analysisCycleDisplay = analysis.cycles.map((cycle) =>
      cycle.join(' -> '),
    );
    this.analysisConflictDisplay = analysis.conflicts.map((conflict) => ({
      relativePath: conflict.relativePath,
      modsDisplay: (conflict?.mods ?? []).map((m) => m.modId).join(', '),
    }));
  }

  private setMods(mods: ModSummary[]): void {
    this.mods = mods;
    this.installedModsCache = (mods ?? []).filter((m) =>
      !!(m?.mod_info_path ?? '').trim(),
    );

    const out: Array<{ label: string; value: string }> = [];
    for (const mod of this.installedModsCache) {
      const modId = (mod.mod_id ?? '').trim();
      if (!modId) {
        continue;
      }
      out.push({ label: `${mod.name} (${modId})`, value: modId });
    }
    out.sort((a, b) => a.label.localeCompare(b.label));

    this.modIdOptionsCache = out;
    this.availableModIdsCache = new Set(out.map((o) => o.value));
    this.modOptionsVersion++;
    this.draftDerivedCache = null;
  }

  private getDraftDerivedData(): {
    missingDraftModIds: string[];
    missingDraftModEntriesCount: number;
    missingDraftModIdCounts: Array<{ modId: string; count: number }>;
    draftModEntryCount: number;
    draftModIdOptions: Array<{ label: string; value: string }>;
  } {
    if (!this.draft) {
      return {
        missingDraftModIds: [],
        missingDraftModEntriesCount: 0,
        missingDraftModIdCounts: [],
        draftModEntryCount: 0,
        draftModIdOptions: this.modIdOptionsCache,
      };
    }

    const modIdsRef = this.draft.modIds;
    const cache = this.draftDerivedCache;
    if (
      cache &&
      cache.draftRef === this.draft &&
      cache.modIdsRef === modIdsRef &&
      cache.modOptionsVersion === this.modOptionsVersion
    ) {
      return cache.data;
    }

    const rawModIds = modIdsRef ?? [];
    const missingCounts = new Map<string, number>();
    let missingEntriesCount = 0;
    for (const raw of rawModIds) {
      const modId = (raw ?? '').trim();
      if (!modId || this.availableModIdsCache.has(modId)) {
        continue;
      }
      missingEntriesCount++;
      missingCounts.set(modId, (missingCounts.get(modId) ?? 0) + 1);
    }

    const missingDraftModIds = Array.from(missingCounts.keys()).sort((a, b) =>
      a.localeCompare(b),
    );
    const missingDraftModIdCounts = Array.from(missingCounts.entries())
      .map(([modId, count]) => ({ modId, count }))
      .sort((a, b) => b.count - a.count || a.modId.localeCompare(b.modId));

    const draftModIdOptions: Array<{ label: string; value: string }> = [
      ...this.modIdOptionsCache,
    ];
    const known = new Set(draftModIdOptions.map((o) => o.value));
    for (const raw of this.expandModIds(rawModIds)) {
      if (!known.has(raw)) {
        known.add(raw);
        draftModIdOptions.push({ label: raw, value: raw });
      }
    }
    draftModIdOptions.sort((a, b) => a.label.localeCompare(b.label));

    const data = {
      missingDraftModIds,
      missingDraftModEntriesCount: missingEntriesCount,
      missingDraftModIdCounts,
      draftModEntryCount: rawModIds.length,
      draftModIdOptions,
    };

    this.draftDerivedCache = {
      draftRef: this.draft,
      modIdsRef,
      modOptionsVersion: this.modOptionsVersion,
      data,
    };
    return data;
  }

  private async updatePzModlistSettingsPreset(
    presetName: string,
    originalModIds: string[],
    orderedIds: string[],
  ): Promise<void> {
    const storedUserDir = await this.store.getItem<string>('pz_user_dir');
    const userDir =
      (storedUserDir ?? '').trim() ||
      (await this.loadoutsApi.getDefaultZomboidUserDir()) ||
      '';
    if (!userDir) {
      return;
    }

    try {
      if (!presetName) {
        return;
      }
      const modIds = orderedIds.length ? orderedIds : originalModIds;
      const result = await this.loadoutsApi.upsertModlistSettingsPreset(
        userDir,
        presetName,
        modIds,
      );
      if (result && result.updated === false) {
        this.messageService.add({
          severity: 'warn',
          summary: this.transloco.translate('toasts.loadouts.presetSaved.summary'),
          detail:
            result.reason ||
            this.transloco.translate('toasts.loadouts.presetSaved.detailFallback'),
          life: 8000,
          closable: true,
        });
      }
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.loadouts.presetSaved.detailFailed');
      this.messageService.add({
        severity: 'warn',
        summary: this.transloco.translate('toasts.loadouts.presetSaved.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    }
  }

  private async removePresetFromModlistSettings(presetName: string): Promise<void> {
    const storedUserDir = await this.store.getItem<string>('pz_user_dir');
    const userDir =
      (storedUserDir ?? '').trim() ||
      (await this.loadoutsApi.getDefaultZomboidUserDir()) ||
      '';
    if (!userDir || !presetName.trim()) {
      return;
    }

    try {
      const result = await this.loadoutsApi.removeModlistSettingsPreset(
        userDir,
        presetName,
      );
      if (result && result.updated === false) {
        this.messageService.add({
          severity: 'warn',
          summary: this.transloco.translate('toasts.loadouts.presetDeleted.summary'),
          detail:
            result.reason ||
            this.transloco.translate('toasts.loadouts.presetDeleted.detailFallback'),
          life: 8000,
          closable: true,
        });
      }
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.loadouts.presetDeleted.detailFailed');
      this.messageService.add({
        severity: 'warn',
        summary: this.transloco.translate('toasts.loadouts.presetDeleted.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    }
  }

  private resolveImportedPresetName(base: string): string {
    const normalizedBase = base.trim() || 'Imported Preset';
    if (!this.isDuplicatePresetName(normalizedBase, null)) {
      return normalizedBase;
    }
    let counter = 2;
    while (counter < 1000) {
      const next = `${normalizedBase} (${counter})`;
      if (!this.isDuplicatePresetName(next, null)) {
        return next;
      }
      counter += 1;
    }
    return `${normalizedBase} (${Date.now()})`;
  }

  private buildWebPreset(loadout: Loadout): WebPresetFile {
    const now = nowIso();
    const disabled = new Set(this.expandModIds(loadout.disabledModIds ?? []));
    const mapByModId = this.buildMapFolderLookup(loadout);
    const mods: WebPresetMod[] = [];
    for (const raw of loadout.modIds ?? []) {
      const ids = this.expandModIds([raw]);
      for (const id of ids) {
        const workshopId = this.resolveWorkshopIdForModId(id, loadout);
        const mapFolder = mapByModId.get(id) ?? '';
        mods.push({
          workshopId: workshopId || null,
          modId: id,
          enabled: !disabled.has(id),
          isMap: !!mapFolder,
          mapFolder: mapFolder || null,
        });
      }
    }
    return {
      version: '1.0',
      date: now,
      mods,
    };
  }

  private buildCodeOutput(loadout: Loadout): {
    mods: string;
    workshop: string;
    map: string;
  } {
    const disabled = new Set(this.expandModIds(loadout.disabledModIds ?? []));
    const mapFolders = this.collectMapFolders(loadout, disabled);
    const entries = this.expandModIds(loadout.modIds ?? []).filter(
      (id) => !disabled.has(id),
    );
    const modsValue = entries.map((id) => `\\${id}`).join(';');

    const workshopIds = entries.map((id) =>
      this.resolveWorkshopIdForModId(id, loadout),
    );
    const workshopValue = workshopIds.join(';');

    return {
      mods: `Mods=${modsValue}`,
      workshop: `WorkshopItems=${workshopValue}`,
      map: mapFolders.length ? `Map=${mapFolders.join(';')}` : '',
    };
  }


  private resolveWorkshopIdForModId(modId: string, loadout?: Loadout): string {
    const id = (modId ?? '').trim();
    if (!id) {
      return '';
    }
    const fromPreset = loadout?.workshopByModId?.[id];
    if (fromPreset) {
      return fromPreset;
    }
    const found = this.installedMods.find(
      (mod) => (mod.mod_id ?? '').trim() === id,
    );
    const direct = (found?.workshop_id ?? '').trim();
    if (direct) {
      return direct;
    }
    const fileid =
      found?.workshop?.fileid != null ? String(found.workshop.fileid) : '';
    return fileid || '';
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

  private normalizeDraft(): void {
    if (!this.draft) {
      return;
    }
    const modIdSet = new Set(this.expandModIds(this.draft.modIds ?? []));
    this.draft.disabledModIds = this.mergeUnique(
      [],
      this.expandModIds(this.draft.disabledModIds ?? []).filter((id) =>
        modIdSet.has(id),
      ),
    );
    const nextWorkshopMap: Record<string, string> = {};
    for (const id of modIdSet) {
      const existing = this.draft.workshopByModId?.[id];
      if (existing) {
        nextWorkshopMap[id] = existing;
      }
    }
    this.draft.workshopByModId = nextWorkshopMap;
    const mapEntries = (this.draft.mapEntries ?? [])
      .map((entry) => ({
        modId: (entry?.modId ?? '').trim(),
        mapFolder: (entry?.mapFolder ?? '').trim(),
      }))
      .filter((entry) => entry.modId && entry.mapFolder);
    const deduped = new Map<string, string>();
    for (const entry of mapEntries) {
      if (modIdSet.has(entry.modId) && !deduped.has(entry.modId)) {
        deduped.set(entry.modId, entry.mapFolder);
      }
    }
    this.draft.mapEntries = Array.from(deduped.entries()).map(([modId, mapFolder]) => ({
      modId,
      mapFolder,
    }));
  }

  private buildMapFolderLookup(loadout: Loadout): Map<string, string> {
    const mapByModId = new Map<string, string>();
    for (const entry of loadout.mapEntries ?? []) {
      const modId = (entry?.modId ?? '').trim();
      const mapFolder = (entry?.mapFolder ?? '').trim();
      if (modId && mapFolder && !mapByModId.has(modId)) {
        mapByModId.set(modId, mapFolder);
      }
    }
    return mapByModId;
  }

  private collectMapFolders(
    loadout: Loadout,
    disabled?: Set<string>,
  ): string[] {
    const block = disabled ?? new Set<string>();
    const mapByModId = this.buildMapFolderLookup(loadout);
    const mapFolders: string[] = [];
    for (const modId of this.expandModIds(loadout.modIds ?? [])) {
      if (block.has(modId)) {
        continue;
      }
      const folder = mapByModId.get(modId);
      if (folder) {
        mapFolders.push(folder);
      }
    }
    return mapFolders;
  }

}
