import { Component, DestroyRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { MenuItem } from 'primeng/api';
import type { OverlayListenerOptions, OverlayOptions } from 'primeng/api';
import { invoke } from '@tauri-apps/api/core';
import { AppMenuitem } from './app.menuitem';
import { filter, take } from 'rxjs';
import { ModTagFilterComponent } from '../../components/mod-tag-filter/mod-tag-filter.component';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';
import { ModsTagsService } from '../../services/mods-tags.service';
import { ModsActionsService } from '../../services/mods-actions.service';
import { TauriStoreService } from '../../services/tauri-store.service';
import { ModsStateService } from '../../services/mods-state.service';
import { LoadoutsStateService } from '../../services/loadouts-state.service';
import type { Loadout } from '../../models/loadout.models';
import type { ModSummary } from '../../models/mod.models';
import {
  RequiredFoldersComponent,
  RequiredFoldersDraft,
} from '../../components/required-folders/required-folders.component';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';
import { AccordionModule } from 'primeng/accordion';
import { ImageModule } from 'primeng/image';
import { MultiSelectModule } from 'primeng/multiselect';
import { TooltipModule } from 'primeng/tooltip';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HonuModInfoQolService } from '../../services/honu-mod-info-qol.service';
import { MessageService } from 'primeng/api';
import { ToastModule } from 'primeng/toast';
import { PzDefaultPathsService } from '../../services/pz-default-paths.service';
import { SelectModule } from 'primeng/select';
import { ProgressBarModule } from 'primeng/progressbar';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import {
  ModCollectionFiltersService,
  ModCollectionSort,
  ModCollectionTagOption,
} from '../../services/mod-collection-filters.service';
import { LocalizationService } from '../../services/localization.service';
import { LOCALE_OPTIONS } from '../../i18n/locales';

@Component({
  selector: 'app-menu',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AppMenuitem,
    RouterModule,
    ModTagFilterComponent,
    ToggleSwitchModule,
    DialogModule,
    InputTextModule,
    ButtonModule,
    CardModule,
    PanelModule,
    AccordionModule,
    ImageModule,
    MultiSelectModule,
    SelectModule,
    ProgressBarModule,
    TooltipModule,
    ToastModule,
    RequiredFoldersComponent,
    TranslocoModule,
  ],
  templateUrl: './app.menu.html',
  providers: [MessageService],
})
export class AppMenu {
  model: MenuItem[] = [];

  private isModsPage = false;
  private isCollectionsPage = false;
  steamApiKeyDialogVisible = false;
  steamApiKeyHelpDialogVisible = false;
  steamApiKey = '';
  foldersDialogVisible = false;
  foldersDraft: RequiredFoldersDraft | null = null;

  presetOptions: Array<{ label: string; value: string }> = [];
  selectedPresetIds: string[] = [];
  inPresetDisabled = true;
  inPresetTooltip =
    'Set your Project Zomboid user folder and/or define presets first.';
  readonly presetOverlayOptions: OverlayOptions = {
    hideOnEscape: true,
    listener: (_event: Event, options?: OverlayListenerOptions) => options?.valid,
  };
  private readonly presetFilterKey = 'pz_filter_in_preset_ids';
  private presetsUpdatedListener: (() => void) | null = null;

  collectionSearchText = '';
  collectionSort: ModCollectionSort = 'trend';
  collectionPeriod = 7;
  collectionTagOptions: ModCollectionTagOption[] = [];
  collectionTags: string[] = [];

  collectionSortOptions = [
    { label: 'Most Popular', value: 'trend' },
    { label: 'Most Recent', value: 'mostrecent' },
    { label: 'Last Updated', value: 'lastupdated' },
  ];
  collectionPeriodOptions = [
    { label: 'Today', value: 1 },
    { label: 'One Week', value: 7 },
    { label: 'Thirty Days', value: 30 },
    { label: 'Three Months', value: 90 },
    { label: 'Six Months', value: 180 },
    { label: 'One Year', value: 365 },
  ];
  localeOptions = LOCALE_OPTIONS;
  selectedLocale = 'en-US';
  localeLoading = false;
  private readonly loadedTranslations = new Set<string>();

