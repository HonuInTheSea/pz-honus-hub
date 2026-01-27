import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ModService } from '../../services/mod.service';
import { ModSummary } from '../../models/mod.models';
import { ModTableComponent } from '../../components/mod-table/mod-table.component';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { DialogModule } from 'primeng/dialog';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ProgressBarModule } from 'primeng/progressbar';
import { FormsModule } from '@angular/forms';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ModsTagsService } from '../../services/mods-tags.service';
import { WorkshopMetadataService, WorkshopMetadata } from '../../services/workshop-metadata.service';
import { ModsStateService } from '../../services/mods-state.service';
import { LoadoutsStateService } from '../../services/loadouts-state.service';
import type { Loadout } from '../../models/loadout.models';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import type { TablePageEvent } from 'primeng/types/table';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HonuModInfoQolService } from '../../services/honu-mod-info-qol.service';
import { isDestroyedError } from '../../utils/destruction-guard';
import { BasePageComponent } from '../../components/base-page.component';
import { LocalizationService } from '../../services/localization.service';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { formatLocalizedDateTime } from '../../i18n/date-time';

@Component({
  selector: 'app-mods-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ModTableComponent,
    ButtonModule,
    InputTextModule,
    DialogModule,
    ToggleSwitchModule,
    ProgressBarModule,
    ToastModule,
    TranslocoModule,
  ],
  providers: [MessageService],
  templateUrl: './mods.page.html',
})
export class ModsPageComponent extends BasePageComponent implements OnInit, OnDestroy {
  mods: ModSummary[] = [];
  loading = false;
  limitOptions = [25, 50, 100, 200];
  limit = 25;
  first = 0;
  filteredMods: ModSummary[] = [];
  searchKeyword = '';
  private workshopMetadataById: Record<string, WorkshopMetadata> = {};
  private readonly workshopAutoFetchKey = 'pz_workshop_auto_fetch';
  private readonly itemsPerPageKey = 'pz_mods_items_per_page';
  private readonly lastLocalScanFolderKey = 'pz_mod_folder_last_scan';
  private readonly lastWorkshopSyncFolderKey = 'pz_mod_folder_last_workshop_sync';
  private readonly honuDirChangedAtKey = 'pz_honu_mod_info_qol_dir_changed_at';

  showWorkshopPrompt = false;
  autoWorkshopFetch = false;
  loadingSource: 'local' | 'workshop' | null = null;
  private onboardingFinishedListener: (() => void) | null = null;
  private presetFilterListener: (() => void) | null = null;

  private presetFilterIds: string[] = [];
  private presetFilterModIds: Set<string> = new Set<string>();
  private readonly presetFilterKey = 'pz_filter_in_preset_ids';
  private currentLocale = 'en-US';
  private emptyScanAttempted = false;

  constructor(
    private readonly modService: ModService,
    private readonly tagsService: ModsTagsService,
    private readonly workshopMetadataService: WorkshopMetadataService,
    private readonly modsState: ModsStateService,
    private readonly loadoutsState: LoadoutsStateService,
    private readonly honuQol: HonuModInfoQolService,
    private readonly localization: LocalizationService,
    private readonly transloco: TranslocoService,
  ) {
    super();
    this.currentLocale = this.localization.locale || 'en-US';
    this.localization.locale$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((locale) => {
        this.currentLocale = locale;
        this.applyFilters();
      });
  }

