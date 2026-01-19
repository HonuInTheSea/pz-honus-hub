import { Injectable } from '@angular/core';
import { TauriStoreService } from './tauri-store.service';
import type { Loadout } from '../models/loadout.models';

interface StoredLoadoutsState {
  schemaVersion?: number;
  loadouts?: Loadout[];
}

const CURRENT_SCHEMA_VERSION = 1;

@Injectable({ providedIn: 'root' })
export class LoadoutsStateService {
  private readonly storageKey = 'pz_loadouts';

  constructor(private readonly store: TauriStoreService) {}

  async load(): Promise<Loadout[]> {
    const raw =
      await this.store.getItem<StoredLoadoutsState | Loadout[] | null>(
        this.storageKey,
      );
    if (!raw) {
      return [];
    }

    if (Array.isArray(raw)) {
      const migrated: StoredLoadoutsState = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        loadouts: raw,
      };
      await this.store.setItem(this.storageKey, migrated);
      return raw;
    }

    const state = raw as StoredLoadoutsState;
    const loadouts = Array.isArray(state.loadouts) ? state.loadouts : [];
    if ((state.schemaVersion ?? 0) < CURRENT_SCHEMA_VERSION) {
      await this.store.setItem(this.storageKey, {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        loadouts,
      });
    }
    return loadouts;
  }

  async save(loadouts: Loadout[]): Promise<void> {
    const state: StoredLoadoutsState = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      loadouts,
    };
    await this.store.setItem(this.storageKey, state);
  }
}

