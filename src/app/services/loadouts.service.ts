import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { profileAsync } from '../utils/perf-trace';
import type {
  LoadoutAnalysis,
  LoadoutApplyPlan,
  LoadoutResolvedMod,
} from '../models/loadout.models';

@Injectable({ providedIn: 'root' })
export class LoadoutsService {
  private readonly readCache = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  private readonly inflightReadByPath = new Map<string, Promise<string>>();
  private readonly defaultReadCacheTtlMs = 500;
  private readonly listCacheTtlMs = 5000;
  private readonly serverNamesCache = new Map<
    string,
    { value: string[]; expiresAt: number }
  >();
  private readonly saveModsFilesCache = new Map<
    string,
    { value: string[]; expiresAt: number }
  >();
  private readonly inflightServerNamesByUserDir = new Map<
    string,
    Promise<string[]>
  >();
  private readonly inflightSaveModsFilesByUserDir = new Map<
    string,
    Promise<string[]>
  >();

  private normalizePath(path: string): string {
    return (path ?? '').trim().replace(/[\\/]+/g, '\\').toLowerCase();
  }

  private invalidateReadCache(path?: string): void {
    if (!path) {
      this.readCache.clear();
      this.inflightReadByPath.clear();
      return;
    }
    const key = this.normalizePath(path);
    this.readCache.delete(key);
    this.inflightReadByPath.delete(key);
  }

  private normalizeUserDir(userDir: string): string {
    return (userDir ?? '').trim().replace(/[\\/]+/g, '\\').toLowerCase();
  }

  private invalidateListCaches(userDir?: string): void {
    if (!userDir) {
      this.serverNamesCache.clear();
      this.saveModsFilesCache.clear();
      this.inflightServerNamesByUserDir.clear();
      this.inflightSaveModsFilesByUserDir.clear();
      return;
    }
    const key = this.normalizeUserDir(userDir);
    this.serverNamesCache.delete(key);
    this.saveModsFilesCache.delete(key);
    this.inflightServerNamesByUserDir.delete(key);
    this.inflightSaveModsFilesByUserDir.delete(key);
  }

  async getDefaultZomboidUserDir(): Promise<string | null> {
    return profileAsync('invoke.get_default_zomboid_user_dir', () =>
      invoke<string | null>('get_default_zomboid_user_dir'),
    );
  }

  async readTextFile(
    path: string,
    options?: {
      force?: boolean;
      cacheTtlMs?: number;
      profileLabel?: string;
    },
  ): Promise<string> {
    const normalizedPath = this.normalizePath(path);
    const force = !!options?.force;
    const ttlMs =
      typeof options?.cacheTtlMs === 'number'
        ? Math.max(0, options.cacheTtlMs)
        : this.defaultReadCacheTtlMs;
    const now = Date.now();

    if (!force) {
      const cached = this.readCache.get(normalizedPath);
      if (cached && cached.expiresAt > now) {
        return cached.value;
      }
      const inflight = this.inflightReadByPath.get(normalizedPath);
      if (inflight) {
        return inflight;
      }
    }

    const profileLabel = options?.profileLabel ?? 'invoke.read_text_file';
    const task = profileAsync(profileLabel, () =>
      invoke<string>('read_text_file', { path }),
    )
      .then((text) => {
        if (ttlMs > 0) {
          this.readCache.set(normalizedPath, {
            value: text,
            expiresAt: Date.now() + ttlMs,
          });
        } else {
          this.readCache.delete(normalizedPath);
        }
        return text;
      })
      .finally(() => {
        this.inflightReadByPath.delete(normalizedPath);
      });

    this.inflightReadByPath.set(normalizedPath, task);
    return task;
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const write = profileAsync('invoke.write_text_file', () =>
      invoke<void>('write_text_file', { path, content }),
    );
    await write;
    const key = this.normalizePath(path);
    this.readCache.set(key, {
      value: content,
      expiresAt: Date.now() + this.defaultReadCacheTtlMs,
    });
  }

  async copyFile(source: string, target: string): Promise<void> {
    const copy = profileAsync('invoke.copy_file', () =>
      invoke<void>('copy_file', { source, target }),
    );
    await copy;
    this.invalidateReadCache(target);
  }

  async deleteServerFiles(userDir: string, serverName: string): Promise<void> {
    const del = profileAsync('invoke.delete_server_files', () =>
      invoke<void>('delete_server_files', { userDir, serverName }),
    );
    await del;
    this.invalidateReadCache();
    this.invalidateListCaches(userDir);
  }

