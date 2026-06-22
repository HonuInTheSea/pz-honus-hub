import { MessageService } from 'primeng/api';
import { TranslocoService } from '@jsverse/transloco';
import { invoke } from '@tauri-apps/api/core';
import { profileAsync } from '../../../utils/perf-trace';
import { ModFolderScanResult, ModSummary } from '../../../models/mod.models';

/**
 * Handles user actions and operations on the Mods page
 * - Folder operations (pick, scan, sync)
 * - Workshop operations
 * - Import/export functionality
 */
export class ModsPageActions {
  private loadingSource: 'local' | 'workshop' | null = null;
  private readonly lastLocalScanFolderKey = 'pz_mod_folder_last_scan';
  private readonly lastWorkshopSyncFolderKey = 'pz_mod_folder_last_workshop_sync';
  private currentLocale = 'en-US';

  constructor(
    private messageService: MessageService,
    private transloco: TranslocoService,
    private localization: any,
  ) {
    this.currentLocale = this.localization.locale || 'en-US';
  }

  // Scan operations
  async scan(
    mods: ModSummary[],
    folder: string | null,
    modService: { scanFolder(path: string): Promise<ModFolderScanResult> },
    store: { setItem<T>(key: string, value: T): Promise<void> },
    saveModsToStorage: (mods: ModSummary[], source?: 'local') => Promise<void>,
  ): Promise<ModSummary[]> {
    const selectedFolder = (folder ?? '').trim();
    if (!selectedFolder) return mods;

    if (this.loadingSource) {
      this.showMessage('info', 'toasts.mods.syncInProgress.summary', 'toasts.mods.syncInProgress.detail', 3000);
      return mods;
    }

    this.loadingSource = 'local';
    try {
      const result = await profileAsync<ModFolderScanResult>('mods.scan', () =>
        modService.scanFolder(selectedFolder),
      );

      const nextMods = result.summaries
        .map((mod: ModSummary) => ({
          ...mod,
          hidden: !!mod.hidden,
          favorite: !!mod.favorite,
        }))
        .sort((a: ModSummary, b: ModSummary) => a.name.localeCompare(b.name));

      await store.setItem('pz_mod_folder', selectedFolder);
      await saveModsToStorage(nextMods, 'local');
      await store.setItem(this.lastLocalScanFolderKey, selectedFolder);
      this.showMessage('success', 'toasts.mods.localSyncComplete.summary', 'toasts.mods.localSyncComplete.detail', 5000);
      return nextMods;
    } catch (err: unknown) {
      const detail = this.getErrorDetail(err);
      this.showMessage('error', 'toasts.mods.localSyncFailed.summary', detail, 8000);
      return mods;
    } finally {
      this.loadingSource = null;
    }
  }

  // Workshop operations
  async syncWorkshopMetadata(
    mods: any[],
    workshopMetadataService: any,
    modsState: any,
    store: any,
    steamApiKeyService: any
  ): Promise<void> {
    const folder = (modsState.folderPath ?? '').trim();
    if (!folder) return;

    if (this.loadingSource) {
      this.showMessage('info', 'toasts.mods.syncInProgress.summary', 'toasts.mods.syncInProgress.detail', 3000);
      return;
    }

    const ids = this.extractWorkshopIds(mods);

    if (!ids.length) {
      return;
    }

    const uniqueIds = Array.from(new Set(ids));
    const apiKey = await steamApiKeyService.get();
    if (!apiKey.trim()) {
      this.showMessage('error', 'toasts.mods.steamApiRequired.summary', 'toasts.mods.steamApiRequired.detail', 10000);
      return;
    }

    this.loadingSource = 'workshop';
    try {
      const allResults = await profileAsync<any[]>('mods.syncWorkshop', () =>
        workshopMetadataService.getBatchMetadata(uniqueIds),
      );

      const metaById: Record<string, any> = {};
      const receivedIds: string[] = [];

      for (const item of allResults) {
        if (item && !item.error && typeof item.fileid === 'number') {
          const folderId = String(item.fileid);
          metaById[folderId] = item;
          receivedIds.push(folderId);
        }
      }

      this.mergeWorkshopMetadataIntoMods(mods, metaById);
      await modsState.savePersistedMods('workshop');
      await store.setItem(this.lastWorkshopSyncFolderKey, folder);
      this.showMessage('success', 'toasts.mods.workshopSynced.summary', 'toasts.mods.workshopSynced.detail', 5000);
    } catch (err: any) {
      this.handleWorkshopError(err);
    } finally {
      this.loadingSource = null;
    }
  }

