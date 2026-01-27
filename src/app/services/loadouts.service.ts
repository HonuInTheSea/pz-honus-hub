import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import type {
  LoadoutAnalysis,
  LoadoutApplyPlan,
  LoadoutResolvedMod,
} from '../models/loadout.models';

@Injectable({ providedIn: 'root' })
export class LoadoutsService {
  async getDefaultZomboidUserDir(): Promise<string | null> {
    return invoke<string | null>('get_default_zomboid_user_dir');
  }

  async readTextFile(path: string): Promise<string> {
    return invoke<string>('read_text_file', { path });
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    return invoke<void>('write_text_file', { path, content });
  }

  async copyFile(source: string, target: string): Promise<void> {
    return invoke<void>('copy_file', { source, target });
  }

  async deleteServerFiles(userDir: string, serverName: string): Promise<void> {
    return invoke<void>('delete_server_files', { userDir, serverName });
  }

  async listServerNames(userDir: string): Promise<string[]> {
    return invoke<string[]>('list_server_names', { userDir });
  }

  async listSaveModsFiles(userDir: string): Promise<string[]> {
    return invoke<string[]>('list_save_mods_files', { userDir });
  }

  async listMediaScripts(mediaDir: string, modMediaDir?: string): Promise<string[]> {
    return invoke<string[]>('list_media_script_files', {
      media_dir: mediaDir,
      mod_media_dir: modMediaDir ?? null,
    });
  }

  async analyzeLoadout(mods: LoadoutResolvedMod[]): Promise<LoadoutAnalysis> {
    return invoke<LoadoutAnalysis>('analyze_mod_loadout', { mods });
  }

  async planServerPreset(
    zomboidUserDir: string,
    presetName: string,
    modIds: string[],
    workshopIds: string[],
  ): Promise<LoadoutApplyPlan> {
    return invoke<LoadoutApplyPlan>('plan_server_preset', {
      zomboidUserDir,
      presetName,
      modIds,
      workshopIds,
    });
  }

  async writeServerPreset(
    zomboidUserDir: string,
    presetName: string,
    modIds: string[],
    workshopIds: string[],
  ): Promise<void> {
    return invoke<void>('write_server_preset', {
      zomboidUserDir,
      presetName,
      modIds,
      workshopIds,
    });
  }

  async planSingleplayerSaveMods(
    zomboidUserDir: string,
    saveRelPath: string,
    modIds: string[],
    workshopIds: string[],
  ): Promise<LoadoutApplyPlan> {
    return invoke<LoadoutApplyPlan>('plan_singleplayer_save_mods', {
      zomboidUserDir,
      saveRelPath,
      modIds,
      workshopIds,
    });
  }

  async writeSingleplayerSaveMods(
    zomboidUserDir: string,
    saveRelPath: string,
    modIds: string[],
    workshopIds: string[],
  ): Promise<void> {
    return invoke<void>('write_singleplayer_save_mods', {
      zomboidUserDir,
      saveRelPath,
      modIds,
      workshopIds,
    });
  }

  async upsertModlistSettingsPreset(
    zomboidUserDir: string,
    presetName: string,
    modIds: string[],
  ): Promise<{ updated: boolean; path: string; reason?: string }> {
    return invoke<{ updated: boolean; path: string; reason?: string }>(
      'upsert_pz_modlist_settings_preset',
      {
        userDir: zomboidUserDir,
        presetName,
        modIds,
      },
    );
  }

  async removeModlistSettingsPreset(
    zomboidUserDir: string,
    presetName: string,
  ): Promise<{ updated: boolean; path: string; reason?: string }> {
    return invoke<{ updated: boolean; path: string; reason?: string }>(
      'remove_pz_modlist_settings_preset',
      {
        userDir: zomboidUserDir,
        presetName,
      },
    );
  }
}
