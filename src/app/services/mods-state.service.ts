import { Injectable } from '@angular/core';
import { ModSummary } from '../models/mod.models';
import { WorkshopMetadata } from './workshop-metadata.service';
import { TauriStoreService } from './tauri-store.service';

interface StoredModsState {
  schemaVersion?: number;
  local?: ModSummary[];
  workshop?: Record<string, WorkshopMetadata>;
  lastSyncedAt?: string;
  lastLocalSyncAt?: string;
  lastWorkshopSyncAt?: string;
}

const CURRENT_SCHEMA_VERSION = 4;

function stripLargeWorkshopFields(
  meta: WorkshopMetadata,
): WorkshopMetadata {
  // Keep the metadata shape stable for the UI, but avoid persisting
  // the heaviest fields (these can be very large and can cause the
  // Tauri store write + IPC serialization to stall the UI).
  return {
    ...meta,
    file_description: null,
    author: null,
  };
}

@Injectable({
  providedIn: 'root',
})
export class ModsStateService {
  private readonly storageKey = 'pz_mods';

  constructor(private readonly store: TauriStoreService) {}

  async hasPersistedState(): Promise<boolean> {
    return this.store.hasKey(this.storageKey);
  }

  async loadPersistedMods(): Promise<{
    local: ModSummary[];
    workshop: Record<string, WorkshopMetadata>;
    lastLocalSyncAt?: string;
    lastWorkshopSyncAt?: string;
    schemaVersion: number;
  } | null> {
    // Prefer Tauri store as the source of truth.
    let raw =
      await this.store.getItem<StoredModsState | string | null>(
        this.storageKey,
      );

    if (raw === null) {
      return null;
    }

    let state: StoredModsState | null = null;

    if (typeof raw === 'string') {
      try {
        state = JSON.parse(raw) as StoredModsState;
      } catch {
        state = null;
      }
    } else {
      state = raw as StoredModsState;
    }

    if (!state) {
      return null;
    }

    // Support both current and legacy property names for a smooth migration.
    let local: ModSummary[] | null = null;
    if (Array.isArray(state.local)) {
      local = state.local;
    } else if (Array.isArray((state as any).mods)) {
      local = (state as any).mods as ModSummary[];
      state.local = local;
      // Clean up legacy field so the next save uses the new schema only.
      delete (state as any).mods;
      await this.store.setItem(this.storageKey, state);
    }

    if (!local) {
      return null;
    }

    // Normalize boolean flags so the UI always sees a concrete value.
    local = local.map((mod) => ({
      ...mod,
      hidden: !!mod.hidden,
      favorite: !!mod.favorite,
    }));

    // Ensure workshop metadata stays in sync with the local mods array.
    // Prefer current field, but migrate from legacy if present.
    let workshop =
      state.workshop ??
      ((state as any).workshopMetadata as
        | Record<string, WorkshopMetadata>
        | undefined) ??
      ({} as Record<string, WorkshopMetadata>);

    if (!state.workshop && (state as any).workshopMetadata) {
      state.workshop = workshop;
      delete (state as any).workshopMetadata;
      await this.store.setItem(this.storageKey, state);
    }

    if (!workshop || Object.keys(workshop).length === 0) {
      const rebuilt: Record<string, WorkshopMetadata> = {};
      for (const mod of local) {
        if (mod && mod.workshop && typeof mod.workshop.fileid === 'number') {
          const key = String(mod.workshop.fileid);
          rebuilt[key] = mod.workshop;
        }
      }
      if (Object.keys(rebuilt).length) {
        workshop = rebuilt;
        state.workshop = rebuilt;
        // Persist the repaired state back to Tauri so future loads are consistent.
        await this.store.setItem(this.storageKey, state);
      }
    }

    // Prune excessively large fields from older persisted states.
    // This is an in-place migration for schema v4 (and a safety net for
    // any state that contains raw Steam `file_description` / `author` blobs).
    let schemaVersion =
      typeof state.schemaVersion === 'number' ? state.schemaVersion : 1;

    let workshopChanged = schemaVersion < CURRENT_SCHEMA_VERSION;
    const prunedWorkshop: Record<string, WorkshopMetadata> = {};
    for (const [key, value] of Object.entries(workshop ?? {})) {
      if (!value) {
        continue;
      }
      const pruned = stripLargeWorkshopFields(value);
      prunedWorkshop[key] = pruned;
      if (
        (value.file_description ?? null) !== null ||
        (value.author ?? null) !== null
      ) {
        workshopChanged = true;
      }
    }

    if (workshopChanged) {
      workshop = prunedWorkshop;
      state.workshop = prunedWorkshop;
      state.schemaVersion = CURRENT_SCHEMA_VERSION;
      await this.store.setItem(this.storageKey, state);
      schemaVersion = CURRENT_SCHEMA_VERSION;
    }

    return {
      local,
      workshop,
      lastLocalSyncAt: state.lastLocalSyncAt,
      lastWorkshopSyncAt: state.lastWorkshopSyncAt,
      schemaVersion,
    };
  }

