import { ModsStateService } from '../../../services/mods-state.service';

/**
 * Handles persistence operations:
 * - Debounced saves
 * - State management
 * - Storage operations
 */
export class ModsPagePersistence {
  private readonly persistDebounceMs = 150;
  private persistTimer: number | null = null;
  private pendingPersistResolvers: Array<() => void> = [];
  private pendingPersistRejectors: Array<(reason?: unknown) => void> = [];

  constructor(
    private readonly modsState: ModsStateService,
    private readonly store: {
      getItem<T>(key: string): Promise<T | null>;
      setItem<T>(key: string, value: T): Promise<void>;
    },
  ) {}

  async saveModsToStorage(
    source?: 'local' | 'workshop',
    immediate = false,
  ): Promise<void> {
    if (immediate) {
      this.cancelPendingSaves();
      return this.performSave(source);
    }

    return this.queueDebouncedSave(source);
  }

  async persistFolderSelection(folderPath: string | null): Promise<void> {
    if (folderPath) {
      await this.store.setItem('pz_mod_folder', folderPath);
    }
  }

  async persistPresetFilterIds(ids: string[]): Promise<void> {
    await this.store.setItem('pz_filter_in_preset_ids', ids);
  }

  async persistWorkshopAutoFetch(enabled: boolean): Promise<void> {
    await this.store.setItem('pz_workshop_auto_fetch', enabled);
  }

  async persistItemsPerPage(limit: number): Promise<void> {
    await this.store.setItem('pz_mods_items_per_page', limit);
  }

  async getFolderFromStorage(): Promise<string | null> {
    return this.store.getItem<string>('pz_mod_folder');
  }

  async getItemsPerPage(): Promise<number | null> {
    return this.store.getItem<number>('pz_mods_items_per_page');
  }

  async getWorkshopAutoFetch(): Promise<boolean | null> {
    return this.store.getItem<boolean>('pz_workshop_auto_fetch');
  }

  async getPresetFilterIds(): Promise<string[]> {
    const selected = await this.store.getItem<string[]>(this.getPresetFilterKey());
    return Array.isArray(selected) ? selected : [];
  }

  private async performSave(source?: 'local' | 'workshop'): Promise<void> {
    try {
      await this.modsState.savePersistedMods([], {}, { source });
      this.resolvePendingPromises();
    } catch (err) {
      this.rejectPendingPromises(err);
      throw err;
    }
  }

  private queueDebouncedSave(source?: 'local' | 'workshop'): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingPersistResolvers.push(resolve);
      this.pendingPersistRejectors.push(reject);

      if (this.persistTimer != null) {
        return;
      }

      this.persistTimer = window.setTimeout(async () => {
        this.persistTimer = null;
        await this.performSave(source);
      }, this.persistDebounceMs);
    });
  }

  private cancelPendingSaves(): void {
    if (this.persistTimer != null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  private resolvePendingPromises(): void {
    for (const resolver of this.pendingPersistResolvers) {
      resolver();
    }
    this.pendingPersistResolvers = [];
    this.pendingPersistRejectors = [];
  }

  private rejectPendingPromises(reason?: unknown): void {
    for (const rejector of this.pendingPersistRejectors) {
      rejector(reason);
    }
    this.pendingPersistResolvers = [];
    this.pendingPersistRejectors = [];
  }

  private getPresetFilterKey(): string {
    return 'pz_filter_in_preset_ids';
  }
}
