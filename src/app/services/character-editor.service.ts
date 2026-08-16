import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import type {
  CharacterDetails,
  CharacterCustomizationOptions,
  CharacterEditPayload,
  CharacterRenderAssets,
  CharacterSaveSlot,
  CharacterSaveSnapshot,
  SaveMapMarker,
} from '../models/character.models';

@Injectable({ providedIn: 'root' })
export class CharacterEditorService {
  private readonly renderAssetCache = new Map<string, Promise<CharacterRenderAssets>>();
  listSaveSlots(zomboidUserDir: string): Promise<CharacterSaveSlot[]> {
    return invoke<CharacterSaveSlot[]>('list_character_save_slots', {
      zomboidUserDir,
    });
  }

  listSaveMapMarkers(zomboidUserDir: string): Promise<SaveMapMarker[]> {
    return invoke<SaveMapMarker[]>('list_save_map_markers', {
      zomboidUserDir,
    });
  }

  readSave(
    zomboidUserDir: string,
    saveRelativePath: string,
    gameDir?: string,
  ): Promise<CharacterSaveSnapshot> {
    return invoke<CharacterSaveSnapshot>('read_character_save', {
      zomboidUserDir,
      saveRelativePath,
      zomboidGameDir: gameDir || null,
    });
  }

  copySave(
    zomboidUserDir: string,
    saveRelativePath: string,
    destinationName: string,
  ): Promise<string> {
    return invoke<string>('copy_character_save', {
      zomboidUserDir,
      saveRelativePath,
      destinationName,
    });
  }

  deleteSave(zomboidUserDir: string, saveRelativePath: string): Promise<void> {
    return invoke<void>('delete_character_save', {
      zomboidUserDir,
      saveRelativePath,
    });
  }

  saveStats(
    zomboidUserDir: string,
    saveRelativePath: string,
    source: string,
    characterId: number,
    edits: CharacterEditPayload,
    gameDir?: string,
  ): Promise<CharacterSaveSnapshot> {
    return invoke<CharacterSaveSnapshot>('save_character_stats', {
      zomboidUserDir,
      saveRelativePath,
      source,
      characterId,
      edits,
      zomboidGameDir: gameDir || null,
    });
  }

  loadRenderAssets(gameDir: string, visuals: CharacterDetails['visuals']): Promise<CharacterRenderAssets> {
    const key = `${gameDir}|${JSON.stringify(visuals)}`;
    const cached = this.renderAssetCache.get(key);
    if (cached) return cached;
    const request = invoke<CharacterRenderAssets>('load_character_render_assets', {
      zomboidGameDir: gameDir,
      visuals,
    });
    this.renderAssetCache.set(key, request);
    while (this.renderAssetCache.size > 8) {
      const oldest = this.renderAssetCache.keys().next().value;
      if (oldest) this.renderAssetCache.delete(oldest);
      else break;
    }
    void request.catch(() => {
      if (this.renderAssetCache.get(key) === request) this.renderAssetCache.delete(key);
    });
    return request;
  }

  loadCustomizationOptions(gameDir: string, gender: string): Promise<CharacterCustomizationOptions> {
    return invoke<CharacterCustomizationOptions>('load_character_customization_options', {
      zomboidGameDir: gameDir,
      gender,
    });
  }

}
