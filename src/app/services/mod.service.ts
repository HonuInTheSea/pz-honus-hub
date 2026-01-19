import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import type { ModFolderScanResult } from '../models/mod.models';

@Injectable({
  providedIn: 'root',
})
export class ModService {
  async scanFolder(path: string): Promise<ModFolderScanResult> {
    return invoke<ModFolderScanResult>('scan_mod_folder', { path });
  }
}