  async ngOnInit(): Promise<void> {
    try {
      const onboardingCompleted =
        (await this.store.getItem<boolean>('pz_onboarding_completed')) ?? false;
      const onboardingJustFinished =
        (await this.store.getItem<boolean>('pz_onboarding_just_finished')) ?? false;

      const persistedLimit = await this.store.getItem<number>(this.itemsPerPageKey);
      if (persistedLimit && this.limitOptions.includes(persistedLimit)) {
        this.limit = persistedLimit;
      }

      const savedFolder = await this.store.getItem<string>('pz_mod_folder');
      if (savedFolder) {
        this.modsActions.folderPath = savedFolder;
        void this.modsActions.checkMusicAvailability(savedFolder);
      } else {
        void this.modsActions.checkMusicAvailability(null);
      }

      const persisted = await this.untilDestroyed(this.modsState.loadPersistedMods());

      if (persisted) {
        this.mods = persisted.local;
        this.workshopMetadataById = persisted.workshop;

        // Data migration: Clear old string-based required_by array and trigger a rescan.
        let needsRescan = false;
        for (const mod of this.mods) {
            if (mod.required_by && mod.required_by.length > 0 && typeof mod.required_by[0] === 'string') {
                mod.required_by = [];
                needsRescan = true;
            }
        }

        if (needsRescan) {
            this.messageService.add({
                severity: 'info',
                summary: this.transloco.translate('toasts.mods.dataMigration.summary'),
                detail: this.transloco.translate('toasts.mods.dataMigration.detail'),
                life: 8000,
                closable: true,
            });
            await this.scan(true); // force a scan
        }

        this.seedCustomTagsFromMods();
        // Migrate older scans (which only captured ~1 entry per workshop item)
        // to the newer full `mod.info` inventory scan.
        if (persisted.schemaVersion < 3 && this.modsActions.folderPath) {
          await this.untilDestroyed(this.scan());
        }

        // If we have a saved folder but an empty cache, force a rescan once.
        if (
          !this.mods.length &&
          this.modsActions.folderPath &&
          onboardingCompleted &&
          !this.emptyScanAttempted
        ) {
          this.emptyScanAttempted = true;
          await this.untilDestroyed(this.scan(true));
        }
      } else {
        // No persisted state yet; attempt an initial local scan (if a folder
        // path is available) so that we can populate and persist pz_mods
        // without requiring the user to trigger a manual scan.
        this.mods = [];
        this.workshopMetadataById = {};
        if (this.modsActions.folderPath && onboardingCompleted) {
          await this.untilDestroyed(this.scan());
          if (onboardingJustFinished) {
            await this.untilDestroyed(this.tryOnboardingWorkshopSync());
          }
        }
      }

      await this.untilDestroyed(this.loadWorkshopPreferences());

      if (typeof window !== 'undefined') {
        this.onboardingFinishedListener = () => {
          void this.handleOnboardingFinished();
        };
        window.addEventListener('pz-onboarding-finished', this.onboardingFinishedListener);

        this.presetFilterListener = () => {
          void this.onPresetFilterChanged();
        };
        window.addEventListener('pz-preset-filter-changed', this.presetFilterListener);
      }

      this.modsActions.browseFolder$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          void this.pickFolder();
        });

