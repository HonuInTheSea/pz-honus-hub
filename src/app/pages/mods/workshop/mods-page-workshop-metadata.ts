import { ModSummary } from '../../../models/mod.models';
import { WorkshopMetadata } from '../../../services/workshop-metadata.service';

/**
 * Handles Workshop metadata operations:
 * - Batch metadata fetching
 * - Metadata merging
 * - Metadata storage
 */
export class ModsPageWorkshopMetadata {
  private workshopMetadataById: Record<string, WorkshopMetadata> = {};

  async fetchBatchMetadata(
    uniqueIds: string[],
    workshopMetadataService: {
      getBatchMetadata(ids: string[]): Promise<WorkshopMetadata[]>;
    },
    steamApiKeyService: { get(): Promise<string> },
  ): Promise<void> {
    const apiKey = await steamApiKeyService.get();
    if (!apiKey.trim()) {
      throw new Error('STEAM_API_REQUIRED');
    }

    const allResults = await workshopMetadataService.getBatchMetadata(uniqueIds);
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
    this.mergeMetadata(metaById, missing);
  }

  mergeMetadata(
    metaById: Record<string, WorkshopMetadata>,
    missing: string[] = [],
  ): void {
    this.workshopMetadataById = {
      ...this.workshopMetadataById,
      ...metaById,
    };

    for (const id of missing) {
      delete this.workshopMetadataById[id];
    }
  }

  getMetadata(): Record<string, WorkshopMetadata> {
    return this.workshopMetadataById;
  }

  hasAnyMetadata(): boolean {
    return Object.keys(this.workshopMetadataById).length > 0;
  }

  async saveMetadata(
    mods: ModSummary[],
    saveFunc: (source?: 'workshop') => Promise<void>,
  ): Promise<void> {
    void mods;
    await saveFunc('workshop');
  }

  mergeWorkshopMetadataIntoMods(mods: ModSummary[]): ModSummary[] {
    return mods.map((mod) => {
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

      return { ...mod, workshop: meta, file_size: fileSize };
    });
  }

  async maybeUpdateHonuModsDb(
    store: {
      getItem<T>(key: string): Promise<T | null>;
      setItem<T>(key: string, value: T): Promise<void>;
    },
    honuQol: { ensureModsDbFile(dir: string, mods: ModSummary[]): Promise<void> },
    mods: ModSummary[],
    lastLocalSyncAt: string,
    lastWorkshopSyncAt: string,
  ): Promise<void> {
    const userDirRaw = await store.getItem<string>('pz_user_dir');
    if (!userDirRaw) {
      return;
    }

    const honuDir = this.toHonuModInfoQolDir(userDirRaw);
    if (!honuDir) {
      return;
    }

    const changedAtRaw = await store.getItem<string>(this.getChangedAtKey());
    if (!changedAtRaw || !changedAtRaw.trim()) {
      return;
    }

    const changedMs = Date.parse(changedAtRaw.trim());
    if (!Number.isFinite(changedMs) || !lastLocalSyncAt || !lastWorkshopSyncAt) {
      return;
    }

    const lastLocalMs = Date.parse(lastLocalSyncAt);
    const lastWorkshopMs = Date.parse(lastWorkshopSyncAt);

    if (!Number.isFinite(lastLocalMs) || !Number.isFinite(lastWorkshopMs)) {
      return;
    }

    if (lastLocalMs < changedMs || lastWorkshopMs < changedMs) {
      await honuQol.ensureModsDbFile(honuDir, mods);
      await store.setItem(this.getChangedAtKey(), '');
    }
  }

  private getFolderId(mod: ModSummary): string | null {
    const base = (mod as ModSummary & { folderPath?: string }).folderPath;
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
    const parts = relative.split('/').filter((part) => part.length > 0);

    if (!parts.length) {
      return null;
    }

    const folderId = parts[0];
    return /^[0-9]+$/.test(folderId) ? folderId : null;
  }

  private getChangedAtKey(): string {
    return 'pz_honu_mod_info_qol_dir_changed_at';
  }

  private toHonuModInfoQolDir(userDir: string): string {
    const cleaned = (userDir ?? '').trim().replace(/[\\/]+$/, '');
    if (!cleaned) {
      return '';
    }

    return `${cleaned}/Lua`;
  }
}