  // File operations
  async pickFolder(
    dialog: any,
    modsActions: { folderPath: string | null },
    store: { setItem<T>(key: string, value: T): Promise<void> },
    onFolderChanged: () => Promise<void>,
  ): Promise<void> {
    const selected = await dialog({
      directory: true,
      multiple: false,
      defaultPath: modsActions.folderPath ?? undefined,
    });

    if (typeof selected === 'string' && selected) {
      const isValid = await this.validatePZWorkshopPath(selected);
      if (!isValid) {
        this.showMessage('error', 'toasts.mods.invalidDirectory.summary', 'toasts.mods.invalidDirectory.detail', 15000);
        return;
      }

      const previousFolder = modsActions.folderPath;
      modsActions.folderPath = selected;
      await store.setItem('pz_mod_folder', selected);

      if (!previousFolder || previousFolder !== selected) {
        await onFolderChanged();
      }
    }
  }

  // Utility methods
  private extractWorkshopIds(mods: any[]): string[] {
    const ids: string[] = [];
    for (const mod of mods) {
      const folderId = this.getFolderId(mod);
      if (folderId) {
        ids.push(folderId);
      }
    }
    return ids;
  }

  private getFolderId(mod: any): string | null {
    const base = mod.folderPath;
    const modInfoPath = mod.mod_info_path;

    if (!base || !modInfoPath) return null;

    const baseNorm = base.replace(/\\/g, '/');
    const modNorm = modInfoPath.replace(/\\/g, '/');

    if (!modNorm.startsWith(baseNorm)) return null;

    const relative = modNorm.slice(baseNorm.length).replace(/^\/+/, '');
    const parts = relative.split('/').filter((p: string) => p.length > 0);

    if (!parts.length) return null;

    const folderId = parts[0];
    return /^[0-9]+$/.test(folderId) ? folderId : null;
  }

  private mergeWorkshopMetadataIntoMods(mods: any[], metaById: Record<string, any>): void {
    for (const mod of mods) {
      const folderId = this.getFolderId(mod);
      if (!folderId) continue;

      const meta = metaById[folderId];
      if (!meta || meta.error) continue;

      const fileSize = typeof meta.file_size === 'number' ? meta.file_size : mod.file_size ?? null;
      mod.workshop = meta;
      mod.file_size = fileSize;
    }
  }

  private handleWorkshopError(err: any): void {
    if (err instanceof Error && err.message === 'STEAM_API_UNAUTHORIZED') {
      this.showMessage('error', 'toasts.mods.workshopUnauthorized.summary', 'toasts.mods.workshopUnauthorized.detail', 10000);
    } else {
      const detail = this.getErrorDetail(err);
      this.showMessage('error', 'toasts.mods.workshopSyncFailed.summary', detail, 8000);
    }
  }

  private validatePZWorkshopPath(path: string): Promise<boolean> {
    return invoke<boolean>('validate_pz_workshop_path', { path });
  }

  private getErrorDetail(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return this.transloco.translate('toasts.genericError.detail');
  }

  private showMessage(
    severity: 'success' | 'error' | 'info' | 'warn',
    summaryKey: string,
    detailKey: string,
    life: number
  ): void {
    this.messageService.add({
      severity,
      summary: this.transloco.translate(summaryKey),
      detail: this.transloco.translate(detailKey),
      life,
      closable: true,
    });
  }

  get isLoading(): boolean {
    return this.loadingSource !== null;
  }

  get source(): 'local' | 'workshop' | null {
    return this.loadingSource;
  }
}