  constructor(
    private readonly router: Router,
    private readonly modsActions: ModsActionsService,
    private readonly store: TauriStoreService,
    public readonly tagsService: ModsTagsService,
    private readonly loadoutsState: LoadoutsStateService,
    private readonly modsState: ModsStateService,
    private readonly destroyRef: DestroyRef,
    private readonly honuQol: HonuModInfoQolService,
    private readonly messageService: MessageService,
    private readonly pzDefaults: PzDefaultPathsService,
    private readonly collectionFilters: ModCollectionFiltersService,
    private readonly localization: LocalizationService,
    private readonly transloco: TranslocoService,
  ) {
    this.refreshPresetFilterCopy();
    this.refreshCollectionLabels();
    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        const nav = event as NavigationEnd;
        this.isModsPage =
          nav.urlAfterRedirects === '/' || nav.urlAfterRedirects === '';
        this.isCollectionsPage = nav.urlAfterRedirects.startsWith('/collections');
        this.updateMenuTranslations();
        if (this.isModsPage) {
          void this.refreshPresetFilterOptions();
        }
      });

    this.collectionFilters.filters$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((filters) => {
        this.collectionSearchText = filters.searchText;
        this.collectionSort = filters.sort;
        this.collectionPeriod = filters.days;
        this.collectionTags = filters.tags;
      });

    this.collectionFilters.tagOptions$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((options) => {
        this.collectionTagOptions = options;
      });

    this.localization.locale$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((locale) => {
        this.selectedLocale = locale;
      });

    this.localization.localeLoading$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((loading) => {
        this.localeLoading = loading;
      });

    this.transloco.langChanges$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.updateMenuTranslations();
      });
  }

  ngOnInit() {
    const url = this.router.url;
    this.isModsPage = url === '/' || url === '';
    this.isCollectionsPage = url.startsWith('/collections');
    this.updateMenuTranslations();
    void this.loadSteamApiKey();
    void this.ensureHonuModsDbFile();
    if (this.isModsPage) {
      void this.refreshPresetFilterOptions();
    }
    if (typeof window !== 'undefined') {
      this.presetsUpdatedListener = () => {
        if (this.isModsPage) {
          void this.refreshPresetFilterOptions();
        }
      };
      window.addEventListener('pz-presets-updated', this.presetsUpdatedListener);
    }
  }

  ngOnDestroy() {
    if (typeof window !== 'undefined' && this.presetsUpdatedListener) {
      window.removeEventListener('pz-presets-updated', this.presetsUpdatedListener);
      this.presetsUpdatedListener = null;
    }
  }

  private async ensureHonuModsDbFile(): Promise<void> {
    const storedHonu =
      (await this.store.getItem<string>('pz_honu_mod_info_qol_dir')) ?? '';
    const storedUser = (await this.store.getItem<string>('pz_user_dir')) ?? '';
    const baseDir = storedHonu.trim() || this.toHonuModInfoQolDir(storedUser);
    const trimmedBase = baseDir.trim();
    if (!trimmedBase) {
      return;
    }

    const filePath = `${trimmedBase.replace(/[\\/]+$/, '')}/honus_miqol_db.lua`;
    try {
      await invoke<string>('read_text_file', { path: filePath });
      return;
    } catch {
      // File missing or unreadable; attempt to create a minimal DB file.
    }

    let mods: ModSummary[] = [];
    try {
      const persisted = await this.modsState.loadPersistedMods();
      mods = persisted?.local ?? [];
    } catch {
      mods = [];
    }

    try {
      await this.honuQol.ensureModsDbFile(trimmedBase, mods);
    } catch {
      // Ignore failures; the sync action will surface errors to the user.
    }
  }

  onOutdatedToggleChange(value: boolean): void {
    this.tagsService.setOutdatedOnly(value);
  }

  onMissingSteamToggleChange(value: boolean): void {
    this.tagsService.setMissingSteamOnly(value);
  }

  onHasRulesToggleChange(value: boolean): void {
    this.tagsService.setHasRulesOnly(value);
  }

  onHasAdultContentToggleChange(value: boolean): void {
    this.tagsService.setHasAdultContentOnly(value);
  }

  onCollectionSearchChange(value: string): void {
    this.collectionFilters.updateFilters({ searchText: value ?? '' });
  }

  onCollectionSortChange(value: ModCollectionSort): void {
    this.collectionFilters.updateFilters({
      sort: value,
    });
  }

  onCollectionPeriodChange(value: number): void {
    this.collectionFilters.updateFilters({ days: Number(value) || 7 });
  }

  onCollectionTagsChange(values: string[]): void {
    this.collectionFilters.updateFilters({
      tags: Array.isArray(values) ? values : [],
    });
  }

  onLocaleChange(value: string): void {
    void this.localization.setLocale(value);
  }


  async onResetPersistence(): Promise<void> {
    await this.store.clearAll();
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }

  async loadSteamApiKey(): Promise<void> {
    const stored = await this.store.getItem<string>('steam_api_key');
    this.steamApiKey = (stored ?? '').toString();
  }

  async openFoldersDialog(): Promise<void> {
    const storedGame = await this.store.getItem<string>('pz_game_dir');
    const storedWorkshop = await this.store.getItem<string>('pz_mod_folder');
    const storedUserDir = await this.store.getItem<string>('pz_user_dir');

    const defaults = {
      pzGameDir: await this.pzDefaults.getDefaultGameDir(),
      pzWorkshopDir: await this.pzDefaults.getDefaultWorkshopDir(),
      pzUserDir: '',
    };
    this.foldersDraft = {
      pzGameDir: (storedGame ?? '').trim() || defaults.pzGameDir,
      pzWorkshopDir: (storedWorkshop ?? '').trim() || defaults.pzWorkshopDir,
      pzUserDir: (storedUserDir ?? '').trim() || defaults.pzUserDir,
    };

    this.foldersDialogVisible = true;
  }

  async onSaveFolders(): Promise<void> {
    if (!this.foldersDraft) {
      return;
    }

    const previousWorkshop =
      (await this.store.getItem<string>('pz_mod_folder')) ?? '';
    const previousHonu =
      (await this.store.getItem<string>('pz_honu_mod_info_qol_dir')) ?? '';

    const nextWorkshop = this.foldersDraft.pzWorkshopDir.trim();
    const nextHonu = this.toHonuModInfoQolDir(this.foldersDraft.pzUserDir);

    await this.store.setItem('pz_game_dir', this.foldersDraft.pzGameDir.trim());
    await this.store.setItem('pz_mod_folder', nextWorkshop);
    await this.store.setItem(
      'pz_honu_mod_info_qol_dir',
      nextHonu,
    );
    await this.store.setItem('pz_user_dir', this.foldersDraft.pzUserDir.trim());

    const workshopChanged = previousWorkshop.trim() !== nextWorkshop;
    const honuChanged = previousHonu.trim() !== nextHonu;

    if (honuChanged) {
      await this.store.setItem(
        'pz_honu_mod_info_qol_dir_changed_at',
        new Date().toISOString(),
      );
    }

    this.modsActions.folderPath = nextWorkshop;
    this.foldersDialogVisible = false;

    if (workshopChanged) {
      this.modsActions.triggerScan();
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('pz-presets-updated'));
    }
  }

  private refreshPresetFilterCopy(): void {
    this.inPresetTooltip = this.transloco.translate('menu.presetsUnavailable');
  }

  private refreshCollectionLabels(): void {
    this.collectionSortOptions = [
      {
        label: this.transloco.translate('menu.collections.sortMostPopular'),
        value: 'trend',
      },
      {
        label: this.transloco.translate('menu.collections.sortMostRecent'),
        value: 'mostrecent',
      },
      {
        label: this.transloco.translate('menu.collections.sortLastUpdated'),
        value: 'lastupdated',
      },
    ];
    this.collectionPeriodOptions = [
      { label: this.transloco.translate('menu.collections.periodToday'), value: 1 },
      { label: this.transloco.translate('menu.collections.periodWeek'), value: 7 },
      { label: this.transloco.translate('menu.collections.periodThirtyDays'), value: 30 },
      { label: this.transloco.translate('menu.collections.periodThreeMonths'), value: 90 },
      { label: this.transloco.translate('menu.collections.periodSixMonths'), value: 180 },
      { label: this.transloco.translate('menu.collections.periodYear'), value: 365 },
    ];
  }

  private updateMenuTranslations(): void {
    const lang = this.transloco.getActiveLang() || 'en-US';
    if (this.loadedTranslations.has(lang)) {
      this.refreshPresetFilterCopy();
      this.refreshCollectionLabels();
      this.buildModel();
      return;
    }
    this.transloco
      .selectTranslation(lang)
      .pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.loadedTranslations.add(lang);
        this.refreshPresetFilterCopy();
        this.refreshCollectionLabels();
        this.buildModel();
      });
  }

  private async refreshPresetFilterOptions(): Promise<void> {
    const stored = await this.store.getItem<string[]>(this.presetFilterKey);
    this.selectedPresetIds = Array.isArray(stored) ? stored : [];

    const presets = await this.loadoutsState.load();
    this.presetOptions = presets
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p: Loadout) => ({
        label: `${p.name} (${p.modIds?.length ?? 0})`,
        value: p.id,
      }));

    this.inPresetDisabled = this.presetOptions.length === 0;
    this.inPresetTooltip = this.inPresetDisabled
      ? this.transloco.translate('menu.presetsUnavailable')
      : '';

    // Drop any selections that no longer exist.
    const allowed = new Set(this.presetOptions.map((o) => o.value));
    const nextSelected = (this.selectedPresetIds ?? []).filter((id) =>
      allowed.has(id),
    );
    if (nextSelected.length !== (this.selectedPresetIds ?? []).length) {
      this.selectedPresetIds = nextSelected;
      await this.store.setItem(this.presetFilterKey, nextSelected);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('pz-preset-filter-changed'));
      }
    }
  }

  async onPresetFilterChange(): Promise<void> {
    const cleaned = Array.from(
      new Set((this.selectedPresetIds ?? []).map((s) => (s ?? '').trim())),
    ).filter((s) => s.length > 0);
    await this.store.setItem(this.presetFilterKey, cleaned);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('pz-preset-filter-changed'));
    }
  }


  onOpenSteamApiKeyDialog(): void {
    void this.loadSteamApiKey();
    this.steamApiKeyDialogVisible = true;
  }

  onOpenSteamApiHelp(): void {
    this.steamApiKeyHelpDialogVisible = true;
  }

  async onSaveSteamApiKey(): Promise<void> {
    const value = this.steamApiKey.trim();
    await this.store.setItem('steam_api_key', value);
    this.steamApiKeyDialogVisible = false;
  }

  private mergeWorkshopIntoMods(
    mods: ModSummary[],
    workshop: Record<string, any>,
  ): ModSummary[] {
    if (!mods.length || !workshop || !Object.keys(workshop).length) {
      return mods;
    }

    return mods.map((mod) => {
      if (mod.workshop) {
        return mod;
      }

      const workshopId = (mod.workshop_id ?? '').trim();
      if (!workshopId) {
        return mod;
      }

      const meta = workshop[workshopId];
      if (!meta || meta.error) {
        return mod;
      }

      return { ...mod, workshop: meta };
    });
  }

  private async loadModsForHonuSync(): Promise<ModSummary[]> {
    const persisted = await this.modsState.loadPersistedMods();
    if (!persisted?.local?.length) {
      return [];
    }

    return this.mergeWorkshopIntoMods(
      persisted.local,
      persisted.workshop ?? {},
    );
  }

  async onSyncHonuModInfoQol(): Promise<void> {
    const userDir = (await this.store.getItem<string>('pz_user_dir')) ?? '';
    const trimmed = this.toHonuModInfoQolDir(userDir);
    if (!trimmed) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.menu.honuSync.failedSummary'),
        detail: this.transloco.translate('toasts.menu.honuSync.missingUserDetail'),
        life: 8000,
        closable: true,
      });
      return;
    }
    try {
      const mods = await this.loadModsForHonuSync();
      const result = await this.honuQol.ensureModsDbFile(trimmed, mods);
      if (result) {
        this.messageService.add({
          severity: 'success',
          summary: this.transloco.translate('toasts.menu.honuSync.successSummary'),
          detail: this.transloco.translate(
            result.created
              ? 'toasts.menu.honuSync.successCreatedDetail'
              : 'toasts.menu.honuSync.successUpdatedDetail',
          ),
          life: 5000,
          closable: true,
        });
      }
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.menu.honuSync.failedDetail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.menu.honuSync.failedSummary'),
        detail,
        life: 8000,
        closable: true,
      });
    }
  }

  private buildModel() {
    this.model = [
      {
        label: this.transloco.translate('menu.sections.hub'),
        items: [
          // {
          //   label: 'Characters',
          //   icon: 'pi pi-fw pi-users',
          //   routerLink: ['/characters'],
          // },
          {
            label: this.transloco.translate('menu.items.dashboard'),
            icon: 'pi pi-fw pi-chart-bar',
            routerLink: ['/dashboard'],
          },
          {
            label: this.transloco.translate('menu.items.logInspector'),
            icon: 'pi pi-fw pi-file',
            routerLink: ['/log-inspector'],
          },
          // { label: 'Mod Collections', icon: 'pi pi-fw pi-th-large', routerLink: ['/collections'] },
          // { label: 'Mod Presets', icon: 'pi pi-fw pi-list', routerLink: ['/loadouts'] },
          {
            label: this.transloco.translate('menu.items.myMods'),
            icon: 'pi pi-fw pi-table',
            routerLink: ['/'],
          },
          {
            label: this.transloco.translate('menu.items.server'),
            icon: 'pi pi-fw pi-server',
            routerLink: ['/server'],
          },
        ],
      },
      ...(this.isModsPage
        ? [
          {
            label: this.transloco.translate('menu.sections.modFilters'),
            id: 'mod-filters',
            items: [],
          } as MenuItem,
        ]
        : []),
      ...(this.isCollectionsPage
        ? [
          {
            label: this.transloco.translate('menu.sections.modCollectionFilters'),
            id: 'collection-filters',
            items: [],
          } as MenuItem,
        ]
        : []),
      ...(this.isModsPage
        ? [
          {
            label: this.transloco.translate('menu.sections.actions'),
            items: [
              // {
              //   label: 'Save Mod Listing',
              //   icon: 'pi pi-fw pi-file-plus',
              //   command: () => this.modsActions.triggerCreateFile(),
              // },
              {
                label: this.transloco.translate('menu.items.configureFolders'),
                icon: 'pi pi-fw pi-folder-open',
                command: () => void this.openFoldersDialog(),
              },
              {
                label: this.transloco.translate('menu.items.setSteamApiKey'),
                icon: 'pi pi-fw pi-key',
                command: () => this.onOpenSteamApiKeyDialog(),
              },
              {
                label: this.transloco.translate('menu.items.syncHonu'),
                icon: 'pi pi-fw pi-sync',
                command: () => void this.onSyncHonuModInfoQol(),
              },
              {
                label: this.transloco.translate('menu.items.syncLocal'),
                icon: 'pi pi-fw pi-refresh',
                command: () => this.modsActions.triggerScan(),
              },
              {
                label: this.transloco.translate('menu.items.syncWorkshop'),
                icon: 'pi pi-fw icon-steam2',
                command: () => this.modsActions.triggerSyncWorkshop(),
              },
            ],
          } as MenuItem,
        ]
        : []),
      {
        label: this.transloco.translate('menu.sections.getStarted'),
        items: [
          {
            label: this.transloco.translate('menu.items.changelog'),
            icon: 'pi pi-fw pi-history',
            routerLink: ['/changelog'],
          },
          {
            label: this.transloco.translate('menu.items.documentation'),
            icon: 'pi pi-fw pi-book',
            routerLink: ['/documentation'],
          },
          {
            label: this.transloco.translate('menu.items.viewSource'),
            icon: 'pi pi-fw pi-github',
            url: 'https://github.com/HonuInTheSea/pz-honus-hub',
            target: '_blank',
          },
        ],
      },
      {
        label: this.transloco.translate('menu.sections.resources'),
        items: [
          {
            label: this.transloco.translate('menu.items.projectZomboid'),
            icon: 'pi pi-fw pi-external-link',
            url: 'https://projectzomboid.com/',
            target: '_blank',
          },
          {
            label: this.transloco.translate('menu.items.pzWiki'),
            icon: 'pi pi-fw pi-external-link',
            url: 'https://pzwiki.net/wiki/Project_Zomboid_Wiki',
            target: '_blank',
          },
          {
            label: this.transloco.translate('menu.items.b41Map'),
            icon: 'pi pi-fw pi-map-marker',
            url: 'https://map.projectzomboid.com/',
            target: '_blank',
          },
          {
            label: this.transloco.translate('menu.items.b42Map'),
            icon: 'pi pi-fw pi-map-marker',
            url: 'https://b42map.com/',
            target: '_blank',
          },
          {
            label: this.transloco.translate('menu.items.workshop'),
            icon: 'pi pi-fw icon-steam2',
            url: 'https://steamcommunity.com/app/108600/workshop/',
            target: '_blank',
          },
          {
            label: this.transloco.translate('menu.items.subreddit'),
            icon: 'pi pi-fw pi-reddit',
            url: 'https://www.reddit.com/r/projectzomboid/',
            target: '_blank',
          },
          {
            label: this.transloco.translate('menu.items.discord'),
            icon: 'pi pi-fw pi-discord',
            url: 'https://discord.gg/qj2XbVPaBR',
            target: '_blank',
          },
          {
            label: this.transloco.translate('menu.items.moddingDiscord'),
            icon: 'pi pi-fw pi-discord',
            url: 'https://discord.gg/qj2XbVPaBR',
            target: '_blank',
          },
          {
            label: this.transloco.translate('menu.items.mappingDiscord'),
            icon: 'pi pi-fw pi-discord',
            url: 'https://discord.gg/qj2XbVPaBR',
            target: '_blank',
          },
          {
            label: this.transloco.translate('menu.items.honuWorkshop'),
            icon: 'pi pi-fw icon-steam2',
            url: 'https://steamcommunity.com/id/HonuInTheSea/myworkshopfiles/',
            target: '_blank',
          },
          {
            label: this.transloco.translate('menu.items.supportKofi'),
            url: 'https://ko-fi.com/honuinthesea',
            target: '_blank',
            image: 'assets/ko-fi.png',
            styleClass: 'mt-2 menu-image-item',
          },
        ],
      },
      {
        label: this.transloco.translate('menu.sections.dangerZone'),
        items: [
          {
            label: this.transloco.translate('menu.items.resetApp'),
            icon: 'pi pi-fw pi-trash',
            // visually emphasize this as a dangerous action and pin it
            styleClass: 'p-button-danger',
            badgeClass: 'reset-application-item',
            tooltip: this.transloco.translate('menu.items.resetAppTooltip'),
            tooltipPosition: 'right',
            command: () => {
              void this.onResetPersistence();
            },
          },
        ],
      },
    ];
  }

  private toHonuModInfoQolDir(userDir: string): string {
    const cleaned = (userDir ?? '').trim().replace(/[\\/]+$/, '');
    if (!cleaned) {
      return '';
    }
    return `${cleaned}/Lua`;
  }
}
