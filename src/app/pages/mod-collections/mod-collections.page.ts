import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TableModule, Table } from 'primeng/table';
import type { TableLazyLoadEvent } from 'primeng/table';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { ProgressBarModule } from 'primeng/progressbar';
import { ToastModule } from 'primeng/toast';
import { MessageService, MenuItem } from 'primeng/api';
import { MenuModule } from 'primeng/menu';
import { TagModule } from 'primeng/tag';
import { ImageModule } from 'primeng/image';
import { openUrl } from '@tauri-apps/plugin-opener';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  WorkshopMetadataService,
  WorkshopQueryItem,
} from '../../services/workshop-metadata.service';
import { BasePageComponent } from '../../components/base-page.component';
import { ModsStateService } from '../../services/mods-state.service';
import { LoadoutsStateService } from '../../services/loadouts-state.service';
import {
  ModCollectionFilters,
  ModCollectionFiltersService,
  ModCollectionTagOption,
} from '../../services/mod-collection-filters.service';
import type { ModSummary } from '../../models/mod.models';
import type { Loadout } from '../../models/loadout.models';
import { debounceTime, skip } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LocalizationService } from '../../services/localization.service';
import { TranslocoService } from '@jsverse/transloco';
import { formatLocalizedDateTime } from '../../i18n/date-time';

interface CollectionRow extends WorkshopQueryItem {
  tags_display?: string;
}

interface CollectionModsState {
  loading: boolean;
  error?: string;
  mods: CollectionModRow[];
}

