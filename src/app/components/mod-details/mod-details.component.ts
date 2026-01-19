import { Component, DestroyRef, EventEmitter, Input, Output, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ModSummary } from '../../models/mod.models';
import { ModsActionsService } from '../../services/mods-actions.service';
import { ModsTagsService } from '../../services/mods-tags.service';
import { LoadoutsStateService } from '../../services/loadouts-state.service';
import type { Loadout, LoadoutResolvedMod } from '../../models/loadout.models';
import { convertFileSrc } from '@tauri-apps/api/core';
import { invoke } from '@tauri-apps/api/core';
import { CarouselModule } from 'primeng/carousel';
import { ImageModule } from 'primeng/image';
import { InputTextModule } from 'primeng/inputtext';
import { ChipModule } from 'primeng/chip';
import { TooltipModule } from 'primeng/tooltip';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { MessageService } from 'primeng/api';
import { TauriStoreService } from '../../services/tauri-store.service';
import { LoadoutsService } from '../../services/loadouts.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ScrollPanelModule } from 'primeng/scrollpanel';
import { LocalizationService } from '../../services/localization.service';
import { TranslocoModule } from '@jsverse/transloco';
import { TranslocoService } from '@jsverse/transloco';
import { tagKey } from '../../i18n/tag-key';
import { formatTagCount } from '../../i18n/number-format';
import { formatLocalizedDateTime } from '../../i18n/date-time';

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

interface ModPresetRow {
  loadout: Loadout;
  name: string;
  isActiveMods: boolean;
  relDir: string | null;
}

@Component({
  selector: 'app-mod-details',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CarouselModule,
    ImageModule,
    InputTextModule,
    ChipModule,
    TooltipModule,
    ToggleSwitchModule,
    ButtonModule,
    SelectModule,
    MultiSelectModule,
    TableModule,
    DialogModule,
    MessageModule,
    ScrollPanelModule,
    TranslocoModule,
  ],
  templateUrl: './mod-details.component.html',
  styles: [`
    .required-by-container.is-scrollable {
      max-height: 150px;
      overflow-y: auto;
      padding-right: 5px;
    }
    .read-only-toggle .p-toggleswitch {
      pointer-events: none;
    }
    .mod-tag-chip {
      cursor: pointer;
    }
    .mod-tag-chip.mod-tag-chip--active {
      background: var(--primary-color, #3b82f6);
      border-color: var(--primary-color, #3b82f6);
      color: var(--primary-color-text, #ffffff);
    }
  `]
})
export class ModDetailsComponent implements OnInit {
  @Input() mod!: ModSummary;
  @Input() readonly = false;
  @Input() allMods: ModSummary[] = [];

  @Output() workshopClicked = new EventEmitter<string>();
  @Output() creatorWorkshopClicked = new EventEmitter<string>();
  @Output() openFolderClicked = new EventEmitter<ModSummary>();
  @Output() modUpdated = new EventEmitter<ModSummary>();
  @Output() openDetails = new EventEmitter<ModSummary>();

  responsiveOptions = [
    {
      breakpoint: '1199px',
      numVisible: 1,
      numScroll: 1,
    },
    {
      breakpoint: '991px',
      numVisible: 1,
      numScroll: 1,
    },
    {
      breakpoint: '767px',
      numVisible: 1,
      numScroll: 1,
    },
  ];

  allTagOptions: { label: string; value: string }[] = [];
  tagCounts: Record<string, number> = {};
  selectedTags: string[] = [];
  private hasGlobalTagCounts = false;
  private currentLocale = 'en-US';

  loadouts: Loadout[] = [];
  loadoutsLoading = false;
  addToLoadoutBusy = false;
  addToLoadoutMessage = '';

  createNewLoadout = false;
  selectedLoadoutId: string | null = null;
  newLoadoutName = '';

  dependencyDialogVisible = false;
  dependencyOptions: Array<{ label: string; value: string }> = [];
  dependencySelection: string[] = [];
  pendingRemovalRow: ModPresetRow | null = null;

  addDialogVisible = false;
  addDialogDependencies: Array<{ label: string; value: string }> = [];
  addDialogSelection: string[] = [];
  addDialogOrder: string[] = [];
  addDialogIssues: string[] = [];
  addDialogAutoAdded: string[] = [];
  pendingAddMode: 'new' | 'existing' | null = null;
  pendingAddLoadoutId: string | null = null;
  pendingAddLoadoutName = '';