  async listServerNames(userDir: string): Promise<string[]> {
    const key = this.normalizeUserDir(userDir);
    const now = Date.now();
    const cached = this.serverNamesCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inflight = this.inflightServerNamesByUserDir.get(key);
    if (inflight) {
      return inflight;
    }

    const task = profileAsync('invoke.list_server_names', () =>
      invoke<string[]>('list_server_names', { userDir }),
    )
      .then((value) => {
        this.serverNamesCache.set(key, {
          value: value ?? [],
          expiresAt: Date.now() + this.listCacheTtlMs,
        });
        return value ?? [];
      })
      .finally(() => {
        this.inflightServerNamesByUserDir.delete(key);
      });

    this.inflightServerNamesByUserDir.set(key, task);
    return task;
  }

  async listSaveModsFiles(userDir: string): Promise<string[]> {
    const key = this.normalizeUserDir(userDir);
    const now = Date.now();
    const cached = this.saveModsFilesCache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const inflight = this.inflightSaveModsFilesByUserDir.get(key);
    if (inflight) {
      return inflight;
    }

    const task = profileAsync('invoke.list_save_mods_files', () =>
      invoke<string[]>('list_save_mods_files', { userDir }),
    )
      .then((value) => {
        this.saveModsFilesCache.set(key, {
          value: value ?? [],
          expiresAt: Date.now() + this.listCacheTtlMs,
        });
        return value ?? [];
      })
      .finally(() => {
        this.inflightSaveModsFilesByUserDir.delete(key);
      });

    this.inflightSaveModsFilesByUserDir.set(key, task);
    return task;
  }

  async listMediaScripts(mediaDir: string, modMediaDir?: string): Promise<string[]> {
    return profileAsync('invoke.list_media_script_files', () =>
      invoke<string[]>('list_media_script_files', {
        media_dir: mediaDir,
        mod_media_dir: modMediaDir ?? null,
      }),
    );
  }

  async analyzeLoadout(mods: LoadoutResolvedMod[]): Promise<LoadoutAnalysis> {
    return profileAsync('invoke.analyze_mod_loadout', () =>
      invoke<LoadoutAnalysis>('analyze_mod_loadout', { mods }),
    );
  }

  async planServerPreset(
    zomboidUserDir: string,
    presetName: string,
    modIds: string[],
    workshopIds: string[],
  ): Promise<LoadoutApplyPlan> {
    return profileAsync('invoke.plan_server_preset', () =>
      invoke<LoadoutApplyPlan>('plan_server_preset', {
        zomboidUserDir,
        presetName,
        modIds,
        workshopIds,
      }),
    );
  }

  async writeServerPreset(
    zomboidUserDir: string,
    presetName: string,
    modIds: string[],
    workshopIds: string[],
  ): Promise<void> {
    return profileAsync('invoke.write_server_preset', () =>
      invoke<void>('write_server_preset', {
        zomboidUserDir,
        presetName,
        modIds,
        workshopIds,
      }),
    );
  }

  async planSingleplayerSaveMods(
    zomboidUserDir: string,
    saveRelPath: string,
    modIds: string[],
    workshopIds: string[],
  ): Promise<LoadoutApplyPlan> {
    return profileAsync('invoke.plan_singleplayer_save_mods', () =>
      invoke<LoadoutApplyPlan>('plan_singleplayer_save_mods', {
        zomboidUserDir,
        saveRelPath,
        modIds,
        workshopIds,
      }),
    );
  }

  async writeSingleplayerSaveMods(
    zomboidUserDir: string,
    saveRelPath: string,
    modIds: string[],
    workshopIds: string[],
  ): Promise<void> {
    return profileAsync('invoke.write_singleplayer_save_mods', () =>
      invoke<void>('write_singleplayer_save_mods', {
        zomboidUserDir,
        saveRelPath,
        modIds,
        workshopIds,
      }),
    );
  }

  async upsertModlistSettingsPreset(
    zomboidUserDir: string,
    presetName: string,
    modIds: string[],
  ): Promise<{ updated: boolean; path: string; reason?: string }> {
    return profileAsync('invoke.upsert_pz_modlist_settings_preset', () =>
      invoke<{ updated: boolean; path: string; reason?: string }>(
        'upsert_pz_modlist_settings_preset',
        {
          userDir: zomboidUserDir,
          presetName,
          modIds,
        },
      ),
    );
  }

  async removeModlistSettingsPreset(
    zomboidUserDir: string,
    presetName: string,
  ): Promise<{ updated: boolean; path: string; reason?: string }> {
    return profileAsync('invoke.remove_pz_modlist_settings_preset', () =>
      invoke<{ updated: boolean; path: string; reason?: string }>(
        'remove_pz_modlist_settings_preset',
        {
          userDir: zomboidUserDir,
          presetName,
        },
      ),
    );
  }
}
