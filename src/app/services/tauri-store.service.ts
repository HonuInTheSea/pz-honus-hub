import { Injectable } from '@angular/core';
import { Store } from '@tauri-apps/plugin-store';
import { appConfigDir, join } from '@tauri-apps/api/path';

@Injectable({
  providedIn: 'root',
})
export class TauriStoreService {
  private storePromise: Promise<Store> | null = null;
  private readonly storeFileName = 'pz_mod_manager.store.json';

  isTauriRuntime(): boolean {
    const isBrowser = typeof window !== 'undefined';
    const hasTauriFlag =
      isBrowser &&
      (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));

    return hasTauriFlag;
  }

  private getStore(): Promise<Store> {
    if (!this.storePromise) {
      this.storePromise = Store.load(this.storeFileName);
    }
    return this.storePromise;
  }

  async getStoreFilePath(): Promise<string | null> {
    if (!this.isTauriRuntime()) {
      return null;
    }
    try {
      const dir = await appConfigDir();
      return await join(dir, this.storeFileName);
    } catch {
      return null;
    }
  }

  async hasKey(key: string): Promise<boolean> {
    if (this.isTauriRuntime()) {
      try {
        const store = await this.getStore();
        // Prefer a direct existence check if available on the Store API.
        if (typeof (store as any).has === 'function') {
          return await (store as any).has(key);
        }
        const value = await store.get(key);
        // The Tauri store can return either `undefined` or `null` for missing keys
        // depending on plugin/runtime versions; treat both as "not present".
        return typeof value !== 'undefined' && value !== null;
      } catch {
        return false;
      }
    }

    return false;
  }

  async getItem<T>(key: string): Promise<T | null> {
    if (this.isTauriRuntime()) {
      try {
        const store = await this.getStore();
        const value = await store.get<T>(key);
        return (value as T | null) ?? null;
      } catch (err) {
        return null;
      }
    }

    return null;
  }

  async setItem<T>(key: string, value: T): Promise<void> {
    if (this.isTauriRuntime()) {
      try {
        const store = await this.getStore();
        await store.set(key, value);
        await store.save();
        return;
      } catch (err) {
        return;
      }
    }

    return;
  }

  async clearAll(): Promise<void> {
    if (this.isTauriRuntime()) {
      try {
        const store = await this.getStore();
        await store.clear();
        await store.save();
        return;
      } catch {
        return;
      }
    }

    return;
  }
}