  constructor(
    private readonly modsActions: ModsActionsService,
    public readonly tagsService: ModsTagsService,
    private readonly loadoutsState: LoadoutsStateService,
    private readonly store: TauriStoreService,
    private readonly loadoutsApi: LoadoutsService,
    private readonly messageService: MessageService,
    private readonly destroyRef: DestroyRef,
    private readonly localization: LocalizationService,
    private readonly transloco: TranslocoService,
  ) {
    this.currentLocale = this.localization.locale || 'en-US';
    this.refreshTagOptions();

    this.tagsService.tagOptions$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.refreshTagOptions();
      });

    this.tagsService.tagCounts$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((counts) => {
        this.tagCounts = counts ?? {};
        this.refreshTagOptions();
      });

    this.tagsService.selectedTags$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tags) => {
        this.selectedTags = [...tags];
      });

    this.localization.locale$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((locale) => {
        this.currentLocale = locale;
      });

    this.transloco.langChanges$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.refreshTagOptions();
      });
  }

  async ngOnInit(): Promise<void> {
    await this.refreshLoadouts();
  }

  async refreshLoadouts(): Promise<void> {
    this.loadoutsLoading = true;
    try {
      this.loadouts = await this.loadoutsState.load();
      if (
        this.selectedLoadoutId &&
        !this.loadouts.some((l) => l.id === this.selectedLoadoutId)
      ) {
        this.selectedLoadoutId = null;
      }
    } finally {
      this.loadoutsLoading = false;
    }
  }

  get loadoutOptions(): Array<{ label: string; value: string }> {
    return this.loadouts
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({
        label: `${l.name} (${l.modIds.length} mods)`,
        value: l.id,
      }));
  }

  get currentModId(): string {
    return (this.mod?.mod_id ?? '').trim();
  }

  get selectedLoadout(): Loadout | null {
    const id = (this.selectedLoadoutId ?? '').trim();
    if (!id) {
      return null;
    }
    return this.loadouts.find((l) => l.id === id) ?? null;
  }

  get isInSelectedLoadout(): boolean {
    const modId = this.currentModId;
    if (!modId) {
      return false;
    }
    const loadout = this.selectedLoadout;
    return !!loadout?.modIds?.includes(modId);
  }

  get presetRows(): ModPresetRow[] {
    const modId = this.currentModId;
    if (!modId) {
      return [];
    }

    return this.loadouts
      .filter((l) => (l.modIds ?? []).includes(modId))
      .map((l) => {
        const relDir = parseActiveModsRelDir(l.name);
        return {
          loadout: l,
          name: l.name,
          isActiveMods: !!relDir,
          relDir,
        };
      });
  }

  get canAddToLoadout(): boolean {
    if (this.addToLoadoutBusy) {
      return false;
    }
    if (!this.currentModId) {
      return false;
    }
    if (this.createNewLoadout) {
      return !!this.newLoadoutName.trim();
    }
    if (!(this.selectedLoadoutId ?? '').trim()) {
      return false;
    }
    return !this.isInSelectedLoadout;
  }

  async addToLoadout(): Promise<void> {
    if (!this.canAddToLoadout) {
      return;
    }

    const modId = this.currentModId;
    this.addToLoadoutBusy = true;
    this.addToLoadoutMessage = '';

    try {
      const loadouts = await this.loadoutsState.load();

      if (this.createNewLoadout) {
        const name = this.newLoadoutName.trim();
        const lower = name.toLowerCase();
        if (
          loadouts.some((l) => (l.name ?? '').trim().toLowerCase() === lower)
        ) {
          this.addToLoadoutMessage = `Preset name already exists. Choose a different name.`;
          this.messageService.add({
            severity: 'error',
            summary: this.transloco.translate('toasts.modDetails.presetNameExists.summary'),
            detail: this.transloco.translate('toasts.modDetails.presetNameExists.detail', {
              name,
            }),
            life: 8000,
            closable: true,
          });
          return;
        }
        await this.openAddDialog(loadouts, modId, 'new', null, name);
        return;
      }

      const id = (this.selectedLoadoutId ?? '').trim();
      const idx = loadouts.findIndex((l) => l.id === id);
      if (idx < 0) {
        this.addToLoadoutMessage = 'Preset not found.';
        return;
      }

      const updated = JSON.parse(JSON.stringify(loadouts[idx])) as Loadout;
      if (updated.modIds.includes(modId)) {
        this.addToLoadoutMessage = `Already in preset: ${updated.name}`;
        return;
      }
      await this.openAddDialog(loadouts, modId, 'existing', updated.id, updated.name);
    } finally {
      this.addToLoadoutBusy = false;
    }
  }

  async confirmAddWithDependencies(): Promise<void> {
    if (!this.pendingAddMode || !this.currentModId) {
      this.addDialogVisible = false;
      return;
    }
    const modId = this.currentModId;
    const selected = Array.isArray(this.addDialogSelection)
      ? this.addDialogSelection
      : [];
    const extra = selected.filter((id) => !!id);
    const targetLoadout =
      this.pendingAddMode === 'existing'
        ? this.loadouts.find((l) => l.id === this.pendingAddLoadoutId) ?? null
        : null;
    const baseIds = targetLoadout?.modIds ?? [];
    const combined = this.mergeUnique([...baseIds, modId, ...extra]);
    const analysis = this.analyzeModsByIds(combined);
    const ordered = analysis.orderedModIds.length
      ? analysis.orderedModIds
      : combined;

    if (this.pendingAddMode === 'new') {
      const ts = nowIso();
      const created: Loadout = {
        id: newId(),
        name: this.pendingAddLoadoutName,
        description: null,
        createdAt: ts,
        updatedAt: ts,
        targetModes: ['singleplayer'],
        modIds: ordered,
        workshopIds: this.resolveWorkshopIds(ordered, this.allMods),
      };

      const loadouts = await this.loadoutsState.load();
      loadouts.unshift(created);
      await this.loadoutsState.save(loadouts);
      this.loadouts = loadouts;
      await this.updatePzModlistSettingsPreset(created.name, created.modIds);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('pz-presets-updated'));
      }
      this.createNewLoadout = false;
      this.selectedLoadoutId = created.id;
      this.addToLoadoutMessage = `Added to new preset: ${created.name}`;
    } else if (targetLoadout) {
      const loadouts = await this.loadoutsState.load();
      const idx = loadouts.findIndex((l) => l.id === targetLoadout.id);
      if (idx >= 0) {
        const updated = JSON.parse(JSON.stringify(loadouts[idx])) as Loadout;
        updated.modIds = ordered;
        updated.updatedAt = nowIso();
        updated.workshopIds = this.resolveWorkshopIds(updated.modIds, this.allMods);
        loadouts[idx] = updated;
        await this.loadoutsState.save(loadouts);
        this.loadouts = loadouts;
        await this.updatePzModlistSettingsPreset(updated.name, updated.modIds);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('pz-presets-updated'));
        }
        this.addToLoadoutMessage = `Added to preset: ${updated.name}`;
      }
    }

    this.addDialogVisible = false;
    this.pendingAddMode = null;
    this.pendingAddLoadoutId = null;
    this.pendingAddLoadoutName = '';
    this.addDialogSelection = [];
  }

  cancelAddWithDependencies(): void {
    this.addDialogVisible = false;
    this.pendingAddMode = null;
    this.pendingAddLoadoutId = null;
    this.pendingAddLoadoutName = '';
    this.addDialogSelection = [];
  }

  onAddDependencySelectionChange(): void {
    this.refreshAddDialogOrder();
  }

  async removeFromPreset(row: ModPresetRow): Promise<void> {
    const modId = this.currentModId;
    if (!modId) {
      return;
    }

    const dependencyCandidates = this.getDependencyCandidates(row, modId);
    if (dependencyCandidates.length) {
      this.pendingRemovalRow = row;
      this.dependencyOptions = dependencyCandidates;
      this.dependencySelection = [];
      this.dependencyDialogVisible = true;
      return;
    }

    await this.executePresetRemoval(row, [modId]);
  }

  async confirmDependencyRemoval(): Promise<void> {
    if (!this.pendingRemovalRow) {
      this.dependencyDialogVisible = false;
      return;
    }
    const modId = this.currentModId;
    if (!modId) {
      this.dependencyDialogVisible = false;
      this.pendingRemovalRow = null;
      return;
    }
    const selected = Array.isArray(this.dependencySelection)
      ? this.dependencySelection
      : [];
    const unique = new Set<string>([modId, ...selected]);
    const modIds = Array.from(unique).filter((id) => !!id);
    const row = this.pendingRemovalRow;
    this.dependencyDialogVisible = false;
    this.pendingRemovalRow = null;
    this.dependencySelection = [];
    await this.executePresetRemoval(row, modIds);
  }

  cancelDependencyRemoval(): void {
    this.dependencyDialogVisible = false;
    this.pendingRemovalRow = null;
    this.dependencySelection = [];
  }

  private async executePresetRemoval(
    row: ModPresetRow,
    modIdsToRemove: string[],
  ): Promise<void> {
    const userDir =
      ((await this.store.getItem<string>('pz_user_dir')) ?? '').trim() ||
      (await this.loadoutsApi.getDefaultZomboidUserDir()) ||
      '';
    if (!userDir) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.modDetails.removeFailed.summary'),
        detail: this.transloco.translate('toasts.modDetails.removeFailed.missingUserDetail'),
        life: 8000,
        closable: true,
      });
      return;
    }

    try {
      if (row.isActiveMods) {
        const relDir = row.relDir ?? '';
        let updatedAny = false;
        for (const id of modIdsToRemove) {
          const result = await invoke<{ updated: boolean; path: string }>(
            'remove_mod_from_active_mods',
            { userDir, relDir, modId: id },
          );
          updatedAny = updatedAny || result.updated;
        }
        if (!updatedAny) {
          this.messageService.add({
            severity: 'error',
            summary: this.transloco.translate('toasts.modDetails.removeFailed.summary'),
            detail: this.transloco.translate('toasts.modDetails.removeFailed.missingModDetail'),
            life: 8000,
            closable: true,
          });
          return;
        }
      } else {
        const nextModIds = (row.loadout.modIds ?? []).filter(
          (id) => !modIdsToRemove.includes(id),
        );
        await this.loadoutsApi.upsertModlistSettingsPreset(
          userDir,
          row.loadout.name,
          nextModIds,
        );
      }

      const idx = this.loadouts.findIndex((l) => l.id === row.loadout.id);
      if (idx >= 0) {
        const updated = JSON.parse(JSON.stringify(this.loadouts[idx])) as Loadout;
        updated.modIds = (updated.modIds ?? []).filter(
          (id) => !modIdsToRemove.includes(id),
        );
        updated.updatedAt = nowIso();
        updated.workshopIds = this.resolveWorkshopIds(updated.modIds, this.allMods);
        this.loadouts[idx] = updated;
        await this.loadoutsState.save(this.loadouts);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('pz-presets-updated'));
        }
      }

      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.modDetails.removed.summary'),
        detail:
          modIdsToRemove.length > 1
            ? this.transloco.translate('toasts.modDetails.removed.detailMultiple')
            : this.transloco.translate('toasts.modDetails.removed.detailSingle'),
        life: 5000,
        closable: true,
      });
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.modDetails.removeFailed.failedDetail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.modDetails.removeFailed.summary'),
        detail,
        life: 10000,
        closable: true,
      });
    }
  }

  private resolveWorkshopIds(modIds: string[], mods: ModSummary[]): string[] {
    const ids = new Set<string>();
    const byModId = new Map<string, ModSummary>();
    for (const mod of mods ?? []) {
      const id = (mod.mod_id ?? '').trim();
      if (id) {
        byModId.set(id, mod);
      }
    }

    for (const modId of modIds) {
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

  private async openAddDialog(
    loadouts: Loadout[],
    modId: string,
    mode: 'new' | 'existing',
    loadoutId: string | null,
    loadoutName: string,
  ): Promise<void> {
    const baseLoadout =
      mode === 'existing'
        ? loadouts.find((l) => l.id === loadoutId) ?? null
        : null;
    const baseIds = baseLoadout?.modIds ?? [];
    const dependencyOptions = this.getDependencyCandidatesForAdd(modId, baseIds);

    this.pendingAddMode = mode;
    this.pendingAddLoadoutId = loadoutId;
    this.pendingAddLoadoutName = loadoutName;
    this.addDialogDependencies = dependencyOptions;
    this.addDialogSelection = [];
    this.refreshAddDialogOrder();
    this.addDialogVisible = true;
  }

  private refreshAddDialogOrder(): void {
    const modId = this.currentModId;
    if (!modId) {
      this.addDialogOrder = [];
      this.addDialogIssues = [];
      this.addDialogAutoAdded = [];
      return;
    }
    const baseLoadout =
      this.pendingAddMode === 'existing'
        ? this.loadouts.find((l) => l.id === this.pendingAddLoadoutId) ?? null
        : null;
    const baseIds = baseLoadout?.modIds ?? [];
    const selected = Array.isArray(this.addDialogSelection)
      ? this.addDialogSelection
      : [];
    const combined = this.mergeUnique([...baseIds, modId, ...selected]);
    const closure = this.getDependencyClosure(combined);
    const autoAdd = Array.from(closure).filter(
      (id) => !combined.some((c) => c.toLowerCase() === id.toLowerCase()),
    );
    if (autoAdd.length) {
      const nextSelection = this.mergeUnique([...selected, ...autoAdd]);
      if (!this.arraysEqual(selected, nextSelection)) {
        this.addDialogSelection = nextSelection;
      }
    }
    this.addDialogAutoAdded = autoAdd;
    const merged = this.mergeUnique([...baseIds, modId, ...this.addDialogSelection]);
    const analysis = this.analyzeModsByIds(merged);
    this.addDialogOrder = analysis.orderedModIds.length
      ? analysis.orderedModIds
      : merged;

    const issues: string[] = [];
    if (analysis.missingModIds.length) {
      issues.push(`Missing dependencies: ${analysis.missingModIds.length}.`);
    }
    if (analysis.incompatiblePairs.length) {
      issues.push(`Incompatibilities: ${analysis.incompatiblePairs.length}.`);
    }
    if (analysis.cycles.length) {
      issues.push(`Cycles detected: ${analysis.cycles.length}.`);
    }
    this.addDialogIssues = issues;
  }

  private analyzeModsByIds(modIds: string[]): {
    orderedModIds: string[];
    missingModIds: string[];
    incompatiblePairs: Array<{ a: string; b: string }>;
    cycles: string[][];
  } {
    const unique = this.mergeUnique(modIds);
    const selected = new Set(unique);
    const byModId = new Map<string, ModSummary>();
    for (const mod of this.allMods ?? []) {
      const id = (mod.mod_id ?? '').trim();
      if (id) {
        byModId.set(id, mod);
      }
    }

    const mods: LoadoutResolvedMod[] = unique.map((id) => {
      const found = byModId.get(id);
      return {
        modId: id,
        requires: found?.requires ?? null,
        dependencies: found?.dependencies ?? null,
        loadAfter: found?.load_after ?? null,
        loadBefore: found?.load_before ?? null,
        incompatible: found?.incompatible ?? null,
      };
    });

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

    for (const id of unique) {
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
    unique.forEach((id, index) => {
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

    const leftover = unique.filter((id) => !ordered.includes(id));
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

    const cycles = leftover.length ? [leftover] : [];

    return {
      orderedModIds: ordered,
      missingModIds: Array.from(missingModIds).sort((a, b) => a.localeCompare(b)),
      incompatiblePairs,
      cycles,
    };
  }

  private getDependencyClosure(modIds: string[]): Set<string> {
    const result = new Set<string>();
    const queue = [...modIds];
    const seen = new Set<string>(modIds.map((id) => id.toLowerCase()));
    const byModId = new Map<string, ModSummary>();
    for (const mod of this.allMods ?? []) {
      const id = (mod.mod_id ?? '').trim();
      if (id) {
        byModId.set(id.toLowerCase(), mod);
      }
    }

    while (queue.length) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      const mod = byModId.get(current.toLowerCase());
      if (!mod) {
        continue;
      }
      const deps = this.normalizeModRefs([
        ...(mod.dependencies ?? []),
        ...(mod.requires ?? []),
      ]);
      for (const dep of deps) {
        const key = dep.toLowerCase();
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.add(dep);
        queue.push(dep);
      }
    }

    return result;
  }

  private getDependencyCandidatesForAdd(
    modId: string,
    existingIds: string[],
  ): Array<{ label: string; value: string }> {
    const deps = this.normalizeModRefs([
      ...(this.mod.dependencies ?? []),
      ...(this.mod.requires ?? []),
    ]);
    if (!deps.length) {
      return [];
    }

    const existing = new Set(existingIds.map((id) => id.trim()));
    const byModId = new Map<string, ModSummary>();
    for (const mod of this.allMods ?? []) {
      const id = (mod.mod_id ?? '').trim();
      if (id) {
        byModId.set(id, mod);
      }
    }

    const out: Array<{ label: string; value: string }> = [];
    for (const dep of deps) {
      const cleaned = dep.trim();
      if (!cleaned || cleaned === modId || existing.has(cleaned)) {
        continue;
      }
      const match = byModId.get(cleaned);
      const label = match ? `${match.name} (${cleaned})` : cleaned;
      out.push({ label, value: cleaned });
    }

    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  private mergeUnique(values: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of values ?? []) {
      const cleaned = (raw ?? '').trim();
      if (!cleaned) {
        continue;
      }
      const key = cleaned.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(cleaned);
    }
    return out;
  }

  private arraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((value, index) => value === b[index]);
  }

  private async updatePzModlistSettingsPreset(
    presetName: string,
    modIds: string[],
  ): Promise<void> {
    const userDir =
      ((await this.store.getItem<string>('pz_user_dir')) ?? '').trim() ||
      (await this.loadoutsApi.getDefaultZomboidUserDir()) ||
      '';
    if (!userDir) {
      return;
    }

    try {
      const result = await this.loadoutsApi.upsertModlistSettingsPreset(
        userDir,
        presetName,
        modIds,
      );
      if (result && result.updated === false) {
        this.messageService.add({
          severity: 'warn',
          summary: this.transloco.translate('toasts.modDetails.presetUpdated.summary'),
          detail:
            result.reason ||
            this.transloco.translate('toasts.modDetails.presetUpdated.detailFallback'),
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
            : this.transloco.translate('toasts.modDetails.presetUpdated.detailFailed');
      this.messageService.add({
        severity: 'warn',
        summary: this.transloco.translate('toasts.modDetails.presetUpdated.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    }
  }

  getPosterImages(mod: ModSummary): string[] {
    const images: string[] = [];

    if (mod.poster_image_paths && mod.poster_image_paths.length > 0) {
      for (const path of mod.poster_image_paths) {
        if (path) {
          images.push(convertFileSrc(path));
        }
      }
    } else if (mod.preview_image_path) {
      images.push(convertFileSrc(mod.preview_image_path));
    } else if (mod.icon) {
      images.push(convertFileSrc(mod.icon));
    }

    return images;
  }

  getRelativeFolderName(mod: ModSummary): string | null {
    const base = this.modsActions.folderPath;
    const modInfoPath = mod.mod_info_path;

    if (!base || !modInfoPath) {
      return null;
    }

    const baseNorm = base.replace(/\\/g, '/');
    const modNorm = modInfoPath.replace(/\\/g, '/');

    if (!modNorm.startsWith(baseNorm)) {
      return null;
    }

    const relative = modNorm.slice(baseNorm.length).replace(/^\/+/, '');
    const parts = relative.split('/').filter((p) => p.length > 0);

    if (!parts.length) {
      return null;
    }

    return parts[0];
  }

  formatFileSize(
    bytes: number | string | null | undefined,
  ): string {
    if (bytes == null) {
      return '';
    }

    const numeric = typeof bytes === 'number' ? bytes : Number(bytes);
    if (!Number.isFinite(numeric)) {
      return '';
    }

    const value = numeric;
    const kb = 1000;
    const mb = kb * 1000;
    const gb = mb * 1000;

    if (Math.abs(value) >= gb) {
      return `${(value / gb).toFixed(3)} GB`;
    }
    if (Math.abs(value) >= mb) {
      return `${(value / mb).toFixed(3)} MB`;
    }
    if (Math.abs(value) >= kb) {
      return `${(value / kb).toFixed(3)} KB`;
    }
    return `${value} B`;
  }

  formatDateTime(value: string | number | null | undefined): string {
    if (value == null || value === '') {
      return '';
    }

    let timestampMs: number | null = null;

    if (typeof value === 'number') {
      timestampMs = value < 1e12 ? value * 1000 : value;
    } else {
      const numeric = Number(value);
      if (!Number.isNaN(numeric)) {
        timestampMs = numeric < 1e12 ? numeric * 1000 : numeric;
      } else {
        const parsed = new Date(value).getTime();
        timestampMs = Number.isNaN(parsed) ? null : parsed;
      }
    }

    if (timestampMs == null) {
      return '';
    }

    const date = new Date(timestampMs);
    if (isNaN(date.getTime())) {
      return '';
    }

    return formatLocalizedDateTime(date, this.currentLocale);
  }

  getMappedTagOptions(mod: ModSummary): { label: string; value: string }[] {
    const workshopTags = mod.workshop?.map_tags ?? [];
    if (!workshopTags.length) {
      return [];
    }

    const allowed = new Set(
      workshopTags
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    );

    return this.allTagOptions.filter((opt) => allowed.has(opt.value));
  }

  isNumericId(id: string | undefined | null): boolean {
    if (!id) {
      return false;
    }
    return /^[0-9]+$/.test(id);
  }

  openWorkshop(id: string | undefined | null): void {
    if (!this.isNumericId(id)) {
      return;
    }
    this.workshopClicked.emit(id as string);
  }

  openCreatorWorkshop(url: string | undefined | null): void {
    if (!url) {
      return;
    }
    this.creatorWorkshopClicked.emit(url);
  }

  openFolder(mod: ModSummary): void {
    this.openFolderClicked.emit(mod);
  }

  private refreshTagOptions(): void {
    this.hasGlobalTagCounts = Object.values(this.tagCounts).some((count) => count > 0);
    this.allTagOptions = this.tagsService.tagOptions.map((t) => ({
      label: `${this.getTagLabel(t)} (${this.getTagCountLabel(t)})`,
      value: t,
    }));
  }

  private getTagLabel(tag: string): string {
    const key = `tags.${tagKey(tag)}`;
    const translated = this.transloco.translate(key);
    return translated === key ? tag : translated;
  }

  private getTagCountLabel(tag: string): string {
    const locale = this.transloco.getActiveLang() || 'en-US';
    return formatTagCount(this.getTagCountValue(tag), locale);
  }

  private getTagCountValue(tag: string): number {
    if (this.hasGlobalTagCounts) {
      return this.tagCounts[tag] ?? 0;
    }
    const modTags = this.getCurrentModTags();
    return modTags.includes(tag) ? 1 : 0;
  }

  private getCurrentModTags(): string[] {
    const modId = (this.mod?.id ?? '').trim();
    const storedTags = modId ? this.tagsService.getTagsForMod(modId) : [];
    if (storedTags.length) {
      return storedTags;
    }
    return (this.mod?.workshop?.map_tags ?? []).filter((tag) => tag && tag.trim().length > 0);
  }

  isTagSelected(tag: string): boolean {
    return this.selectedTags.includes(tag);
  }

  toggleTagFilter(tag: string): void {
    const next = new Set(this.tagsService.selectedTags);
    if (next.has(tag)) {
      next.delete(tag);
    } else {
      next.add(tag);
    }
    this.tagsService.setSelectedTags([...next]);
  }

  get hasModLinkChips(): boolean {
    return (
      this.hasRequiredModValues ||
      this.hasLoadAfterValues ||
      this.hasLoadBeforeValues ||
      this.hasIncompatibleValues ||
      this.hasIncompatibleWithMods ||
      this.hasRequiredByValues
    );
  }

  get hasRequiredModValues(): boolean {
    return (
      this.normalizeModRefs([
        ...(this.mod.dependencies ?? []),
        ...(this.mod.requires ?? []),
      ]).length > 0
    );
  }

  get hasLoadAfterValues(): boolean {
    return this.normalizeModRefs(this.mod.load_after ?? []).length > 0;
  }

  get hasLoadBeforeValues(): boolean {
    return this.normalizeModRefs(this.mod.load_before ?? []).length > 0;
  }

  get hasIncompatibleValues(): boolean {
    return this.normalizeModRefs(this.mod.incompatible ?? []).length > 0;
  }

  get hasIncompatibleWithMods(): boolean {
    return this.incompatibleWithMods.length > 0;
  }

  get requiredModChips(): Array<{ label: string; mod: ModSummary | null; missing: boolean }> {
    const values = [
      ...(this.mod.dependencies ?? []),
      ...(this.mod.requires ?? []),
    ];
    return this.buildModLinkChips(values);
  }

  get loadAfterChips(): Array<{ label: string; mod: ModSummary | null; missing: boolean }> {
    return this.buildModLinkChips(this.mod.load_after ?? []);
  }

  get loadBeforeChips(): Array<{ label: string; mod: ModSummary | null; missing: boolean }> {
    return this.buildModLinkChips(this.mod.load_before ?? []);
  }

  get incompatibleChips(): Array<{ label: string; mod: ModSummary | null; missing: boolean }> {
    return this.buildModLinkChips(this.mod.incompatible ?? []);
  }

  get requiredByChips(): Array<{ label: string; mod: ModSummary | null; missing: boolean }> {
    if (!this.mod.required_by) {
        return [];
    }

    const byModId = new Map<string, ModSummary>();
    for (const mod of this.allMods ?? []) {
      const modId = (mod.mod_id ?? '').trim();
      if (modId) {
        byModId.set(modId.toLowerCase(), mod);
      }
    }

    return this.mod.required_by.map(info => {
        // Defensive check for old string[] data format
        if (!info || typeof info === 'string') {
            const label = String(info || '');
            const mod = byModId.get(label.toLowerCase()) ?? null;
            return { label: mod ? mod.name : label, mod, missing: !mod };
        }

        // Handle new RequiredByInfo[] format
        const modId = (info.modId ?? '').trim();
        if (!modId) {
            return { label: info.name, mod: null, missing: true };
        }

        const mod = byModId.get(modId.toLowerCase()) ?? null;
        return {
            label: info.name,
            mod: mod,
            missing: !mod
        };
    });
  }

  get hasRequiredByValues(): boolean {
    return (this.mod.required_by ?? []).length > 0;
  }

  get incompatibleWithMods(): ModSummary[] {
    const currentModId = (this.mod.mod_id ?? '').trim().toLowerCase();
    const currentWorkshopId = (this.mod.workshop_id ?? '').trim().toLowerCase();
    const currentRecordId = (this.mod.id ?? '').trim().toLowerCase();

    if (!currentModId && !currentWorkshopId && !currentRecordId) {
      return [];
    }

    const results: ModSummary[] = [];
    const seen = new Set<string>();

    for (const candidate of this.allMods ?? []) {
      if (!candidate || candidate.id === this.mod.id) {
        continue;
      }

      const candidateIncompatibleValues = this.normalizeModRefs(
        candidate.incompatible ?? [],
      );

      const linksToThis = candidateIncompatibleValues.some((raw) => {
        const needle = raw.toLowerCase();
        if (currentModId && needle === currentModId) {
          return true;
        }
        if (currentWorkshopId && needle === currentWorkshopId) {
          return true;
        }
        if (currentRecordId && needle === currentRecordId) {
          return true;
        }
        return false;
      });

      if (!linksToThis) {
        continue;
      }

      if (seen.has(candidate.id)) {
        continue;
      }
      seen.add(candidate.id);
      results.push(candidate);
    }

    results.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return results;
  }

  openLinkedModDetails(mod: ModSummary): void {
    this.openDetails.emit(mod);
  }

  private buildModLinkChips(
    rawValues: Array<string | null | undefined>,
  ): Array<{ label: string; mod: ModSummary | null; missing: boolean }> {
    const wanted = this.normalizeModRefs(rawValues);
    if (wanted.length === 0) {
      return [];
    }

    const byModId = new Map<string, ModSummary>();
    const byWorkshopId = new Map<string, ModSummary>();
    const byRecordId = new Map<string, ModSummary>();
    for (const mod of this.allMods ?? []) {
      const modId = (mod.mod_id ?? '').trim();
      if (modId) {
        byModId.set(modId.toLowerCase(), mod);
      }

      const workshopId = (mod.workshop_id ?? '').trim();
      if (workshopId) {
        byWorkshopId.set(workshopId.toLowerCase(), mod);
      }

      const recordId = (mod.id ?? '').trim();
      if (recordId) {
        byRecordId.set(recordId.toLowerCase(), mod);
      }
    }

    return wanted.map((value) => {
      const needle = value.toLowerCase();
      const match =
        byModId.get(needle) ??
        byWorkshopId.get(needle) ??
        byRecordId.get(needle) ??
        null;
      if (match) {
        return { label: match.name, mod: match, missing: false };
      }
      return { label: value, mod: null, missing: true };
    });
  }

  private normalizeModRefs(
    rawValues: Array<string | null | undefined>,
  ): string[] {
    const cleaned: string[] = [];

    for (const raw of rawValues) {
      if (!raw) {
        continue;
      }

      const cleanedRaw = String(raw).replace(/^\\+/, '');
      const parts = cleanedRaw
        .split(/[;,\s]+/g)
        .map((p) => p.trim().replace(/^['"]+|['"]+$/g, '').trim())
        .filter((p) => p.length > 0);

      cleaned.push(...parts);
    }

    // De-dupe while preserving order.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const value of cleaned) {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(value);
    }

    return unique;
  }

  private getDependencyCandidates(
    row: ModPresetRow,
    modId: string,
  ): Array<{ label: string; value: string }> {
    const deps = this.normalizeModRefs([
      ...(this.mod.dependencies ?? []),
      ...(this.mod.requires ?? []),
    ]);
    if (!deps.length) {
      return [];
    }

    const loadoutIds = new Set((row.loadout.modIds ?? []).map((id) => id.trim()));
    const byModId = new Map<string, ModSummary>();
    for (const mod of this.allMods ?? []) {
      const id = (mod.mod_id ?? '').trim();
      if (id) {
        byModId.set(id, mod);
      }
    }

    const out: Array<{ label: string; value: string }> = [];
    for (const dep of deps) {
      const cleaned = dep.trim();
      if (!cleaned || cleaned === modId) {
        continue;
      }
      if (!loadoutIds.has(cleaned)) {
        continue;
      }
      const match = byModId.get(cleaned);
      const label = match ? `${match.name} (${cleaned})` : cleaned;
      out.push({ label, value: cleaned });
    }

    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }
}
