import { Injectable } from '@angular/core';
import { ModSummary } from '../models/mod.models';
import { WorkshopMetadata } from './workshop-metadata.service';
import { TauriStoreService } from './tauri-store.service';
import { profileAsync } from '../utils/perf-trace';

interface StoredModsState {
  schemaVersion?: number;
  local?: ModSummary[];
  workshop?: Record<string, WorkshopMetadata>;
  lastSyncedAt?: string;
  lastLocalSyncAt?: string;
  lastWorkshopSyncAt?: string;
}

const CURRENT_SCHEMA_VERSION = 5;

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

function getWorkshopKeyForMod(mod: ModSummary): string | null {
  const workshopId = (mod.workshop_id ?? '').trim();
  if (workshopId) {
    return workshopId;
  }

  const fileId =
    mod.workshop && typeof mod.workshop.fileid === 'number'
      ? String(mod.workshop.fileid)
      : '';
  return fileId || null;
}

function stripEmbeddedWorkshop(mods: ModSummary[]): ModSummary[] {
  return mods.map((mod) => {
    const next: ModSummary = {
      ...mod,
      hidden: !!mod.hidden,
      favorite: !!mod.favorite,
    };
    delete (next as any).workshop;
    return next;
  });
}

function hydrateLocalWithWorkshop(
  mods: ModSummary[],
  workshopById: Record<string, WorkshopMetadata>,
): ModSummary[] {
  if (!mods.length) {
    return mods;
  }

  return mods.map((mod) => {
    const key = getWorkshopKeyForMod(mod);
    if (!key) {
      return { ...mod, workshop: null };
    }
    const meta = workshopById[key] ?? null;
    return {
      ...mod,
      workshop: meta,
    };
  });
}

@Injectable({
  providedIn: 'root',
})
export class ModsStateService {
  private readonly storageKey = 'pz_mods';
  private lastPersistedContentSignature: string | null = null;
  private inMemoryState:
    | {
        local: ModSummary[];
        workshop: Record<string, WorkshopMetadata>;
        lastLocalSyncAt?: string;
        lastWorkshopSyncAt?: string;
        schemaVersion: number;
      }
    | null
    | undefined = undefined;
  private inflightLoad:
    | Promise<{
        local: ModSummary[];
        workshop: Record<string, WorkshopMetadata>;
        lastLocalSyncAt?: string;
        lastWorkshopSyncAt?: string;
        schemaVersion: number;
      } | null>
    | null = null;

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
    if (this.inMemoryState !== undefined) {
      return this.inMemoryState;
    }

    if (this.inflightLoad) {
      return this.inflightLoad;
    }

    const task = profileAsync('modsState.loadPersistedMods', async () => {
      // Prefer Tauri store as the source of truth.
      let raw =
        await this.store.getItem<StoredModsState | string | null>(
          this.storageKey,
        );

      if (raw === null) {
        this.inMemoryState = null;
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
        this.inMemoryState = null;
        return null;
      }

      // Support both current and legacy property names for a smooth migration.
      let local: ModSummary[] | null = null;
      let localFromLegacy = false;
      if (Array.isArray(state.local)) {
        local = state.local;
      } else if (Array.isArray((state as any).mods)) {
        local = (state as any).mods as ModSummary[];
        localFromLegacy = true;
      }

      if (!local) {
        this.inMemoryState = null;
        return null;
      }

      // Prefer current field, but migrate from legacy if present.
      let workshop =
        state.workshop ??
        ((state as any).workshopMetadata as
          | Record<string, WorkshopMetadata>
          | undefined) ??
        ({} as Record<string, WorkshopMetadata>);

      // Rebuild workshop map from legacy embedded mod.workshop entries.
      if (!workshop || Object.keys(workshop).length === 0) {
        const rebuilt: Record<string, WorkshopMetadata> = {};
        for (const mod of local) {
          if (mod && mod.workshop) {
            const key = getWorkshopKeyForMod(mod);
            if (key) {
              rebuilt[key] = mod.workshop;
            }
          }
        }
        workshop = rebuilt;
      }

      // Prune excessively large fields from older persisted states.
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
      workshop = prunedWorkshop;

      const persistedLocal = stripEmbeddedWorkshop(local);
      const hydratedLocal = hydrateLocalWithWorkshop(persistedLocal, workshop);

      const localHadEmbeddedWorkshop = local.some((mod) => !!mod.workshop);
      const needsMigration =
        schemaVersion < CURRENT_SCHEMA_VERSION ||
        localFromLegacy ||
        !!(state as any).workshopMetadata ||
        localHadEmbeddedWorkshop ||
        workshopChanged;

      if (needsMigration) {
        const migratedState: StoredModsState = {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          local: persistedLocal,
          workshop,
          lastSyncedAt: state.lastSyncedAt,
          lastLocalSyncAt: state.lastLocalSyncAt,
          lastWorkshopSyncAt: state.lastWorkshopSyncAt,
        };
        await this.store.setItem(this.storageKey, migratedState);
        schemaVersion = CURRENT_SCHEMA_VERSION;
      }

      this.lastPersistedContentSignature = JSON.stringify({
        local: persistedLocal,
        workshop,
      });

      const normalized = {
        local: hydratedLocal,
        workshop,
        lastLocalSyncAt: state.lastLocalSyncAt,
        lastWorkshopSyncAt: state.lastWorkshopSyncAt,
        schemaVersion,
      };
      this.inMemoryState = normalized;
      return normalized;
    });

    this.inflightLoad = task;
    return task.finally(() => {
      this.inflightLoad = null;
    });
  }

  async savePersistedMods(
    local: ModSummary[],
    workshop: Record<string, WorkshopMetadata>,
    options?: { source?: 'local' | 'workshop' },
  ): Promise<void> {
    return profileAsync('modsState.savePersistedMods', async () => {
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

      const persistedLocal = stripEmbeddedWorkshop(normalizedLocal);
      const hydratedLocal = hydrateLocalWithWorkshop(
        persistedLocal,
        persistedWorkshop,
      );

      const contentSignature = JSON.stringify({
        local: persistedLocal,
        workshop: persistedWorkshop,
      });

      if (
        !options?.source &&
        contentSignature === this.lastPersistedContentSignature
      ) {
        return;
      }

      const state: StoredModsState = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        local: persistedLocal,
        workshop: persistedWorkshop,
        lastSyncedAt: nowIso,
        lastLocalSyncAt,
        lastWorkshopSyncAt,
      };

      await this.store.setItem(this.storageKey, state);
      this.lastPersistedContentSignature = contentSignature;
      this.inMemoryState = {
        local: hydratedLocal,
        workshop: persistedWorkshop,
        lastLocalSyncAt,
        lastWorkshopSyncAt,
        schemaVersion: CURRENT_SCHEMA_VERSION,
      };
    });
  }
}
