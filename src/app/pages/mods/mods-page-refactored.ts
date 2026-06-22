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
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { invoke } from '@tauri-apps/api/core';
import { ModsTagsService } from '../../services/mods-tags.service';
import { WorkshopMetadataService } from '../../services/workshop-metadata.service';
import { ModsStateService } from '../../services/mods-state.service';
import { LoadoutsStateService } from '../../services/loadouts-state.service';
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
import { profileAsync, profileSync } from '../../utils/perf-trace';
import { SteamApiKeyService } from '../../services/steam-api-key.service';

// Modularized components
import { ModsPageActions } from './actions/mods-page-actions';
import { ModsPageFilter } from './filters/mods-page-filter';
import { ModsPageWorkshopMetadata } from './workshop/mods-page-workshop-metadata';
import { ModsPagePersistence } from './persistence/mods-page-persistence';
import { ModsPageUtils } from './utils/mods-page-utils';

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
  showWorkshopPrompt = false;
  autoWorkshopFetch = false;

  // Modularized components
  private readonly actions: ModsPageActions;
  private readonly filter: ModsPageFilter;
  private readonly workshopMetadata: ModsPageWorkshopMetadata;
  private readonly persistence: ModsPagePersistence;

  constructor(
    private readonly modService: ModService,
    private readonly tagsService: ModsTagsService,
    private readonly workshopMetadataService: WorkshopMetadataService,
    private readonly modsState: ModsStateService,
    private readonly loadoutsState: LoadoutsStateService,
    private readonly honuQol: HonuModInfoQolService,
    private readonly localization: LocalizationService,
    private readonly transloco: TranslocoService,
    private readonly steamApiKeyService: SteamApiKeyService,
  ) {
    super();

    // Initialize modularized components
    this.actions = new ModsPageActions(this.messageService, transloco, localization);
    this.filter = new ModsPageFilter(tagsService, loadoutsState);
    this.workshopMetadata = new ModsPageWorkshopMetadata();
    this.persistence = new ModsPagePersistence(modsState, this.store);
  }

  async ngOnInit(): Promise<void> {
    await profileAsync('mods.ngOnInit', async () => {
      try {
        await this.initializeFromStorage();
        await this.setupEventListeners();
        await this.setupSubscriptions();
        await this.applyInitialFilters();
      } catch (err) {
        if (isDestroyedError(err)) return;
        throw err;
      } finally {
        if (!this.destroyRef.destroyed) {
          this.contentLoading.markReady();
        }
      }
    });
  }

  private async initializeFromStorage(): Promise<void> {
    const bootstrap = await this.store.getItems([
      'pz_onboarding_completed',
      'pz_onboarding_just_finished',
      'pz_mods_items_per_page',
      'pz_mod_folder',
    ]);

    const persistedLimit = bootstrap['pz_mods_items_per_page'] as number | null;
    const savedFolder = bootstrap['pz_mod_folder'] as string | null;
    const onboardingCompleted = bootstrap['pz_onboarding_completed'] ?? false;

    if (persistedLimit && this.limitOptions.includes(persistedLimit)) {
      this.limit = persistedLimit;
    }

    if (savedFolder) {
      this.modsActions.folderPath = savedFolder;
      await this.checkMusicAvailability(savedFolder);
    }

    const persisted = await this.untilDestroyed(this.modsState.loadPersistedMods());
    if (persisted) {
      this.mods = persisted.local;
      this.workshopMetadata.mergeMetadata(persisted.workshop ?? {});
      this.applyFilters();
    } else if (onboardingCompleted && savedFolder) {
      await this.untilDestroyed(this.scan());
    }
  }

  private async setupEventListeners(): Promise<void> {
    // Event listeners for page lifecycle
    if (typeof window !== 'undefined') {
      window.addEventListener('pz-onboarding-finished', this.handleOnboardingFinished);
      window.addEventListener('pz-preset-filter-changed', this.onPresetFilterChanged);
    }
  }

  private async setupSubscriptions(): Promise<void> {
    // Setup reactive subscriptions
    this.modsActions.browseFolder$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.pickFolder());

    this.modsActions.scan$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.scan(true));

    this.modsActions.syncWorkshop$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.syncWorkshopMetadata(true));

    this.tagsService.selectedTags$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyFilters());
  }

  async ngOnDestroy(): Promise<void> {
    // Cleanup event listeners
    if (typeof window !== 'undefined') {
      window.removeEventListener('pz-onboarding-finished', this.handleOnboardingFinished);
      window.removeEventListener('pz-preset-filter-changed', this.onPresetFilterChanged);
    }

    // Persist state on destroy
    await this.persistence.saveModsToStorage(undefined, true);
  }

  // Public API methods - these are the main entry points for the component

  async scan(force = false): Promise<void> {
    void force;
    this.mods = await this.actions.scan(
      this.mods,
      this.modsActions.folderPath,
      this.modService,
      this.store,
      (mods, source) =>
        this.modsState.savePersistedMods(
          mods,
          this.workshopMetadata.getMetadata(),
          { source },
        ),
    );
    this.applyFilters();
  }

  async syncWorkshopMetadata(force = false): Promise<void> {
    void force;
    await this.actions.syncWorkshopMetadata(
      this.mods,
      this.workshopMetadataService,
      this.modsActions,
      this.store,
      this.steamApiKeyService,
    );
  }

  async pickFolder(): Promise<void> {
    await this.actions.pickFolder(
      openDialog,
      this.modsActions,
      this.store,
      () => this.scan(),
    );
  }

  applyFilters(): void {
    profileSync('mods.applyFilters', () => {
      this.filteredMods = this.filter.applyFilters(
        this.mods,
        this.searchKeyword,
        this.tagsService,
      );
      this.updateTagCounts(this.filteredMods);
      this.first = 0;
    });
  }

  async onPresetFilterChanged(): Promise<void> {
    await this.filter.refreshPresetFilterCache();
    this.applyFilters();
  }

  // Additional helper methods that were extracted from the main component

  onSearchChanged(value: string): void {
    this.searchKeyword = value ?? '';
    this.applyFilters();
  }

  onTablePageChange(event: TablePageEvent): void {
    const nextRows = event.rows ?? this.limit;
    if (nextRows !== this.limit) {
      this.limit = nextRows;
      this.first = 0;
      void this.persistence.persistItemsPerPage(this.limit);
      return;
    }
    this.limit = nextRows;
    const nextFirst = event.first ?? 0;
    this.first = nextFirst;
  }

  onModUpdated(updated: ModSummary): void {
    const index = this.mods.findIndex((m) => m.id === updated.id);
    if (index !== -1) {
      this.mods[index] = { ...updated };
      void this.persistence.saveModsToStorage();
      this.applyFilters();
    }
  }

  async onWorkshopPromptConfirm(): Promise<void> {
    this.showWorkshopPrompt = false;
    await this.syncWorkshopMetadata();
  }

  onWorkshopPromptCancel(): void {
    this.showWorkshopPrompt = false;
  }

  // Helper methods for UI interaction
  isNumericId(id: string | undefined | null): boolean {
    return ModsPageUtils.isNumericId(id);
  }

  steamWorkshopUrl(id: string | undefined | null): string {
    return ModsPageUtils.steamWorkshopUrl(id);
  }

  async openSteamWorkshop(id: string | undefined | null): Promise<void> {
    if (!this.isNumericId(id)) return;
    await openUrl(this.steamWorkshopUrl(id));
  }

  async openCreatorWorkshop(url: string | undefined | null): Promise<void> {
    if (url) await openUrl(url);
  }

  async onHelpLinkClick(url: string): Promise<void> {
    await openUrl(url);
  }

  async onAutoWorkshopToggleChange(value: boolean): Promise<void> {
    this.autoWorkshopFetch = !!value;
    await this.persistence.persistWorkshopAutoFetch(this.autoWorkshopFetch);
  }

  onRowExpanded(mod: ModSummary): void {
    void mod;
  }

  async openModFolder(mod: ModSummary): Promise<void> {
    if (mod.mod_info_path) {
      await invoke('open_mod_in_explorer', { path: mod.mod_info_path });
    }
  }

  private async checkMusicAvailability(path: string | null): Promise<void> {
    try {
      const hasOgg = await invoke<boolean>('has_ogg_files', { path });
      // Update UI state
    } catch (err) {
      console.error('Failed to check for OGG files:', err);
    }
  }

  private async handleOnboardingFinished(): Promise<void> {
    // Implementation for handling onboarding completion
  }

  private updateTagCounts(mods: ModSummary[]): void {
    // Implementation for updating tag counts
  }

  private async applyInitialFilters(): Promise<void> {
    // Apply filters after initial load
    this.applyFilters();
  }

  private async saveModsToStorage(source?: 'local' | 'workshop'): Promise<void> {
    await this.persistence.saveModsToStorage(source);
  }

  // Helper methods for Workshop metadata operations
  private mergeWorkshopMetadataIntoMods(): void {
    this.mods = this.workshopMetadata.mergeWorkshopMetadataIntoMods(this.mods);
  }

  get loadingSource(): 'local' | 'workshop' | null {
    return this.actions.source;
  }
}
