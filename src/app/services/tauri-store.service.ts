import { Injectable } from '@angular/core';
import { Store } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { profileAsync } from '../utils/perf-trace';

@Injectable({
  providedIn: 'root',
})
export class TauriStoreService {
  private storePromise: Promise<Store> | null = null;
  private prewarmPromise: Promise<void> | null = null;
  private readonly storeFileName = 'pz_mod_manager.store.json';
  private readonly saveDebounceMs = 300;
  private saveTimer: number | null = null;
  private saveInFlight: Promise<void> | null = null;
  private lastSerializedByKey = new Map<string, string | null>();
  private cachedItems = new Map<string, unknown | null>();
  private inflightGetByKey = new Map<string, Promise<unknown | null>>();
  private inflightHasByKey = new Map<string, Promise<boolean>>();
  private pendingSetByKey = new Map<string, unknown>();
  private pendingSetTimer: number | null = null;
  private setFlushInFlight: Promise<void> | null = null;
  private pendingSetWaiters: Array<{
    resolve: () => void;
    reject: (reason?: unknown) => void;
  }> = [];

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

  private serializeForCompare(value: unknown): string | null {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }

  private scheduleSave(store: Store): void {
    if (this.saveTimer != null) {
      return;
    }

    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const run = async () => {
        try {
          await store.save();
        } catch {
          // Ignore store save failures.
        }
      };
      this.saveInFlight = run().finally(() => {
        this.saveInFlight = null;
      });
    }, this.saveDebounceMs);
  }

  private async flushSave(store: Store): Promise<void> {
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (this.saveInFlight) {
      await this.saveInFlight;
      return;
    }

    try {
      await store.save();
    } catch {
      // Ignore store save failures.
    }
  }

  async prewarm(): Promise<void> {
    if (!this.isTauriRuntime()) {
      return;
    }
    if (this.prewarmPromise) {
      return this.prewarmPromise;
    }

    this.prewarmPromise = profileAsync('store.prewarm', async () => {
      try {
        await this.getStore();
      } catch {
        // Ignore prewarm failures.
      }
    });

    return this.prewarmPromise;
  }

  private scheduleSetFlush(): void {
    if (this.pendingSetTimer != null) {
      return;
    }
    this.pendingSetTimer = window.setTimeout(() => {
      this.pendingSetTimer = null;
      void this.flushPendingSets();
    }, 0);
  }

  private async flushPendingSets(): Promise<void> {
    if (this.setFlushInFlight) {
      await this.setFlushInFlight;
      if (this.pendingSetByKey.size) {
        this.scheduleSetFlush();
      }
      return;
    }
    if (!this.pendingSetByKey.size) {
      return;
    }

    const entries = Array.from(this.pendingSetByKey.entries());
    const waiters = this.pendingSetWaiters.splice(0, this.pendingSetWaiters.length);
    this.pendingSetByKey.clear();

    const task = (async () => {
      try {
        const store = await this.getStore();
        for (const [key, value] of entries) {
          await store.set(key, value);
        }
        this.scheduleSave(store);
      } catch (err) {
        for (const waiter of waiters) {
          waiter.reject(err);
        }
        throw err;
      }

      for (const waiter of waiters) {
        waiter.resolve();
      }
    })().finally(() => {
      this.setFlushInFlight = null;
    });

    this.setFlushInFlight = task;
    await task.catch(() => undefined);

    if (this.pendingSetByKey.size) {
      this.scheduleSetFlush();
    }
  }

  private queueSetWrite(key: string, value: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingSetByKey.set(key, value);
      this.pendingSetWaiters.push({ resolve, reject });
      this.scheduleSetFlush();
    });
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
      if (this.cachedItems.has(key)) {
        return this.cachedItems.get(key) !== null;
      }
      const inflight = this.inflightHasByKey.get(key);
      if (inflight) {
        return inflight;
      }

      const task = profileAsync(`store.hasKey:${key}`, async () => {
        try {
          const store = await this.getStore();
          // Prefer a direct existence check if available on the Store API.
          if (typeof (store as any).has === 'function') {
            const has = await (store as any).has(key);
            if (!has) {
              this.cachedItems.set(key, null);
              this.lastSerializedByKey.set(key, this.serializeForCompare(null));
            }
            return has;
          }
          const value = await store.get(key);
          const normalized = value ?? null;
          this.cachedItems.set(key, normalized);
          this.lastSerializedByKey.set(
            key,
            this.serializeForCompare(normalized),
          );
          // The Tauri store can return either `undefined` or `null` for missing keys
          // depending on plugin/runtime versions; treat both as "not present".
          return typeof value !== 'undefined' && value !== null;
        } catch {
          return false;
        }
      }).finally(() => {
        this.inflightHasByKey.delete(key);
      });

      this.inflightHasByKey.set(key, task);
      return task;
    }

    return false;
  }

  async getItem<T>(key: string): Promise<T | null> {
    if (this.isTauriRuntime()) {
      if (this.cachedItems.has(key)) {
        return (this.cachedItems.get(key) as T | null) ?? null;
      }

      const inflight = this.inflightGetByKey.get(key);
      if (inflight) {
        return (await inflight) as T | null;
      }

      const task = profileAsync(`store.getItem:${key}`, async () => {
        try {
          const store = await this.getStore();
          const value = await store.get<T>(key);
          const normalized = (value as T | null) ?? null;
          this.cachedItems.set(key, normalized);
          this.lastSerializedByKey.set(
            key,
            this.serializeForCompare(normalized),
          );
          return normalized;
        } catch (err) {
          return null;
        }
      }).finally(() => {
        this.inflightGetByKey.delete(key);
      });

      this.inflightGetByKey.set(key, task as Promise<unknown | null>);
      return (await task) as T | null;
    }

    return null;
  }

  async getItems(
    keys: string[],
  ): Promise<Record<string, unknown | null>> {
    const normalizedKeys = Array.from(
      new Set((keys ?? []).map((key) => (key ?? '').trim()).filter(Boolean)),
    );
    const out: Record<string, unknown | null> = {};

    if (!normalizedKeys.length) {
      return out;
    }

    if (!this.isTauriRuntime()) {
      for (const key of normalizedKeys) {
        out[key] = null;
      }
      return out;
    }

    const missing: string[] = [];
    for (const key of normalizedKeys) {
      if (this.cachedItems.has(key)) {
        out[key] = this.cachedItems.get(key) ?? null;
        continue;
      }
      missing.push(key);
    }

    if (!missing.length) {
      return out;
    }

    try {
      const batch = await profileAsync(
        `store.getItems:${missing.length}`,
        () =>
          invoke<Record<string, unknown | null>>('get_bootstrap_store_items', {
            keys: missing,
          }),
      );

      for (const key of missing) {
        const value = (batch?.[key] as unknown | null | undefined) ?? null;
        this.cachedItems.set(key, value);
        this.lastSerializedByKey.set(key, this.serializeForCompare(value));
        out[key] = value;
      }
      return out;
    } catch {
      await Promise.all(
        missing.map(async (key) => {
          out[key] = await this.getItem(key);
        }),
      );
      return out;
    }
  }

  async setItem<T>(key: string, value: T): Promise<void> {
    if (this.isTauriRuntime()) {
      return profileAsync(`store.setItem:${key}`, async () => {
        try {
          const nextSerialized = this.serializeForCompare(value);
          const prevSerialized = this.lastSerializedByKey.get(key);
          if (
            typeof prevSerialized !== 'undefined' &&
            prevSerialized === nextSerialized
          ) {
            return;
          }

          this.cachedItems.set(key, value as unknown);
          this.lastSerializedByKey.set(key, nextSerialized);
          await this.queueSetWrite(key, value as unknown);
          return;
        } catch {
          return;
        }
      });
    }

    return;
  }

  async clearAll(): Promise<void> {
    if (this.isTauriRuntime()) {
      return profileAsync('store.clearAll', async () => {
        try {
          if (this.pendingSetTimer != null) {
            window.clearTimeout(this.pendingSetTimer);
            this.pendingSetTimer = null;
          }
          this.pendingSetByKey.clear();
          for (const waiter of this.pendingSetWaiters.splice(0, this.pendingSetWaiters.length)) {
            waiter.resolve();
          }
          if (this.setFlushInFlight) {
            await this.setFlushInFlight.catch(() => undefined);
          }

          const store = await this.getStore();
          await store.clear();
          this.cachedItems.clear();
          this.inflightGetByKey.clear();
          this.inflightHasByKey.clear();
          this.lastSerializedByKey.clear();
          await this.flushSave(store);
          return;
        } catch {
          return;
        }
      });
    }

    return;
  }
}