      this.modsActions.createFile$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          void this.createNewModListing();
        });

      this.modsActions.scan$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          void this.scan(true);
        });

      this.modsActions.syncWorkshop$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          void this.syncWorkshopMetadata(true);
        });

      this.tagsService.selectedTags$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.applyFilters();
        });

      this.tagsService.tagMatchMode$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.applyFilters();
        });

      this.tagsService.outdatedOnly$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.applyFilters();
        });

      this.tagsService.hiddenOnly$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.applyFilters();
        });

      this.tagsService.missingSteamOnly$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.applyFilters();
        });

      this.tagsService.hasAdultContentOnly$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.applyFilters();
        });

      this.tagsService.hasRulesOnly$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.applyFilters();
        });

      this.tagsService.favoritedOnly$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.applyFilters();
        });

      await this.untilDestroyed(this.refreshPresetFilterCache());

      // When mods are loaded (either from storage or from a fresh scan),
      // apply any active filters.
      this.applyFilters();

      // Once local mods are available, check whether any Workshop metadata exists.
      // If none is present, auto-fetch or prompt the user.
      if (this.mods.length && !this.hasAnyWorkshopMetadata() && onboardingCompleted) {
        if (this.autoWorkshopFetch) {
          void this.syncWorkshopMetadata();
        } else {
          this.showWorkshopPrompt = true;
        }
      }

      if (onboardingJustFinished && this.mods.length) {
        await this.untilDestroyed(this.tryOnboardingWorkshopSync());
      }
    } catch (err) {
      if (isDestroyedError(err)) return;
      throw err;
    } finally {
      if (!this.destroyRef.destroyed) {
        this.contentLoading.markReady();
      }
    }
  }

  private async tryOnboardingWorkshopSync(): Promise<void> {
    try {
      const apiKey = (await this.store.getItem<string>('steam_api_key')) ?? '';
      if (!apiKey.trim()) {
        return;
      }

      if (!this.hasAnyWorkshopMetadata()) {
        await this.untilDestroyed(this.syncWorkshopMetadata());
      }
    } finally {
      if (!this.destroyRef.destroyed) {
        await this.store.setItem('pz_onboarding_just_finished', false);
      }
    }
  }

  async ngOnDestroy(): Promise<void> {
    if (typeof window !== 'undefined' && this.onboardingFinishedListener) {
      window.removeEventListener('pz-onboarding-finished', this.onboardingFinishedListener);
      this.onboardingFinishedListener = null;
    }
    if (typeof window !== 'undefined' && this.presetFilterListener) {
      window.removeEventListener('pz-preset-filter-changed', this.presetFilterListener);
      this.presetFilterListener = null;
    }

    // Persist the latest mods + workshop metadata whenever the page is
    // destroyed (for example, when navigating away), so that state is
    // restored correctly on the next visit without requiring another scan
    // or workshop sync.
    try {
      await this.saveModsToStorage();
    } catch {
      // Ignore persistence errors on teardown.
    }
  }

  private async onPresetFilterChanged(): Promise<void> {
    await this.untilDestroyed(this.refreshPresetFilterCache());
    this.applyFilters();
  }

  private async refreshPresetFilterCache(): Promise<void> {
    const selected =
      (await this.untilDestroyed(this.store.getItem<string[]>(this.presetFilterKey))) ?? [];
    this.presetFilterIds = Array.isArray(selected) ? selected : [];

    if (!this.presetFilterIds.length) {
      this.presetFilterModIds = new Set<string>();
      return;
    }

    const presets = await this.untilDestroyed(this.loadoutsState.load());
    const allowed = new Set(this.presetFilterIds);
    const modIds = new Set<string>();
    for (const p of presets as Loadout[]) {
      if (!allowed.has(p.id)) {
        continue;
      }
      for (const modId of p.modIds ?? []) {
        const cleaned = (modId ?? '').trim();
        if (cleaned) {
          modIds.add(cleaned);
        }
      }
    }
    this.presetFilterModIds = modIds;
  }

  async scan(force = false) {
    const folder = (this.modsActions.folderPath ?? '').trim();
    if (!folder) {
      return;
    }
    if (this.loading) {
      this.messageService.add({
        severity: 'info',
        summary: this.transloco.translate('toasts.mods.syncInProgress.summary'),
        detail: this.transloco.translate('toasts.mods.syncInProgress.detail'),
        life: 3000,
        closable: true,
      });
      return;
    }
    if (!force && !(await this.shouldRunFolderAction(this.lastLocalScanFolderKey, folder))) {
      return;
    }
    this.check();

    this.loadingSource = 'local';
    this.loading = true;
    try {
      const result = await this.untilDestroyed(this.modService.scanFolder(folder));

      this.mods = result.summaries
        .map((mod) => ({
          ...mod,
          hidden: !!mod.hidden,
          favorite: !!mod.favorite,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      await this.untilDestroyed(this.store.setItem('pz_mod_folder', folder));
      // Merge any known Workshop metadata into the freshly scanned mods.
      this.mergeWorkshopMetadataIntoMods();
      this.seedCustomTagsFromMods();
      await this.untilDestroyed(this.saveModsToStorage('local'));
      await this.untilDestroyed(this.store.setItem(this.lastLocalScanFolderKey, folder));
      this.applyFilters();
      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.mods.localSyncComplete.summary'),
        detail: this.transloco.translate('toasts.mods.localSyncComplete.detail'),
        life: 5000,
        closable: true,
      });
      await this.untilDestroyed(this.maybeUpdateHonuModsDbAfterSyncs());
    } catch (err: unknown) {
      if (isDestroyedError(err)) throw err;
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.mods.localSyncFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.mods.localSyncFailed.summary'),
        detail,
        life: 10000,
        closable: true,
      });
    } finally {
      this.loading = false;
      this.loadingSource = null;
    }
  }

  private async handleOnboardingFinished(): Promise<void> {
    // The Mods page may have already initialized before onboarding completes,
    // so explicitly re-read the configured folder + kick off the initial scan.
    if (typeof window !== 'undefined' && this.onboardingFinishedListener) {
      window.removeEventListener('pz-onboarding-finished', this.onboardingFinishedListener);
      this.onboardingFinishedListener = null;
    }

    const savedFolder = await this.untilDestroyed(this.store.getItem<string>('pz_mod_folder'));
    if (savedFolder) {
      this.modsActions.folderPath = savedFolder;
      void this.modsActions.checkMusicAvailability(savedFolder);
    }

    const onboardingCompleted =
      (await this.untilDestroyed(this.store.getItem<boolean>('pz_onboarding_completed'))) ?? false;
    if (!onboardingCompleted || !this.modsActions.folderPath) {
      return;
    }

    await this.untilDestroyed(this.scan());

    const onboardingJustFinished =
      (await this.untilDestroyed(this.store.getItem<boolean>('pz_onboarding_just_finished'))) ?? false;
    if (onboardingJustFinished) {
      await this.tryOnboardingWorkshopSync();
    }
  }

  applyFilters(): void {
    const selectedTags = this.tagsService.selectedTags;
    const tagMatchMode = this.tagsService.tagMatchMode;
    const outdatedOnly = this.tagsService.outdatedOnly;
    const hiddenOnly = this.tagsService.hiddenOnly;
    const missingSteamOnly = this.tagsService.missingSteamOnly;
    const hasAdultContentOnly = this.tagsService.hasAdultContentOnly;
    const hasRulesOnly = this.tagsService.hasRulesOnly;
    const favoritedOnly = this.tagsService.favoritedOnly;
    const presetFilterActive = this.presetFilterIds.length > 0;

    const incompatibleWithIds = hasRulesOnly
      ? this.computeIncompatibleWithModIds(this.mods)
      : new Set<string>();

    this.filteredMods = this.mods.filter((mod) => {
      if (presetFilterActive) {
        const modId = (mod.mod_id ?? '').trim();
        if (!modId || !this.presetFilterModIds.has(modId)) {
          return false;
        }
      }

      if (!this.matchesSearch(mod, this.searchKeyword)) {
        return false;
      }

      // Tag-based filtering (if any tags are selected)
      if (selectedTags.length) {
        const modTags = this.tagsService.getTagsForMod(mod.id);
        if (!modTags || modTags.length === 0) {
          return false;
        }
        const hasMatchingTag =
          tagMatchMode === 'all'
            ? selectedTags.every((t) => modTags.includes(t))
            : selectedTags.some((t) => modTags.includes(t));
        if (!hasMatchingTag) {
          return false;
        }
      }

      if (missingSteamOnly) {
        const fileSize = mod.file_size;
        if (typeof fileSize === 'number' && fileSize > 0) {
          return false;
        }
      }

      if (hasAdultContentOnly) {
        if (mod.workshop?.maybe_inappropriate_sex !== true) {
          return false;
        }
      }

      // Outdated mods filter
      if (outdatedOnly) {
        const timeUpdatedRaw = mod.workshop?.time_updated ?? null;
        if (!mod.install_date || timeUpdatedRaw == null) {
          return false;
        }

        const installDate = new Date(mod.install_date);

        let updatedMs: number | null = null;
        if (typeof timeUpdatedRaw === 'number') {
          updatedMs =
            timeUpdatedRaw < 1e12 ? timeUpdatedRaw * 1000 : timeUpdatedRaw;
        } else {
          const numeric = Number(timeUpdatedRaw);
          if (!Number.isNaN(numeric)) {
            updatedMs = numeric < 1e12 ? numeric * 1000 : numeric;
          } else {
            const parsed = new Date(timeUpdatedRaw).getTime();
            updatedMs = Number.isNaN(parsed) ? null : parsed;
          }
        }

        const timeUpdated =
          updatedMs != null ? new Date(updatedMs) : new Date(NaN);

        if (
          isNaN(installDate.getTime()) ||
          isNaN(timeUpdated.getTime()) ||
          !(installDate.getTime() < timeUpdated.getTime())
        ) {
          return false;
        }
      }

      if (hiddenOnly && !mod.hidden) {
        return false;
      }

      if (favoritedOnly && !mod.favorite) {
        return false;
      }

      if (hasRulesOnly) {
        const hasRequiredModValues =
          this.normalizeModRefs([
            ...(mod.dependencies ?? []),
            ...(mod.requires ?? []),
          ]).length > 0;

        const hasLoadAfterValues =
          this.normalizeModRefs(mod.load_after ?? []).length > 0;

        const hasLoadBeforeValues =
          this.normalizeModRefs(mod.load_before ?? []).length > 0;

        const hasIncompatibleValues =
          this.normalizeModRefs(mod.incompatible ?? []).length > 0;

        const hasIncompatibleWithMods = incompatibleWithIds.has(mod.id);

        if (
          !hasRequiredModValues &&
          !hasLoadAfterValues &&
          !hasLoadBeforeValues &&
          !hasIncompatibleValues &&
          !hasIncompatibleWithMods
        ) {
          return false;
        }
      }

      return true;
    });

    this.updateTagCounts(this.filteredMods);
    this.first = 0;
  }

  onSearchChanged(value: string): void {
    this.searchKeyword = value ?? '';
    this.applyFilters();
  }

  private matchesSearch(mod: ModSummary, keyword: string): boolean {
    const needle = (keyword ?? '').trim().toLowerCase();
    if (!needle) {
      return true;
    }

    const name = (mod.name ?? '').toLowerCase();
    const author = this.getAuthorDisplay(mod).toLowerCase();
    const workshopId = (mod.workshop_id ?? '').toLowerCase();
    const installDate = this.formatDateTime(mod.install_date).toLowerCase();
    return (
      name.includes(needle) ||
      author.includes(needle) ||
      workshopId.includes(needle) ||
      installDate.includes(needle)
    );
  }

  private updateTagCounts(mods: ModSummary[]): void {
    const counts: Record<string, number> = {};
    for (const tag of this.tagsService.tagOptions) {
      counts[tag] = 0;
    }

    for (const mod of mods) {
      const tags = this.tagsService.getTagsForMod(mod.id);
      if (!tags || !tags.length) {
        continue;
      }
      for (const tag of tags) {
        counts[tag] = (counts[tag] ?? 0) + 1;
      }
    }

    this.tagsService.setTagCounts(counts);
  }

  private getAuthorDisplay(mod: ModSummary): string {
    const authorRaw = (mod.author ?? '').trim();
    if (authorRaw && authorRaw.toLowerCase() !== 'unknown') {
      return authorRaw;
    }
    const creatorName = (mod.workshop?.creator_name ?? '').trim();
    if (creatorName) {
      return creatorName;
    }
    return authorRaw || 'Unknown';
  }

  private formatDateTime(value: string | number | null | undefined): string {
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

  private computeIncompatibleWithModIds(mods: ModSummary[]): Set<string> {
    const byKey = new Map<string, string>();
    for (const mod of mods ?? []) {
      if (!mod) {
        continue;
      }

      const recordId = (mod.id ?? '').trim();
      if (recordId) {
        byKey.set(recordId.toLowerCase(), mod.id);
      }

      const modId = (mod.mod_id ?? '').trim();
      if (modId) {
        byKey.set(modId.toLowerCase(), mod.id);
      }

      const workshopId = (mod.workshop_id ?? '').trim();
      if (workshopId) {
        byKey.set(workshopId.toLowerCase(), mod.id);
      }
    }

    const incompatibleWith = new Set<string>();
    for (const mod of mods ?? []) {
      if (!mod) {
        continue;
      }

      const incompatibleValues = this.normalizeModRefs(mod.incompatible ?? []);
      for (const raw of incompatibleValues) {
        const targetId = byKey.get(raw.toLowerCase());
        if (targetId) {
          incompatibleWith.add(targetId);
        }
      }
    }

    return incompatibleWith;
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

  onTablePageChange(event: TablePageEvent): void {
    const nextRows = event.rows ?? this.limit;
    const nextFirst = event.first ?? 0;

    if (nextRows !== this.limit) {
      this.limit = nextRows;
      this.first = 0;
      void this.store.setItem(this.itemsPerPageKey, this.limit);
      return;
    }

    this.limit = nextRows;
    this.first = nextFirst;
  }

  async pickFolder() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: this.modsActions.folderPath ?? undefined,
    });

    this.check();

    if (typeof selected === 'string' && selected) {
      const isValid = await this.untilDestroyed(
        invoke<boolean>('validate_pz_workshop_path', { path: selected }),
      );

      if (!isValid) {
        this.messageService.add({
          severity: 'error',
          summary: this.transloco.translate('toasts.mods.invalidDirectory.summary'),
          detail: this.transloco.translate('toasts.mods.invalidDirectory.detail'),
          life: 15000,
          data: { helpUrl: 'https://steamcommunity.com/sharedfiles/filedetails/?id=2694448564' }
        });
        return;
      }

      const previousFolder = this.modsActions.folderPath;
      const onboardingCompleted =
        (await this.store.getItem<boolean>('pz_onboarding_completed')) ?? false;

      this.modsActions.folderPath = selected;
      if (onboardingCompleted) {
        void this.modsActions.checkMusicAvailability(selected);
      } else {
        void this.modsActions.checkMusicAvailability(null);
      }
      await this.untilDestroyed(this.store.setItem('pz_mod_folder', this.modsActions.folderPath));

      // Automatically trigger a local scan when a new folder is selected.
      // Skip if the user re-selected the same folder path.
      if (!previousFolder || previousFolder !== selected) {
        await this.untilDestroyed(this.scan());
      }
    }
  }

  async createNewModListing() {
    // Ensure the latest in-memory mods (including hidden flags)
    // are persisted into pz_mods before exporting.
    await this.untilDestroyed(this.saveModsToStorage());

    const persisted = await this.untilDestroyed(this.modsState.loadPersistedMods());
    const workshopById =
      persisted?.workshop && Object.keys(persisted.workshop).length
        ? persisted.workshop
        : this.workshopMetadataById;

    const sanitizeWorkshop = (workshop: WorkshopMetadata | null | undefined) => {
      if (!workshop) {
        return null;
      }
      return {
        ...workshop,
        file_description: null,
        author: null,
      };
    };

    const exportMods = (persisted?.local ?? this.mods).map((mod) => {
      if (mod.workshop) {
        const fileSize =
          typeof mod.workshop.file_size === 'number'
            ? mod.workshop.file_size
            : mod.file_size ?? null;
        return {
          ...mod,
          workshop: sanitizeWorkshop(mod.workshop),
          file_size: fileSize,
        };
      }

      const workshopId = (mod.workshop_id ?? '').trim();
      const folderId = this.getFolderId(mod);
      const key = workshopId || folderId || '';
      const workshop = key ? workshopById[key] ?? null : null;

      const fileSize =
        typeof workshop?.file_size === 'number'
          ? workshop.file_size
          : mod.file_size ?? null;
      return {
        ...mod,
        workshop: sanitizeWorkshop(workshop),
        file_size: fileSize,
      };
    });

    await invoke('export_store_snapshot', {
      defaultDir: this.modsActions.folderPath || null,
      mods: exportMods,
      browserStorage: null,
      workshop: null,
    });
  }

  onRowExpanded(mod: ModSummary): void {
    // placeholder for future API/web scraper call for this mod
    // e.g., fetch additional details and attach to `mod`
  }

  isNumericId(id: string | undefined | null): boolean {
    if (!id) {
      return false;
    }
    return /^[0-9]+$/.test(id);
  }

  steamWorkshopUrl(id: string | undefined | null): string {
    return `https://steamcommunity.com/sharedfiles/filedetails/?id=${id ?? ''}`;
  }

  async openSteamWorkshop(id: string | undefined | null): Promise<void> {
    if (!this.isNumericId(id)) {
      return;
    }
    const url = this.steamWorkshopUrl(id);
    await openUrl(url);
  }

  async openCreatorWorkshop(url: string | undefined | null): Promise<void> {
    if (!url) {
      return;
    }
    await openUrl(url);
  }

  async openModFolder(mod: ModSummary): Promise<void> {
    if (!mod.mod_info_path) {
      return;
    }

    // Ask the Tauri backend to open the file in Explorer with /select.
    await invoke('open_mod_in_explorer', { path: mod.mod_info_path });
  }

  private async loadWorkshopPreferences(): Promise<void> {
    const stored = await this.store.getItem<boolean>(
      this.workshopAutoFetchKey,
    );
    this.autoWorkshopFetch = !!stored;
  }

  private async saveModsToStorage(source?: 'local' | 'workshop'): Promise<void> {
    await this.modsState.savePersistedMods(
      this.mods,
      this.workshopMetadataById,
      { source },
    );
  }

  private mergeWorkshopMetadataIntoMods(): void {
    if (!this.workshopMetadataById) {
      return;
    }

    this.mods = this.mods.map((mod) => {
      const folderId = this.getFolderId(mod);
      if (!folderId) {
        return mod;
      }

      const meta = this.workshopMetadataById[folderId];
      if (!meta || meta.error) {
        return mod;
      }

      const fileSize =
        typeof meta.file_size === 'number' ? meta.file_size : mod.file_size ?? null;
      return {
        ...mod,
        // Attach full workshop metadata without flattening onto ModSummary
        workshop: meta,
        file_size: fileSize,
      };
    });
  }

  /**
   * Initialize per-mod custom tags and the global tag options list
   * from any workshop tags provided by the data sources.
   */
  private seedCustomTagsFromMods(): void {
    const existingOptions = new Set(this.tagsService.tagOptions);

    for (const mod of this.mods) {
      const workshopTags = mod.workshop?.map_tags ?? [];
      if (!workshopTags.length) {
        continue;
      }

      // If this mod does not yet have stored custom tags, seed them
      // from the workshop tags coming from the data sources.
      const currentCustom = this.tagsService.getTagsForMod(mod.id);
      if (!currentCustom || currentCustom.length === 0) {
        this.tagsService.setTagsForMod(mod.id, workshopTags);
      }

      for (const tag of workshopTags) {
        if (tag && tag.trim().length) {
          existingOptions.add(tag.trim());
        }
      }
    }

    this.tagsService.updateTagOptions(Array.from(existingOptions));
  }

  private async syncWorkshopMetadata(force = false): Promise<void> {
    const folder = (this.modsActions.folderPath ?? '').trim();
    if (!folder) {
      return;
    }
    if (this.loading) {
      this.messageService.add({
        severity: 'info',
        summary: this.transloco.translate('toasts.mods.syncInProgress.summary'),
        detail: this.transloco.translate('toasts.mods.syncInProgress.detail'),
        life: 3000,
        closable: true,
      });
      return;
    }
    if (!force && !(await this.shouldRunFolderAction(this.lastWorkshopSyncFolderKey, folder))) {
      return;
    }

    const ids: string[] = [];

    for (const mod of this.mods) {
      const folderId = this.getFolderId(mod);
      if (folderId) {
        ids.push(folderId);
      }
    }

    if (!ids.length) {
      return;
    }

    // Use unique ids to avoid duplicate API calls and keep status tracking clean.
    const uniqueIds = Array.from(new Set(ids));

    const apiKey = (await this.store.getItem<string>('steam_api_key')) ?? '';

    if (!apiKey.trim()) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.mods.steamApiRequired.summary'),
        detail: this.transloco.translate('toasts.mods.steamApiRequired.detail'),
        life: 10000,
        closable: true,
      });
      return;
    }

    this.loadingSource = 'workshop';
    this.loading = true;
    try {
      const allResults = await this.workshopMetadataService.getBatchMetadata(
        uniqueIds,
      );
      if (this.destroyRef.destroyed) return;

      const metaById: Record<string, WorkshopMetadata> = {};
      const receivedIds: string[] = [];

      for (const item of allResults) {
        if (item && !item.error && typeof item.fileid === 'number') {
          const folderId = String(item.fileid);
          metaById[folderId] = item;
          receivedIds.push(folderId);
        }
      }

      const missing = uniqueIds.filter((id) => !receivedIds.includes(id));

      // If nothing came back, don't write an empty map; keep existing persisted data.
      if (receivedIds.length === 0) {
        this.messageService.add({
          severity: 'warn',
          summary: this.transloco.translate('toasts.mods.workshopNoData.summary'),
          detail: this.transloco.translate('toasts.mods.workshopNoData.detail'),
          life: 8000,
          closable: true,
        });
        return;
      }

      // If some ids are missing, surface that before writing partial data.
      if (missing.length > 0) {
        const missingList = missing.slice(0, 5).join(', ');
        const suffix = missing.length > 5 ? '...' : '';
        this.messageService.add({
          severity: 'warn',
          summary: this.transloco.translate('toasts.mods.workshopPartial.summary'),
          detail: this.transloco.translate('toasts.mods.workshopPartial.detail', {
            received: receivedIds.length,
            total: uniqueIds.length,
            missing: missingList,
            suffix,
          }),
          life: 8000,
          closable: true,
        });
      }

      // Preserve any existing entries, but update with latest results.
      this.workshopMetadataById = {
        ...this.workshopMetadataById,
        ...metaById,
      };

      this.mergeWorkshopMetadataIntoMods();
      await this.saveModsToStorage('workshop');
      await this.store.setItem(this.lastWorkshopSyncFolderKey, folder);

      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.mods.workshopSynced.summary'),
        detail: this.transloco.translate('toasts.mods.workshopSynced.detail'),
        life: 5000,
        closable: true,
      });

      this.applyFilters();
      await this.maybeUpdateHonuModsDbAfterSyncs();
    } catch (err: any) {
      if (err instanceof Error && err.message === 'STEAM_API_UNAUTHORIZED') {
        this.messageService.add({
          severity: 'error',
          summary: this.transloco.translate('toasts.mods.workshopUnauthorized.summary'),
          detail: this.transloco.translate('toasts.mods.workshopUnauthorized.detail'),
          life: 10000,
          closable: true,
        });
      } else {
        const detail =
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : this.transloco.translate('toasts.mods.workshopSyncFailed.detail');
        this.messageService.add({
          severity: 'error',
          summary: this.transloco.translate('toasts.mods.workshopSyncFailed.summary'),
          detail,
          life: 10000,
          closable: true,
        });
      }
    } finally {
      this.loading = false;
      this.loadingSource = null;
    }
  }


  private async shouldRunFolderAction(
    key: string,
    currentFolder: string,
  ): Promise<boolean> {
    const stored = await this.store.getItem<string>(key);
    return (stored ?? '').trim() !== currentFolder;
  }

  private async maybeUpdateHonuModsDbAfterSyncs(): Promise<void> {
    const userDirRaw = (await this.store.getItem<string>('pz_user_dir')) ?? '';
    if (this.destroyRef.destroyed) return;
    const honuDir = this.toHonuModInfoQolDir(userDirRaw);
    if (!honuDir) {
      return;
    }

    const changedAtRaw =
      (await this.store.getItem<string>(this.honuDirChangedAtKey)) ?? '';
    if (this.destroyRef.destroyed) return;
    const changedAt = changedAtRaw.trim();
    if (!changedAt) {
      return;
    }

    const changedMs = Date.parse(changedAt);
    if (!Number.isFinite(changedMs)) {
      return;
    }

    const persisted = await this.modsState.loadPersistedMods();
    if (this.destroyRef.destroyed) return;
    const lastLocal = (persisted?.lastLocalSyncAt ?? '').trim();
    const lastWorkshop = (persisted?.lastWorkshopSyncAt ?? '').trim();
    if (!lastLocal || !lastWorkshop) {
      return;
    }

    const lastLocalMs = Date.parse(lastLocal);
    const lastWorkshopMs = Date.parse(lastWorkshop);
    if (!Number.isFinite(lastLocalMs) || !Number.isFinite(lastWorkshopMs)) {
      return;
    }

    if (lastLocalMs < changedMs || lastWorkshopMs < changedMs) {
      return;
    }

    try {
      await this.honuQol.ensureModsDbFile(honuDir, this.mods);
      if (this.destroyRef.destroyed) return;
      await this.store.setItem(this.honuDirChangedAtKey, '');
    } catch {
      // Keep the pending marker so we can retry after the next syncs.
    }
  }

  private getFolderId(mod: ModSummary): string | null {
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

    const folderId = parts[0];
    if (!this.isNumericId(folderId)) {
      return null;
    }

    return folderId;
  }

  private toHonuModInfoQolDir(userDir: string): string {
    const cleaned = (userDir ?? '').trim().replace(/[\\/]+$/, '');
    if (!cleaned) {
      return '';
    }
    return `${cleaned}/Lua`;
  }

  onModUpdated(updated: ModSummary): void {
    const index = this.mods.findIndex((m) => m.id === updated.id);
    if (index !== -1) {
      this.mods[index] = { ...updated };
      void this.saveModsToStorage();
      this.applyFilters();
    }
  }

  private hasAnyWorkshopMetadata(): boolean {
    if (!this.workshopMetadataById) {
      return false;
    }

    // Treat any non-empty workshop map as "existing" so that we don't
    // prompt the user to scan/sync again if persisted workshop data is
    // already available from Tauri storage.
    for (const key in this.workshopMetadataById) {
      if (Object.prototype.hasOwnProperty.call(this.workshopMetadataById, key)) {
        return true;
      }
    }

    return false;
  }

  async onWorkshopPromptConfirm(): Promise<void> {
    this.showWorkshopPrompt = false;
    await this.syncWorkshopMetadata();
  }

  onWorkshopPromptCancel(): void {
    this.showWorkshopPrompt = false;
  }

  async onAutoWorkshopToggleChange(value: boolean): Promise<void> {
    this.autoWorkshopFetch = !!value;
    await this.store.setItem(this.workshopAutoFetchKey, this.autoWorkshopFetch);
  }

  async onHelpLinkClick(url: string) {
    await openUrl(url);
  }
}

