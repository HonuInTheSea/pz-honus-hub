import type { ModSummary } from './mod.models';

export type LoadoutTargetMode =
  | 'singleplayer'
  | 'host'
  | 'dedicated'
  | 'coop';

export interface Loadout {
  id: string;
  name: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
  targetModes: LoadoutTargetMode[];
  modIds: string[];
  workshopIds: string[];
  workshopByModId?: Record<string, string>;
  disabledModIds?: string[];
  mapEntries?: Array<{ modId: string; mapFolder: string }>;
}

export interface LoadoutResolvedMod {
  modId: string;
  name?: string | null;
  workshopId?: string | null;
  modInfoPath?: string | null;
  requires?: string[] | null;
  dependencies?: string[] | null;
  loadAfter?: string[] | null;
  loadBefore?: string[] | null;
  incompatible?: string[] | null;
}

export interface LoadoutConflictGroup {
  relativePath: string;
  mods: Array<{
    modId: string;
    name?: string | null;
    modInfoPath?: string | null;
  }>;
}

export interface LoadoutAnalysis {
  orderedModIds: string[];
  missingModIds: string[];
  missingWorkshopIds: string[];
  cycles: string[][];
  incompatiblePairs: Array<{ a: string; b: string }>;
  conflicts: LoadoutConflictGroup[];
  warnings: string[];
}

export interface LoadoutApplyPlan {
  presetName: string;
  targetPath: string;
  iniPreview: string;
}

export function modsToResolvedMods(
  mods: ModSummary[],
  selectedModIds: string[],
): LoadoutResolvedMod[] {
  const byModId = new Map<string, ModSummary>();
  for (const mod of mods) {
    const modId = (mod.mod_id ?? '').trim();
    if (modId) {
      byModId.set(modId, mod);
    }
  }

  return selectedModIds.map((modId) => {
    const found = byModId.get(modId);
    const workshopIdFromSummary = (found?.workshop_id ?? null) || null;
    const workshopIdFromMetadata =
      found?.workshop?.fileid != null ? String(found.workshop.fileid) : null;
    return {
      modId,
      name: found?.name ?? null,
      workshopId: workshopIdFromSummary ?? workshopIdFromMetadata,
      modInfoPath: found?.mod_info_path ?? null,
      requires: found?.requires ?? null,
      dependencies: found?.dependencies ?? null,
      loadAfter: found?.load_after ?? null,
      loadBefore: found?.load_before ?? null,
      incompatible: found?.incompatible ?? null,
    };
  });
}