  async savePersistedMods(
    local: ModSummary[],
    workshop: Record<string, WorkshopMetadata>,
    options?: { source?: 'local' | 'workshop' },
  ): Promise<void> {
    // Persist the full Workshop metadata objects as-is so the schema exactly
    // matches the Steam API + WorkshopMetadata interface. If the caller passes
    // an empty workshop map, preserve any previously stored workshop data.
    let normalizedWorkshop: Record<string, WorkshopMetadata> =
      workshop && Object.keys(workshop).length ? workshop : {};

    if (!Object.keys(normalizedWorkshop).length) {
      const existingRaw =
        await this.store.getItem<StoredModsState | string | null>(
          this.storageKey,
        );

      if (existingRaw) {
        let existingState: StoredModsState | null = null;
        if (typeof existingRaw === 'string') {
          try {
            existingState = JSON.parse(existingRaw) as StoredModsState;
          } catch {
            existingState = null;
          }
        } else {
          existingState = existingRaw as StoredModsState;
        }

        if (existingState && existingState.workshop) {
          normalizedWorkshop = existingState.workshop;
        }
      }
    }

    const normalizedLocal: ModSummary[] = local.map((mod) => ({
      ...mod,
      hidden: !!mod.hidden,
      favorite: !!mod.favorite,
    }));

    // Strip heavy fields to keep persistence + IPC payloads bounded.
    const persistedWorkshop: Record<string, WorkshopMetadata> = {};
    for (const [key, value] of Object.entries(normalizedWorkshop)) {
      if (!value) {
        continue;
      }
      persistedWorkshop[key] = stripLargeWorkshopFields(value);
    }

    // Load any existing sync timestamps so we only update the relevant one.
    const existingRaw =
      await this.store.getItem<StoredModsState | string | null>(
        this.storageKey,
      );

    let lastLocalSyncAt = undefined as string | undefined;
    let lastWorkshopSyncAt = undefined as string | undefined;

    if (existingRaw) {
      try {
        const existingState =
          typeof existingRaw === 'string'
            ? (JSON.parse(existingRaw) as StoredModsState)
            : (existingRaw as StoredModsState);
        lastLocalSyncAt = existingState.lastLocalSyncAt;
        lastWorkshopSyncAt = existingState.lastWorkshopSyncAt;
      } catch {
        // Ignore parse errors and start fresh.
      }
    }

    const nowIso = new Date().toISOString();

    if (options?.source === 'local') {
      lastLocalSyncAt = nowIso;
    } else if (options?.source === 'workshop') {
      lastWorkshopSyncAt = nowIso;
    }

    const state: StoredModsState = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      local: normalizedLocal,
      workshop: persistedWorkshop,
      lastSyncedAt: nowIso,
      lastLocalSyncAt,
      lastWorkshopSyncAt,
    };

    await this.store.setItem(this.storageKey, state);
  }
}
