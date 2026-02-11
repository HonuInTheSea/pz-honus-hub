import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import type { ModFolderScanResult } from '../models/mod.models';
import { profileAsync } from '../utils/perf-trace';

@Injectable({
  providedIn: 'root',
})
export class ModService {
  async scanFolder(path: string): Promise<ModFolderScanResult> {
    return profileAsync('invoke.scan_mod_folder', () =>
      invoke<ModFolderScanResult>('scan_mod_folder', { path }),
    );
  }
}

