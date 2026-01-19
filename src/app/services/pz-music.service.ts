import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { TauriStoreService } from './tauri-store.service';
import { PzDefaultPathsService } from './pz-default-paths.service';

export interface OggTrackMetadata {
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  track_number?: number | null;
  genre?: string | null;
  year?: number | null;
}

export interface OggTrackInfo {
  path: string;
  relative_path: string;
  size_bytes: number;
  modified_epoch_ms: number;
  metadata: OggTrackMetadata;
}

@Injectable({
  providedIn: 'root',
})
export class PzMusicService {
  constructor(
    private readonly store: TauriStoreService,
    private readonly pzDefaults: PzDefaultPathsService,
  ) {}

  async getGameDir(): Promise<string> {
    const storedDir = await this.store.getItem<string>('pz_game_dir');
    return (storedDir || '').trim() || (await this.pzDefaults.getDefaultGameDir());
  }

  isTauriRuntime(): boolean {
    return this.store.isTauriRuntime();
  }

  async listProjectZomboidOggTracks(): Promise<OggTrackInfo[]> {
    if (!this.store.isTauriRuntime()) {
      return [];
    }

    const gameDir = await this.getGameDir();

    const tracks = await invoke<OggTrackInfo[]>('list_project_zomboid_music_ogg', {
      gameDir,
    });

    return Array.isArray(tracks) ? tracks : [];
  }
}