interface CollectionModRow {
  publishedfileid: string;
  title: string;
  preview_url?: string | null;
  installed: boolean;
  activated: boolean;
  needsInstall: boolean;
  workshopUrl: string;
  localMod?: ModSummary | null;
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

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `loadout_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

const COLLECTION_DESC_PREFIX = 'Steam Collection: ';
const COLLECTION_BATCH_DELAY_MIN_MS = 2000;
const COLLECTION_BATCH_DELAY_MAX_MS = 5000;

@Component({
  selector: 'app-mod-collections-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    ButtonModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    ProgressBarModule,
    ToastModule,
    MenuModule,
    TagModule,
    ImageModule,
  ],
  providers: [MessageService],
  templateUrl: './mod-collections.page.html',
})
export class ModCollectionsPageComponent
  extends BasePageComponent
  implements OnInit
{
  collections: CollectionRow[] = [];
  expandedRows: Record<string, boolean> = {};
  collectionMods: Record<string, CollectionModsState> = {};
  private readonly collectionDetailsById: Record<string, WorkshopQueryItem> = {};
  private readonly modByWorkshopId = new Map<string, ModSummary>();
  private readonly activeModIds = new Set<string>();
  private readonly collectionPresetsById = new Map<string, Loadout>();
  loading = false;
  rows = 25;
  rowsPerPageOptions = [25, 50, 100, 200];
  searchKeyword = '';
  queryText = '';
  totalRecords = 0;
  first = 0;
  collectionSort: ModCollectionFilters['sort'] = 'trend';
  collectionDays = 7;
  collectionTags: string[] = [];
  sortField: string | null = null;
  sortOrder: 1 | -1 | 0 = 1;

  private loadInFlight = false;
  private loadToken = 0;
  private cacheKey = '';
  private currentLocale = 'en-US';
  private nextCursor: string | null = null;
  private prefetchInFlight = false;
  private ensureInFlight = false;
  private pendingFirst: number | null = null;

  get pagedCollections(): CollectionRow[] {
    return this.collections.slice(this.first, this.first + this.rows);
  }

  constructor(
    private readonly workshopService: WorkshopMetadataService,
    private readonly modsState: ModsStateService,
    private readonly loadoutsState: LoadoutsStateService,
    private readonly collectionFilters: ModCollectionFiltersService,
    private readonly localization: LocalizationService,
    private readonly transloco: TranslocoService,
  ) {
    super();
    this.currentLocale = this.localization.locale || 'en-US';
    this.localization.locale$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((locale) => {
        this.currentLocale = locale;
      });
  }

  async ngOnInit(): Promise<void> {
    try {
      const initialFilters = this.collectionFilters.filters;
      this.applyCollectionFilters(initialFilters);
      this.collectionFilters.filters$
        .pipe(skip(1), debounceTime(250), takeUntilDestroyed(this.destroyRef))
        .subscribe((filters) => {
          const changed = this.applyCollectionFilters(filters);
          if (changed) {
            void this.refreshCollections();
          }
        });
      await this.loadLocalState();
      await this.refreshCollections();
    } finally {
      if (!this.destroyRef.destroyed) {
        this.contentLoading.markReady();
      }
    }
  }

  async refreshCollections(): Promise<void> {
    const nextKey = this.buildCacheKey();
    const keyChanged = nextKey !== this.cacheKey;
    if (keyChanged) {
      this.cacheKey = nextKey;
      this.collections = [];
      this.totalRecords = 0;
      this.expandedRows = {};
      this.collectionMods = {};
      this.first = 0;
      this.nextCursor = null;
      this.prefetchInFlight = false;
      this.ensureInFlight = false;
      this.pendingFirst = null;
      this.loadToken += 1;
    }

    if (this.collections.length) {
      const target = this.first + this.rows;
      void this.ensureCollectionsLoaded(target);
      return;
    }

    await this.loadAllCollections(this.loadToken);
  }

  onCollectionSearchInputChange(value: string): void {
    this.collectionFilters.updateFilters({ searchText: value ?? '' });
  }

  onCollectionSearchSubmit(): void {
    this.collectionFilters.updateFilters({ searchText: this.queryText ?? '' });
  }

  onSort(event: unknown): void {
    const raw = event as { field?: string | null; order?: number | null } | null;
    const field = (raw?.field ?? '').toString().trim();
    if (!field || !raw?.order) {
      this.sortField = null;
      this.sortOrder = 1;
      return;
    }

    this.sortField = field;
    this.sortOrder = raw.order === -1 ? -1 : 1;
    this.applyCollectionSort();
  }

  onPage(event: { first?: number | null; rows?: number | null } | TableLazyLoadEvent): void {
    const nextRows = event.rows ?? this.rows;
    const nextFirst = event.first ?? this.first ?? 0;
    const rowsChanged = nextRows !== this.rows;

    const sortField = (event as TableLazyLoadEvent)?.sortField;
    const sortOrder = (event as TableLazyLoadEvent)?.sortOrder;
    if (sortField && sortOrder) {
      this.sortField = sortField.toString();
      this.sortOrder = sortOrder === -1 ? -1 : 1;
      this.applyCollectionSort();
    }

    if (
      this.pendingFirst != null &&
      nextFirst === 0 &&
      this.pendingFirst > 0 &&
      this.collections.length < this.pendingFirst + this.rows
    ) {
      return;
    }

    this.rows = nextRows;
    this.first = nextFirst;

    if (rowsChanged) {
      this.pendingFirst = null;
      void this.refreshCollections();
      return;
    }

    const target = this.first + this.rows;
    if (this.collections.length < target) {
      this.pendingFirst = this.first;
      void this.ensureCollectionsLoaded(target).finally(() => {
        if (this.pendingFirst === this.first && this.collections.length >= target) {
          this.pendingFirst = null;
        }
      });
      return;
    }

    this.pendingFirst = null;
  }

  async loadAllCollections(token: number): Promise<void> {
    if (this.loadInFlight) {
      return;
    }

    this.loadInFlight = true;
    this.loading = true;

    try {
      const searchText = this.queryText.trim();
      const total = await this.workshopService.queryCollectionsTotalForPZ({
        searchText,
        sort: this.collectionSort,
        days: this.collectionDays,
        requiredtags: this.collectionTags,
      });

      if (!total || total <= 0) {
        this.totalRecords = 0;
        this.collections = [];
        return;
      }

      this.totalRecords = total;
      const pageSize = Math.max(1, this.rows);
      const firstResult = await this.workshopService.queryCollectionsForPZ({
        numperpage: pageSize,
        cursor: '*',
        searchText,
        sort: this.collectionSort,
        days: this.collectionDays,
        requiredtags: this.collectionTags,
      });

      if (!firstResult) {
          this.messageService.add({
            severity: 'error',
            summary: this.transloco.translate('toasts.modCollections.loadFailed.summary'),
            detail: this.transloco.translate('toasts.modCollections.loadFailed.detail'),
            life: 8000,
            closable: true,
        });
        return;
      }

      const items = this.filterVisibleCollections(firstResult.items ?? []);
      this.addCollections(items);
      this.nextCursor = firstResult.nextCursor ?? '';
      await this.enrichCollectionsWithDetails(items);

      if (items.length && this.nextCursor) {
        void this.prefetchCollections(token, searchText, pageSize, 2);
      }
    } catch (err: unknown) {
      const detail =
        err instanceof Error && err.message === 'STEAM_API_UNAUTHORIZED'
          ? this.transloco.translate('toasts.modCollections.steamUnauthorized')
          : err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : this.transloco.translate('toasts.modCollections.queryFailed');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.modCollections.loadFailed.summary'),
        detail,
        life: 10000,
        closable: true,
      });
    } finally {
      this.loading = false;
      this.loadInFlight = false;
    }
  }

  private async prefetchCollections(
    token: number,
    searchText: string,
    pageSize: number,
    pagesToPrefetch: number,
  ): Promise<void> {
    if (this.prefetchInFlight) {
      return;
    }
    this.prefetchInFlight = true;
    try {
      let remaining = pagesToPrefetch;
      while (remaining > 0 && this.nextCursor && token === this.loadToken) {
        const loaded = await this.loadNextPage(token, searchText, pageSize);
        if (!loaded) {
          break;
        }
        remaining -= 1;
        if (remaining > 0) {
          await this.delayBetweenBatches();
        }
      }
    } finally {
      this.prefetchInFlight = false;
    }
  }

  private async ensureCollectionsLoaded(target: number): Promise<void> {
    if (this.ensureInFlight || this.loadInFlight) {
      return;
    }
    if (this.collections.length >= target) {
      return;
    }
    if (!this.nextCursor) {
      return;
    }
    const searchText = this.queryText.trim();
    const pageSize = Math.max(1, this.rows);
    const token = this.loadToken;

    this.ensureInFlight = true;
    try {
      while (
        this.collections.length < target &&
        this.nextCursor &&
        token === this.loadToken
      ) {
        const loaded = await this.loadNextPage(token, searchText, pageSize);
        if (!loaded) {
          break;
        }
      }
    } finally {
      this.ensureInFlight = false;
    }
  }

  private async loadNextPage(
    token: number,
    searchText: string,
    pageSize: number,
  ): Promise<boolean> {
    if (!this.nextCursor || token !== this.loadToken) {
      return false;
    }

    const result = await this.workshopService.queryCollectionsForPZ({
      numperpage: pageSize,
      cursor: this.nextCursor,
      searchText,
      sort: this.collectionSort,
      days: this.collectionDays,
      requiredtags: this.collectionTags,
    });

    if (!result || token !== this.loadToken) {
      return false;
    }

    const items = this.filterVisibleCollections(result.items ?? []);
    if (items.length) {
      this.addCollections(items);
      await this.enrichCollectionsWithDetails(items);
    }

    this.nextCursor = result.nextCursor ?? '';
    return items.length > 0 && !!this.nextCursor;
  }

  private filterVisibleCollections(items: WorkshopQueryItem[]): WorkshopQueryItem[] {
    return items.filter((item) => {
      const visibility = item.visibility;
      if (typeof visibility === 'number' && visibility !== 0) {
        return false;
      }
      return true;
    });
  }

  private addCollections(items: WorkshopQueryItem[]): void {
    if (!items.length) {
      return;
    }
    const mapped = items.map((item) => ({
      ...item,
      tags_display: this.formatTags(item.tags),
    }));
    const merged = [...this.collections, ...mapped];
    const seen = new Set<string>();
    this.collections = merged.filter((item) => {
      const id = (item.publishedfileid || '').trim();
      if (!id || seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });

    this.applyCollectionSort();
    this.updateCollectionTagOptions();
  }

  private buildCacheKey(): string {
    const searchText = this.queryText.trim().toLowerCase();
    const tags = (this.collectionTags ?? []).slice().sort().join(',');
    return `${searchText}::${this.collectionSort}::${this.collectionDays}::${tags}::${this.rows}`;
  }

  private applyCollectionFilters(filters: ModCollectionFilters): boolean {
    const before = this.buildCacheKey();
    this.queryText = filters.searchText ?? '';
    this.collectionSort = filters.sort;
    this.collectionDays = filters.days ?? 7;
    this.collectionTags = Array.isArray(filters.tags) ? filters.tags : [];
    const after = this.buildCacheKey();
    return before !== after;
  }

  private updateCollectionTagOptions(): void {
    const optionsMap = new Map<string, ModCollectionTagOption>();
    for (const item of this.collections ?? []) {
      for (const tag of item.tags ?? []) {
        const value = (tag?.tag ?? '').trim();
        if (!value) {
          continue;
        }
        const label = (tag?.display_name ?? value).trim();
        if (!optionsMap.has(value)) {
          optionsMap.set(value, { label, value });
        }
      }
    }
    if (!optionsMap.size) {
      return;
    }
    const options = Array.from(optionsMap.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    this.collectionFilters.setTagOptions(options);
  }

  private applyCollectionSort(): void {
    if (!this.sortField || this.sortOrder === 0) {
      return;
    }

    const numericFields = new Set([
      'publishedfileid',
      'num_children',
      'subscriptions',
      'views',
      'time_updated',
    ]);
    const field = this.sortField;
    const order = this.sortOrder;

    this.collections = [...this.collections].sort((a, b) => {
      const aVal = (a as any)?.[field];
      const bVal = (b as any)?.[field];

      if (numericFields.has(field)) {
        const aNum = typeof aVal === 'number' ? aVal : Number(aVal) || 0;
        const bNum = typeof bVal === 'number' ? bVal : Number(bVal) || 0;
        return (aNum - bNum) * order;
      }

      const aStr = (aVal ?? '').toString().toLowerCase();
      const bStr = (bVal ?? '').toString().toLowerCase();
      if (aStr === bStr) {
        return 0;
      }
      return aStr.localeCompare(bStr) * order;
    });
  }

  async onRowExpand(event: { data?: CollectionRow }): Promise<void> {
    const row = event?.data;
    if (!row) {
      return;
    }
    const id = (row.publishedfileid || '').trim();
    if (!id) {
      return;
    }
    this.expandedRows = { ...this.expandedRows, [id]: true };
    if (this.collectionMods[id]?.loading || this.collectionMods[id]?.mods?.length) {
      return;
    }
    await this.loadCollectionMods(row);
  }

  onRowCollapse(event: { data?: CollectionRow }): void {
    const row = event?.data;
    if (!row) {
      return;
    }
    const id = (row.publishedfileid || '').trim();
    if (!id) {
      return;
    }
    const next = { ...this.expandedRows };
    delete next[id];
    this.expandedRows = next;
  }

  onGlobalFilter(table: Table, event: Event): void {
    table.filterGlobal((event.target as HTMLInputElement).value, 'contains');
  }

  onClearFilters(table: Table): void {
    table.clear();
    this.searchKeyword = '';
  }

  getChildrenCount(item: WorkshopQueryItem): number {
    if (typeof item.num_children === 'number') {
      return item.num_children;
    }
    if (Array.isArray(item.children)) {
      return item.children.length;
    }
    return 0;
  }

  getCollectionThumbnail(item: CollectionRow): string | undefined {
    const id = (item.publishedfileid || '').trim();
    const detail = id ? this.collectionDetailsById[id] : null;
    const url = (detail?.preview_url ?? item.preview_url ?? '').trim();
    return url || undefined;
  }

  getCollectionTags(item: CollectionRow): string {
    return (item.tags_display ?? '').trim();
  }

  getCollectionDescription(item: CollectionRow): string {
    const fromRow =
      (item.short_description ?? item.file_description ?? '').trim();
    if (fromRow) {
      return fromRow;
    }
    const id = (item.publishedfileid || '').trim();
    const detail = id ? this.collectionDetailsById[id] : null;
    const detailDesc =
      (detail?.file_description ?? detail?.short_description ?? '').trim();
    return detailDesc;
  }

  getCollectionDescriptionDisplay(item: CollectionRow): string {
    const desc = this.getCollectionDescription(item);
    if (!desc) {
      return '';
    }
    const maxLen = 160;
    if (desc.length <= maxLen) {
      return desc;
    }
    return `${desc.slice(0, maxLen)}...`;
  }

  getCollectionMenuItems(item: CollectionRow): MenuItem[] {
    const id = (item.publishedfileid || '').trim();
    const hasPreset = !!id && this.collectionPresetsById.has(id);

    const items: MenuItem[] = [];

    if (!id) {
      return items;
    }

    items.push({
      label: 'Open in Steam',
      icon: 'pi pi-external-link',
      command: () => void this.openWorkshop(id),
    });

    if (!hasPreset) {
      items.unshift({
        label: 'Add as Mod Preset',
        icon: 'pi pi-plus',
        command: () => void this.addCollectionPreset(item),
      });
      return items;
    }

    items.unshift(
      {
        label: 'Update Preset',
        icon: 'pi pi-refresh',
        command: () => void this.updateCollectionPreset(item),
      },
      {
        label: 'Remove Preset',
        icon: 'pi pi-trash',
        command: () => void this.removeCollectionPreset(item),
      },
    );
    return items;
  }

  getModThumbnail(row: CollectionModRow): string | undefined {
    if (row.localMod) {
      if (row.localMod.preview_image_path) {
        return convertFileSrc(row.localMod.preview_image_path);
      }
      if (row.localMod.icon) {
        return convertFileSrc(row.localMod.icon);
      }
    }
    const url = (row.preview_url ?? '').trim();
    return url || undefined;
  }

  formatStatus(row: CollectionModRow): string {
    if (row.activated) {
      return 'Activated';
    }
    if (row.installed) {
      return 'Installed';
    }
    return 'Needs Install';
  }

  getStatusSeverity(row: CollectionModRow): 'success' | 'info' | 'danger' {
    if (row.activated) {
      return 'success';
    }
    if (row.installed) {
      return 'info';
    }
    return 'danger';
  }

  getInstalledSeverity(row: CollectionModRow): 'success' | 'danger' {
    return row.installed ? 'success' : 'danger';
  }

  getActiveSeverity(row: CollectionModRow): 'success' | 'secondary' {
    return row.activated ? 'success' : 'secondary';
  }

  formatDateTime(value: number | string | null | undefined): string {
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

  async openWorkshop(id: string | undefined | null): Promise<void> {
    const trimmed = (id ?? '').trim();
    if (!trimmed || !/^\d+$/.test(trimmed)) {
      return;
    }
    await openUrl(`https://steamcommunity.com/sharedfiles/filedetails/?id=${trimmed}`);
  }

  private async loadLocalState(): Promise<void> {
    const persisted = await this.untilDestroyed(this.modsState.loadPersistedMods());
    const mods = persisted?.local ?? [];

    this.modByWorkshopId.clear();
    for (const mod of mods) {
      const workshopId = (mod.workshop_id ?? '').trim();
      if (workshopId) {
        this.modByWorkshopId.set(workshopId, mod);
      }
      if (mod.workshop?.fileid != null) {
        this.modByWorkshopId.set(String(mod.workshop.fileid), mod);
      }
    }

    const loadouts = await this.untilDestroyed(this.loadoutsState.load());
    this.activeModIds.clear();
    this.collectionPresetsById.clear();
    for (const loadout of loadouts) {
      if (!parseActiveModsRelDir(loadout.name)) {
        const collectionId = this.parseCollectionIdFromLoadout(loadout);
        if (collectionId) {
          this.collectionPresetsById.set(collectionId, loadout);
        }
      } else {
        for (const modId of loadout.modIds ?? []) {
          const cleaned = (modId ?? '').trim();
          if (cleaned) {
            this.activeModIds.add(cleaned);
          }
        }
      }
    }
  }

  private formatTags(tags: WorkshopQueryItem['tags']): string {
    if (!tags || !tags.length) {
      return '';
    }
    const names = tags
      .map((tag) => (tag.display_name ?? tag.tag ?? '').trim())
      .filter((value) => value.length > 0);
    return names.join(', ');
  }

  private async enrichCollectionsWithDetails(items: WorkshopQueryItem[]): Promise<void> {
    const ids = items
      .map((item) => (item.publishedfileid || '').trim())
      .filter((id) => id.length > 0);
    const missing = ids.filter((id) => !this.collectionDetailsById[id]);
    if (!missing.length) {
      return;
    }

    const details = await this.workshopService.getBatchMetadata(missing);
    for (const detail of details) {
      if (detail && !detail.error && detail.fileid) {
        const id = String(detail.fileid);
        this.collectionDetailsById[id] = {
          publishedfileid: id,
          preview_url: detail.preview_url ?? undefined,
          title: detail.title ?? undefined,
          file_description: detail.file_description ?? undefined,
        };
      }
    }

    if (!missing.length) {
      return;
    }

    this.collections = this.collections.map((item) => {
      const id = (item.publishedfileid || '').trim();
      if (!id || !missing.includes(id)) {
        return item;
      }
      const detail = this.collectionDetailsById[id];
      if (!detail) {
        return item;
      }
      return {
        ...item,
        file_description: item.file_description ?? detail.file_description,
        short_description: item.short_description ?? detail.file_description,
      };
    });
  }

  private async loadCollectionMods(row: CollectionRow): Promise<void> {
    const id = (row.publishedfileid || '').trim();
    if (!id) {
      return;
    }

    const children = Array.isArray(row.children) ? row.children : [];
    if (!children.length) {
      this.collectionMods[id] = { loading: false, mods: [] };
      return;
    }

    this.collectionMods[id] = { loading: true, mods: [] };

    try {
      const childIds = children
        .map((child) => String(child.publishedfileid ?? '').trim())
        .filter((childId) => childId.length > 0);

      const details = await this.workshopService.getBatchMetadata(childIds);
      const detailsById = new Map<string, typeof details[number]>();
      for (const detail of details) {
        if (detail && !detail.error && detail.fileid) {
          detailsById.set(String(detail.fileid), detail);
        }
      }

      const mods: CollectionModRow[] = [];
      for (const child of children) {
        const childId = String(child.publishedfileid ?? '').trim();
        if (!childId) {
          continue;
        }

        const detail = detailsById.get(childId);
        const localMod = this.modByWorkshopId.get(childId) ?? null;
        const modId = (localMod?.mod_id ?? '').trim();
        const installed = !!localMod;
        const activated = installed && (!!modId && this.activeModIds.has(modId));
        mods.push({
          publishedfileid: childId,
          title:
            (detail?.title ?? '').trim() ||
            (localMod?.name ?? '').trim() ||
            `Workshop ${childId}`,
          preview_url: detail?.preview_url ?? null,
          installed,
          activated,
          needsInstall: !installed,
          workshopUrl: `https://steamcommunity.com/sharedfiles/filedetails/?id=${childId}`,
          localMod,
        });
      }

      this.collectionMods[id] = { loading: false, mods };
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : 'Failed to load collection mods.';
      this.collectionMods[id] = {
        loading: false,
        error: detail,
        mods: [],
      };
    }
  }

  private async delayBetweenBatches(): Promise<void> {
    const min = COLLECTION_BATCH_DELAY_MIN_MS;
    const max = COLLECTION_BATCH_DELAY_MAX_MS;
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  private parseCollectionIdFromLoadout(loadout: Loadout): string | null {
    const desc = (loadout.description ?? '').trim();
    if (!desc.startsWith(COLLECTION_DESC_PREFIX)) {
      return null;
    }
    const id = desc.slice(COLLECTION_DESC_PREFIX.length).trim();
    return id ? id : null;
  }

  private getCollectionWorkshopIds(item: CollectionRow): string[] {
    const children = Array.isArray(item.children) ? item.children : [];
    const ids = children
      .map((child) => String(child.publishedfileid ?? '').trim())
      .filter((id) => id.length > 0);
    return Array.from(new Set(ids));
  }

  private resolveModIdsFromWorkshopIds(workshopIds: string[]): string[] {
    const modIds = new Set<string>();
    for (const workshopId of workshopIds) {
      const mod = this.modByWorkshopId.get(workshopId);
      const modId = (mod?.mod_id ?? '').trim();
      if (modId) {
        modIds.add(modId);
      }
    }
    return Array.from(modIds);
  }

  private buildPresetName(item: CollectionRow): string {
    const title = (item.title ?? '').trim();
    const id = (item.publishedfileid ?? '').trim();
    if (title && id) {
      return `Collection: ${title} (${id})`;
    }
    if (title) {
      return `Collection: ${title}`;
    }
    return `Collection ${id}`;
  }

  private async saveLoadouts(next: Loadout[]): Promise<void> {
    await this.loadoutsState.save(next);
    this.collectionPresetsById.clear();
    for (const loadout of next) {
      const id = this.parseCollectionIdFromLoadout(loadout);
      if (id) {
        this.collectionPresetsById.set(id, loadout);
      }
    }
  }

  private async addCollectionPreset(item: CollectionRow): Promise<void> {
    const id = (item.publishedfileid ?? '').trim();
    if (!id) {
      return;
    }
    if (this.collectionPresetsById.has(id)) {
      return;
    }

    const workshopIds = this.getCollectionWorkshopIds(item);
    if (!workshopIds.length) {
      this.messageService.add({
        severity: 'warn',
        summary: this.transloco.translate('toasts.modCollections.presetNotCreated.summary'),
        detail: this.transloco.translate('toasts.modCollections.presetNotCreated.detail'),
        life: 8000,
        closable: true,
      });
      return;
    }

    const modIds = this.resolveModIdsFromWorkshopIds(workshopIds);
    const ts = nowIso();
    const created: Loadout = {
      id: newId(),
      name: this.buildPresetName(item),
      description: `${COLLECTION_DESC_PREFIX}${id}`,
      createdAt: ts,
      updatedAt: ts,
      targetModes: ['singleplayer'],
      modIds,
      workshopIds,
    };

    const loadouts = await this.loadoutsState.load();
    loadouts.unshift(created);
    await this.saveLoadouts(loadouts);

    this.messageService.add({
      severity: 'success',
      summary: this.transloco.translate('toasts.modCollections.presetCreated.summary'),
      detail: this.transloco.translate('toasts.modCollections.presetCreated.detail', {
        name: created.name,
      }),
      life: 5000,
      closable: true,
    });
  }

  private async updateCollectionPreset(item: CollectionRow): Promise<void> {
    const id = (item.publishedfileid ?? '').trim();
    if (!id) {
      return;
    }

    const loadouts = await this.loadoutsState.load();
    const idx = loadouts.findIndex(
      (l) => this.parseCollectionIdFromLoadout(l) === id,
    );
    if (idx < 0) {
      return;
    }

    const workshopIds = this.getCollectionWorkshopIds(item);
    const modIds = this.resolveModIdsFromWorkshopIds(workshopIds);

    const updated = { ...loadouts[idx] };
    updated.name = this.buildPresetName(item);
    updated.workshopIds = workshopIds;
    updated.modIds = modIds;
    updated.updatedAt = nowIso();
    loadouts[idx] = updated;

    await this.saveLoadouts(loadouts);
    this.messageService.add({
      severity: 'success',
      summary: this.transloco.translate('toasts.modCollections.presetUpdated.summary'),
      detail: this.transloco.translate('toasts.modCollections.presetUpdated.detail', {
        name: updated.name,
      }),
      life: 5000,
      closable: true,
    });
  }

  private async removeCollectionPreset(item: CollectionRow): Promise<void> {
    const id = (item.publishedfileid ?? '').trim();
    if (!id) {
      return;
    }

    const loadouts = await this.loadoutsState.load();
    const next = loadouts.filter(
      (l) => this.parseCollectionIdFromLoadout(l) !== id,
    );
    if (next.length === loadouts.length) {
      return;
    }

    await this.saveLoadouts(next);
    this.messageService.add({
      severity: 'success',
      summary: this.transloco.translate('toasts.modCollections.presetRemoved.summary'),
      detail: this.transloco.translate('toasts.modCollections.presetRemoved.detail'),
      life: 5000,
      closable: true,
    });
  }
}
