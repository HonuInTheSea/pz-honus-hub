import { Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  Output,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { PickListModule } from 'primeng/picklist';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ModTagFilterComponent } from '../mod-tag-filter/mod-tag-filter.component';
import { ModsStateService } from '../../services/mods-state.service';
import { ModsTagsService, TagMatchMode } from '../../services/mods-tags.service';
import { WorkshopMetadataService } from '../../services/workshop-metadata.service';
import { SteamApiKeyService } from '../../services/steam-api-key.service';

interface ModPickItem {
  id: string;
  modId: string;
  workshopId: string;
  name: string;
  label: string;
}

@Component({
  selector: 'app-mods-picker-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DialogModule,
    PickListModule,
    InputTextModule,
    ButtonModule,
    ModTagFilterComponent,
  ],
  templateUrl: './mods-picker-dialog.component.html',
})
export class ModsPickerDialogComponent {
  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();
  @Input() modsValue = '';
  @Input() workshopValue = '';
  @Output() save = new EventEmitter<{ modsValue: string; workshopValue: string }>();

  @ViewChild('modsPicklist', { read: ElementRef })
  modsPicklist?: ElementRef<HTMLElement>;

  modsSource: ModPickItem[] = [];
  modsTarget: ModPickItem[] = [];
  modsSourceFilterValue = '';
  modsTagsWidth = 'auto';

  private modsAvailable: ModPickItem[] = [];
  private modsAvailableById = new Map<string, ModPickItem>();
  private modsIdAliases = new Map<string, string>();
  private modRequiresById = new Map<string, string[]>();
  private modLoadAfterById = new Map<string, string[]>();
  private modLoadBeforeById = new Map<string, string[]>();
  private modsAvailableLoaded = false;
  private modsDialogExtraModTokens: string[] = [];
  private modsDialogExtraWorkshopIds: string[] = [];
  private modsDialogUseBackslash = false;
  private modsDialogSelectedTags: string[] = [];
  private modsDialogTagMatchMode: TagMatchMode = 'any';
  private lastInitKey = '';

  missingModsDialogVisible = false;
  missingModsLoading = false;
  missingMods: Array<{
    id: string;
    workshopId?: string;
    title?: string;
    url?: string;
    error?: string;
  }> = [];
  missingModsHasApiKey = false;

  removeDependentsDialogVisible = false;
  pendingRemoveIds: string[] = [];
  pendingDependentMods: ModPickItem[] = [];

