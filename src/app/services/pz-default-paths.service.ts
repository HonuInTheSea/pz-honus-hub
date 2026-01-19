import { Injectable } from '@angular/core';
import { homeDir, join } from '@tauri-apps/api/path';
import { platform } from '@tauri-apps/plugin-os';
import { TauriStoreService } from './tauri-store.service';

type PlatformKey = 'windows' | 'macos' | 'linux' | 'unknown';

@Injectable({
  providedIn: 'root',
})
export class PzDefaultPathsService {
  private readonly windowsGameDir =
    'C:\\Program Files (x86)\\Steam\\steamapps\\common\\ProjectZomboid';
  private readonly windowsWorkshopDir =
    'C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\108600';

  constructor(private readonly store: TauriStoreService) {}

  private async getPlatformKey(): Promise<PlatformKey> {
    if (!this.store.isTauriRuntime()) {
      return this.getBrowserPlatformKey();
    }
    try {
      const raw = await platform();
      if (raw === 'windows') {
        return 'windows';
      }
      if (raw === 'macos') {
        return 'macos';
      }
      if (raw === 'linux') {
        return 'linux';
      }
      return this.getBrowserPlatformKey();
    } catch {
      return this.getBrowserPlatformKey();
    }
  }

  private async getHomeDir(): Promise<string> {
    if (!this.store.isTauriRuntime()) {
      return '';
    }
    try {
      return await homeDir();
    } catch {
      return '';
    }
  }

  private getBrowserPlatformKey(): PlatformKey {
    if (typeof navigator === 'undefined') {
      return 'unknown';
    }
    const platformHint = navigator.platform || '';
    const ua = navigator.userAgent || '';
    const source = `${platformHint} ${ua}`;
    if (/win/i.test(source)) {
      return 'windows';
    }
    if (/mac/i.test(source)) {
      return 'macos';
    }
    if (/linux/i.test(source)) {
      return 'linux';
    }
    return 'unknown';
  }

  private joinFallback(separator: string, ...parts: string[]): string {
    const cleaned = parts
      .filter((part) => typeof part === 'string' && part.length > 0)
      .map((part, index) => {
        if (index === 0) {
          return part.replace(/[\\/]+$/, '');
        }
        return part.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
      });
    return cleaned.join(separator);
  }

  private async joinPath(...parts: string[]): Promise<string> {
    if (this.store.isTauriRuntime()) {
      try {
        return await join(...parts);
      } catch {
        // Fall through to non-Tauri join.
      }
    }
    const platformKey = await this.getPlatformKey();
    const separator = platformKey === 'windows' ? '\\' : '/';
    return this.joinFallback(separator, ...parts);
  }

  async getDefaultGameDir(): Promise<string> {
    const platformKey = await this.getPlatformKey();
    const home = await this.getHomeDir();
    if (platformKey === 'windows') {
      return this.windowsGameDir;
    }
    if (platformKey === 'macos' && home) {
      return await this.joinPath(
        home,
        'Library',
        'Application Support',
        'Steam',
        'steamapps',
        'common',
        'ProjectZomboid',
      );
    }
    if (platformKey === 'linux' && home) {
      return await this.joinPath(
        home,
        '.local',
        'share',
        'Steam',
        'steamapps',
        'common',
        'ProjectZomboid',
      );
    }
    return this.windowsGameDir;
  }

  async getDefaultWorkshopDir(): Promise<string> {
    const platformKey = await this.getPlatformKey();
    const home = await this.getHomeDir();
    if (platformKey === 'windows') {
      return this.windowsWorkshopDir;
    }
    if (platformKey === 'macos' && home) {
      return await this.joinPath(
        home,
        'Library',
        'Application Support',
        'Steam',
        'steamapps',
        'workshop',
        'content',
        '108600',
      );
    }
    if (platformKey === 'linux' && home) {
      return await this.joinPath(
        home,
        '.local',
        'share',
        'Steam',
        'steamapps',
        'workshop',
        'content',
        '108600',
      );
    }
    return this.windowsWorkshopDir;
  }

  async getDefaultUserDirExample(): Promise<string> {
    const platformKey = await this.getPlatformKey();
    const home = await this.getHomeDir();
    if (platformKey === 'windows') {
      return home ? await this.joinPath(home, 'Zomboid') : 'C:\\Users\\YOU\\Zomboid';
    }
    if (platformKey === 'macos') {
      return home ? await this.joinPath(home, 'Zomboid') : '~/Zomboid';
    }
    if (platformKey === 'linux') {
      return home ? await this.joinPath(home, '.zomboid') : '~/.zomboid';
    }
    return 'C:\\Users\\YOU\\Zomboid';
  }

  async getDefaultMediaDirExample(): Promise<string> {
    const gameDir = await this.getDefaultGameDir();
    return await this.joinPath(gameDir, 'media');
  }

  async getDefaultWorkshopModMediaDirExample(): Promise<string> {
    const workshopDir = await this.getDefaultWorkshopDir();
    return await this.joinPath(
      workshopDir,
      '3429790870',
      'mods',
      "Tomb's Player Body",
      'media',
    );
  }

  async getDefaultConsoleLogPathExample(): Promise<string> {
    const userDir = await this.getDefaultUserDirExample();
    return await this.joinPath(userDir, 'console.txt');
  }

  async getDefaultDecompiledDirExample(): Promise<string> {
    const gameDir = await this.getDefaultGameDir();
    return await this.joinPath(gameDir, 'decompiled');
  }

  async getDefaultUserPresetPathExample(): Promise<string> {
    const userDir = await this.getDefaultUserDirExample();
    return await this.joinPath(userDir, 'Lua', 'pz_modlist_settings.cfg');
  }
}
