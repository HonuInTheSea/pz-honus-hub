import { Injectable, computed, signal } from '@angular/core';
import { TauriStoreService } from './tauri-store.service';

@Injectable({
  providedIn: 'root',
})
export class SteamApiKeyService {
  private readonly storageKey = 'steam_api_key';
  private readonly apiKey = signal<string | null>(null);
  private loaded = false;
  private inflightLoad: Promise<string | null> | null = null;

  readonly apiKeyValue = computed(() => this.apiKey() ?? '');

  constructor(private readonly store: TauriStoreService) {}

  async get(): Promise<string | null> {
    if (this.loaded) {
      return this.apiKey();
    }

    if (this.inflightLoad) {
      return this.inflightLoad;
    }

    const task = this.store
      .getItem<string>(this.storageKey)
      .then((stored) => {
        const normalized = (stored ?? '').trim();
        const value = normalized || null;
        this.apiKey.set(value);
        this.loaded = true;
        return value;
      })
      .catch(() => {
        this.apiKey.set(null);
        this.loaded = true;
        return null;
      })
      .finally(() => {
        this.inflightLoad = null;
      });

    this.inflightLoad = task;
    return task;
  }

  peek(): string | null {
    return this.apiKey();
  }

  hasValue(): boolean {
    return !!(this.apiKey() ?? '').trim();
  }

  async set(value: string): Promise<void> {
    const normalized = (value ?? '').trim();
    await this.store.setItem(this.storageKey, normalized);
    this.apiKey.set(normalized || null);
    this.loaded = true;
  }
}