  constructor(
    private readonly modsState: ModsStateService,
    private readonly tagsService: ModsTagsService,
    private readonly workshopMetadata: WorkshopMetadataService,
    private readonly steamApiKeyService: SteamApiKeyService,
    private readonly destroyRef: DestroyRef,
  ) {
    this.tagsService.selectedTags$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tags) => {
        this.modsDialogSelectedTags = [...tags];
        this.applyModsSourceFilter();
        this.updateModsTagCounts();
      });

    this.tagsService.tagMatchMode$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((mode) => {
        this.modsDialogTagMatchMode = mode;
        this.applyModsSourceFilter();
        this.updateModsTagCounts();
      });
  }

  ngOnChanges(): void {
    if (!this.visible) {
      return;
    }
    const nextKey = `${this.modsValue}||${this.workshopValue}`;
    if (nextKey === this.lastInitKey) {
      return;
    }
    this.lastInitKey = nextKey;
    void this.initializeFromValues();
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    if (this.visible) {
      this.updateModsTagsWidth();
    }
  }

  onHide(): void {
    this.visible = false;
    this.visibleChange.emit(false);
    this.resetState();
  }

  cancel(): void {
    this.onHide();
  }

  saveSelection(): void {
    const selectedMods = this.modsTarget ?? [];
    const formattedSelected = selectedMods.map((item) => `\\${item.modId}`);
    const modTokens = [...formattedSelected, ...this.modsDialogExtraModTokens].filter(
      (token) => !!token,
    );
    const workshopIds = selectedMods.map((item) => item.workshopId).filter((id) => !!id);
    for (const id of this.modsDialogExtraWorkshopIds) {
      if (!workshopIds.includes(id)) {
        workshopIds.push(id);
      }
    }
    const modsValue = modTokens.join(';');
    const workshopValue = workshopIds.join(';');
    this.save.emit({
      modsValue,
      workshopValue,
    });
    this.onHide();
  }

  onModsPickListChange(): void {
    this.ensureRequiredModsSelected();
    this.applyModsSourceFilter();
    this.updateModsTagCounts();
    this.updateModsTagsWidth();
  }

  onModsMoveToSource(event: { items?: ModPickItem[] }): void {
    const moved = Array.isArray(event?.items) ? event.items : [];
    if (!moved.length) {
      this.applyModsSourceFilter();
      this.updateModsTagCounts();
      this.updateModsTagsWidth();
      return;
    }
    const dependents = this.findDependentMods(moved);
    if (dependents.length) {
      this.pendingRemoveIds = moved.map((item) => item.modId);
      this.pendingDependentMods = dependents;
      this.removeDependentsDialogVisible = true;
      return;
    }
    this.applyModsSourceFilter();
    this.updateModsTagCounts();
    this.updateModsTagsWidth();
  }

  confirmMoveDependents(): void {
    const dependentIds = new Set(
      this.pendingDependentMods.map((item) => item.modId.toLowerCase()),
    );
    if (dependentIds.size) {
      const kept: ModPickItem[] = [];
      const moved: ModPickItem[] = [];
      for (const item of this.modsTarget ?? []) {
        if (dependentIds.has(item.modId.toLowerCase())) {
          moved.push(item);
        } else {
          kept.push(item);
        }
      }
      this.modsTarget = kept;
      this.modsSource = [...(this.modsSource ?? []), ...moved];
    }
    this.clearRemoveDependentsDialog();
    this.applyModsSourceFilter();
    this.updateModsTagCounts();
    this.updateModsTagsWidth();
  }

  cancelMoveDependents(): void {
    if (this.pendingRemoveIds.length) {
      const pendingSet = new Set(
        this.pendingRemoveIds.map((id) => id.toLowerCase()),
      );
      const kept: ModPickItem[] = [];
      const restored: ModPickItem[] = [];
      for (const item of this.modsSource ?? []) {
        if (pendingSet.has(item.modId.toLowerCase())) {
          restored.push(item);
        } else {
          kept.push(item);
        }
      }
      this.modsSource = kept;
      this.modsTarget = [...(this.modsTarget ?? []), ...restored];
    }
    this.clearRemoveDependentsDialog();
    this.applyModsSourceFilter();
    this.updateModsTagCounts();
    this.updateModsTagsWidth();
  }

  onModsSourceFilterValueChange(
    value: string,
    options?: { filter?: (value?: string) => void },
  ): void {
    this.modsSourceFilterValue = (value ?? '').trim();
    options?.filter?.(this.modsSourceFilterValue);
    this.updateModsTagCounts();
  }

  private async initializeFromValues(): Promise<void> {
    await this.ensureModsAvailable();
    const parsedMods = this.parseModsValue(this.modsValue);
    const modIdOrder = parsedMods.map((entry) => entry.modId).filter((id) => !!id);
    this.modsDialogUseBackslash = parsedMods.some((entry) => entry.raw.startsWith('\\'));
    const availableById = new Map(
      this.modsAvailable.map((item) => [item.modId.toLowerCase(), item]),
    );
    const selected: ModPickItem[] = [];
    const seen = new Set<string>();
    for (const modId of modIdOrder) {
      const key = modId.toLowerCase();
      const match = availableById.get(key);
      if (match && !seen.has(key)) {
        selected.push(match);
        seen.add(key);
      }
    }
    this.modsDialogExtraModTokens = parsedMods
      .filter((entry) => !availableById.has(entry.modId.toLowerCase()))
      .map((entry) => entry.raw)
      .filter((raw) => !!raw);
    const missingIds = parsedMods
      .filter((entry) => !availableById.has(entry.modId.toLowerCase()))
      .map((entry) => entry.modId)
      .filter((id) => !!id);
    const selectedIds = new Set(selected.map((item) => item.modId.toLowerCase()));
    this.modsTarget = selected;
    this.modsSource = this.modsAvailable.filter(
      (item) => !selectedIds.has(item.modId.toLowerCase()),
    );
    this.modsDialogExtraWorkshopIds = this.parseWorkshopIds(this.workshopValue).filter(
      (id) => !selected.some((item) => item.workshopId === id),
    );
    this.applyModsSourceFilter();
    this.updateModsTagCounts();
    this.updateModsTagsWidth();
    if (missingIds.length) {
      void this.openMissingModsDialog(missingIds);
    }
  }

  private resetState(): void {
    this.modsSource = [];
    this.modsTarget = [];
    this.modsDialogExtraModTokens = [];
    this.modsDialogExtraWorkshopIds = [];
    this.modsDialogUseBackslash = false;
    this.modsSourceFilterValue = '';
    this.modsTagsWidth = 'auto';
    this.lastInitKey = '';
  }

  private clearRemoveDependentsDialog(): void {
    this.removeDependentsDialogVisible = false;
    this.pendingRemoveIds = [];
    this.pendingDependentMods = [];
  }

  private updateModsTagsWidth(): void {
    const host = this.modsPicklist?.nativeElement;
    if (!host) {
      this.modsTagsWidth = 'auto';
      return;
    }
    requestAnimationFrame(() => {
      const source = host.querySelector(
        '.p-picklist-source-list-container',
      ) as HTMLElement | null;
      this.modsTagsWidth = source ? `${source.clientWidth}px` : 'auto';
    });
  }

  private async ensureModsAvailable(): Promise<void> {
    if (this.modsAvailableLoaded) {
      return;
    }
    const persisted = await this.modsState.loadPersistedMods();
    const mods = persisted?.local ?? [];
    this.modsAvailableById.clear();
    this.modsIdAliases.clear();
    this.modRequiresById.clear();
    this.modLoadAfterById.clear();
    this.modLoadBeforeById.clear();
    this.modsAvailable = mods
      .map((mod) => {
        const modId = (mod.id ?? '').trim();
        const workshopId = (mod.workshop_id ?? '').trim();
        if (!modId || !workshopId) {
          return null;
        }
        const name = (mod.name ?? '').trim();
        const rawRequires = [...(mod.requires ?? []), ...(mod.dependencies ?? [])]
          .map((value) => this.normalizeModId(String(value ?? '')))
          .filter((value) => !!value);
        const rawLoadAfter = (mod.load_after ?? [])
          .map((value) => this.normalizeModId(String(value ?? '')))
          .filter((value) => !!value);
        const rawLoadBefore = (mod.load_before ?? [])
          .map((value) => this.normalizeModId(String(value ?? '')))
          .filter((value) => !!value);
        this.modRequiresById.set(modId.toLowerCase(), rawRequires);
        this.modLoadAfterById.set(modId.toLowerCase(), rawLoadAfter);
        this.modLoadBeforeById.set(modId.toLowerCase(), rawLoadBefore);
        const legacyId = (mod.mod_id ?? '').trim();
        this.modsIdAliases.set(modId.toLowerCase(), modId);
        if (legacyId && legacyId.toLowerCase() !== modId.toLowerCase()) {
          this.modsIdAliases.set(legacyId.toLowerCase(), modId);
        }
        return {
          id: mod.id || modId,
          modId,
          workshopId,
          name,
          label: name || modId,
        } as ModPickItem;
      })
      .filter((item): item is ModPickItem => !!item)
      .sort((a, b) => a.label.localeCompare(b.label));
    for (const item of this.modsAvailable) {
      this.modsAvailableById.set(item.modId.toLowerCase(), item);
    }
    this.modsAvailableLoaded = true;
  }

  private ensureRequiredModsSelected(): void {
    if (!this.modsTarget || this.modsTarget.length === 0) {
      return;
    }
    const selected = [...this.modsTarget];
    const selectedIds = new Set(selected.map((item) => item.modId.toLowerCase()));
    const missing = new Set<string>();
    let added = true;
    while (added) {
      added = false;
      for (const item of selected) {
        const key = item.modId.toLowerCase();
        const requires = this.modRequiresById.get(key) ?? [];
        const loadAfter = this.modLoadAfterById.get(key) ?? [];
        const loadBefore = this.modLoadBeforeById.get(key) ?? [];
        const needed = [...requires, ...loadAfter, ...loadBefore];
        for (const raw of needed) {
          const normalized = this.normalizeModId(raw);
          const resolved = this.modsIdAliases.get(normalized.toLowerCase());
          if (!resolved) {
            missing.add(normalized);
            continue;
          }
          const resolvedKey = resolved.toLowerCase();
          if (selectedIds.has(resolvedKey)) {
            continue;
          }
          const match = this.modsAvailableById.get(resolvedKey);
          if (match) {
            selected.push(match);
            selectedIds.add(resolvedKey);
            added = true;
          } else {
            missing.add(normalized);
          }
        }
      }
    }
    this.modsTarget = this.orderModsByLoadRules(selected);
    if (missing.size) {
      void this.openMissingModsDialog(Array.from(missing));
    }
  }

  private findDependentMods(moved: ModPickItem[]): ModPickItem[] {
    const movedIds = new Set(moved.map((item) => item.modId.toLowerCase()));
    if (!movedIds.size) {
      return [];
    }
    const dependents: ModPickItem[] = [];
    const seen = new Set<string>();
    for (const item of this.modsTarget ?? []) {
      const key = item.modId.toLowerCase();
      const requires = this.modRequiresById.get(key) ?? [];
      const loadAfter = this.modLoadAfterById.get(key) ?? [];
      const loadBefore = this.modLoadBeforeById.get(key) ?? [];
      const needed = [...requires, ...loadAfter, ...loadBefore];
      const dependsOnRemoved = needed.some((raw) => {
        const normalized = this.normalizeModId(raw);
        const resolved =
          this.modsIdAliases.get(normalized.toLowerCase()) ?? normalized;
        return movedIds.has(resolved.toLowerCase());
      });
      if (dependsOnRemoved && !seen.has(key)) {
        dependents.push(item);
        seen.add(key);
      }
    }
    return dependents;
  }

  private orderModsByLoadRules(items: ModPickItem[]): ModPickItem[] {
    if (!items.length) {
      return items;
    }
    const normalizedIds = new Map<string, ModPickItem>();
    const orderIndex = new Map<string, number>();
    items.forEach((item, index) => {
      const key = item.modId.toLowerCase();
      normalizedIds.set(key, item);
      orderIndex.set(key, index);
    });

    const edges = new Map<string, Set<string>>();
    const indegree = new Map<string, number>();
    for (const key of normalizedIds.keys()) {
      edges.set(key, new Set());
      indegree.set(key, 0);
    }

    const addEdge = (from: string, to: string): void => {
      if (!edges.get(from)?.has(to)) {
        edges.get(from)?.add(to);
        indegree.set(to, (indegree.get(to) ?? 0) + 1);
      }
    };

    for (const [key] of normalizedIds) {
      const loadAfter = this.modLoadAfterById.get(key) ?? [];
      const loadBefore = this.modLoadBeforeById.get(key) ?? [];
      for (const raw of loadAfter) {
        const resolved = this.modsIdAliases.get(raw.toLowerCase());
        if (resolved && normalizedIds.has(resolved.toLowerCase())) {
          addEdge(resolved.toLowerCase(), key);
        }
      }
      for (const raw of loadBefore) {
        const resolved = this.modsIdAliases.get(raw.toLowerCase());
        if (resolved && normalizedIds.has(resolved.toLowerCase())) {
          addEdge(key, resolved.toLowerCase());
        }
      }
    }

    const ready = Array.from(indegree.entries())
      .filter(([, count]) => count === 0)
      .map(([id]) => id);
    const ordered: string[] = [];

    while (ready.length) {
      ready.sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
      const current = ready.shift() as string;
      ordered.push(current);
      for (const next of edges.get(current) ?? []) {
        indegree.set(next, (indegree.get(next) ?? 0) - 1);
        if ((indegree.get(next) ?? 0) === 0) {
          ready.push(next);
        }
      }
    }

    if (ordered.length !== normalizedIds.size) {
      return items;
    }

    return ordered
      .map((id) => normalizedIds.get(id))
      .filter((item): item is ModPickItem => !!item);
  }

  private async openMissingModsDialog(missingIds: string[]): Promise<void> {
    const normalized = Array.from(
      new Set(missingIds.map((id) => String(id ?? '').trim()).filter((id) => !!id)),
    );
    if (!normalized.length) {
      return;
    }
    this.missingMods = normalized.map((id) => ({
      id,
      workshopId: this.isNumericId(id) ? id : undefined,
    }));
    this.missingModsDialogVisible = true;
    this.missingModsLoading = true;
    const storedKey = await this.steamApiKeyService.get();
    this.missingModsHasApiKey = !!(storedKey ?? '').trim();

    if (this.missingModsHasApiKey) {
      const workshopIds = this.missingMods
        .map((item) => item.workshopId)
        .filter((id): id is string => !!id);
      if (workshopIds.length) {
        try {
          const meta = await this.workshopMetadata.getBatchMetadata(workshopIds);
          const metaById = new Map(
            meta.map((item) => [String(item.fileid), item]),
          );
          this.missingMods = this.missingMods.map((item) => {
            const details = item.workshopId
              ? metaById.get(item.workshopId)
              : undefined;
            return {
              ...item,
              title: details?.title ?? undefined,
              url: details?.url ?? undefined,
              error: details?.error ?? undefined,
            };
          });
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : typeof err === 'string' ? err : 'Steam API error';
          this.missingMods = this.missingMods.map((item) => ({
            ...item,
            error: item.error ?? message,
          }));
        }
      }
      const missingTextIds = this.missingMods
        .filter((item) => !item.workshopId)
        .map((item) => item.id);
      for (const id of missingTextIds) {
        try {
          const result = await this.workshopMetadata.queryModsBySearchText(id, 3);
          const hit = result?.items?.[0];
          if (hit?.publishedfileid) {
            const url = this.buildWorkshopUrl(hit.publishedfileid);
            this.missingMods = this.missingMods.map((item) =>
              item.id === id
                ? {
                    ...item,
                    workshopId: hit.publishedfileid,
                    title: hit.title ?? item.title,
                    url,
                  }
                : item,
            );
          }
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : typeof err === 'string' ? err : 'Steam API error';
          this.missingMods = this.missingMods.map((item) =>
            item.id === id ? { ...item, error: item.error ?? message } : item,
          );
        }
      }
    }

    this.missingModsLoading = false;
  }

  private isNumericId(value: string | undefined): boolean {
    return /^[0-9]{7,}$/.test((value ?? '').trim());
  }

  private buildWorkshopUrl(id: string): string {
    const trimmed = (id ?? '').trim();
    return trimmed
      ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${trimmed}`
      : '';
  }

  private applyModsSourceFilter(): void {
    if (!this.visible) {
      return;
    }
    const selectedIds = new Set(
      (this.modsTarget ?? []).map((item) => item.modId.toLowerCase()),
    );
    const filtered = this.filterModsByTags(this.modsAvailable);
    this.modsSource = filtered.filter(
      (item) => !selectedIds.has(item.modId.toLowerCase()),
    );
  }

  private filterModsByTags(items: ModPickItem[]): ModPickItem[] {
    const selected = this.modsDialogSelectedTags ?? [];
    if (!selected.length) {
      return items;
    }
    const requireAll = this.modsDialogTagMatchMode === 'all';
    return items.filter((item) => {
      const modTags = this.tagsService.getTagsForMod(item.id);
      if (!modTags || modTags.length === 0) {
        return false;
      }
      if (requireAll) {
        return selected.every((tag) => modTags.includes(tag));
      }
      return selected.some((tag) => modTags.includes(tag));
    });
  }

  private updateModsTagCounts(): void {
    if (!this.visible) {
      return;
    }
    const selectedIds = new Set(
      (this.modsTarget ?? []).map((item) => item.modId.toLowerCase()),
    );
    const available = this.modsAvailable.filter(
      (item) => !selectedIds.has(item.modId.toLowerCase()),
    );
    const searchFiltered = this.filterModsBySearch(
      available,
      this.modsSourceFilterValue,
    );
    const selected = this.modsDialogSelectedTags ?? [];
    const matchMode = this.modsDialogTagMatchMode;
    const counts: Record<string, number> = {};
    for (const tag of this.tagsService.tagOptions) {
      const tagsToMatch =
        matchMode === 'all'
          ? selected.length
            ? [...selected, tag]
            : [tag]
          : selected.length
            ? Array.from(new Set([...selected, tag]))
            : [tag];
      counts[tag] = searchFiltered.reduce((total, item) => {
        const modTags = this.tagsService.getTagsForMod(item.id);
        if (!modTags || modTags.length === 0) {
          return total;
        }
        const matches =
          matchMode === 'all'
            ? tagsToMatch.every((t) => modTags.includes(t))
            : tagsToMatch.some((t) => modTags.includes(t));
        return matches ? total + 1 : total;
      }, 0);
    }
    this.tagsService.setTagCounts(counts);
  }

  private filterModsBySearch(
    items: ModPickItem[],
    query: string,
  ): ModPickItem[] {
    const needle = (query ?? '').trim().toLowerCase();
    if (!needle) {
      return items;
    }
    return items.filter((item) => item.label.toLowerCase().includes(needle));
  }

  private parseModsValue(value: string | undefined): Array<{ raw: string; modId: string }> {
    return (value ?? '')
      .split(/[;\r\n]+/)
      .map((token) => token.trim())
      .filter((token) => !!token)
      .map((token) => ({
        raw: token,
        modId: this.normalizeModId(token),
      }))
      .filter((entry) => !!entry.modId);
  }

  private normalizeModId(value: string): string {
    return (value ?? '').trim().replace(/^[\\]+/, '').trim();
  }

  private parseWorkshopIds(value: string | undefined): string[] {
    return (value ?? '')
      .split(';')
      .map((token) => token.trim())
      .filter((token) => !!token);
  }
}
