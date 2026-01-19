import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ModSummary } from '../models/mod.models';

export interface HonuModsDbResult {
  created: boolean;
  path: string;
}

@Injectable({
  providedIn: 'root',
})
export class HonuModInfoQolService {
  async ensureModsDbFile(
    baseDir: string,
    mods: ModSummary[],
  ): Promise<HonuModsDbResult | null> {
    const trimmed = (baseDir ?? '').trim();
    if (!trimmed) {
      return null;
    }

    return invoke<HonuModsDbResult>('ensure_honu_mods_db', {
      baseDir: trimmed,
      mods: mods ?? [],
    });
  }
}
