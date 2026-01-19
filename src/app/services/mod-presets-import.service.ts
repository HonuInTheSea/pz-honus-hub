import { Injectable } from '@angular/core';
import type { Loadout } from '../models/loadout.models';
import type { ModSummary } from '../models/mod.models';

function nowIso(): string {
  return new Date().toISOString();
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `loadout_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

@Injectable({ providedIn: 'root' })
export class ModPresetsImportService {
  parsePzModlistSettingsFavorites(cfgText: string): Array<{
    name: string;
    modIds: string[];
  }> {
    const text = (cfgText ?? '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');

    const startIdx = lines.findIndex((l) => l.trim() === '!fav!:');
    if (startIdx < 0) {
      return [];
    }

    const entries: Array<{ name: string; modIds: string[] }> = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) {
        continue;
      }
      if (line.startsWith('!') && line.endsWith(':')) {
        break;
      }

      const colon = line.indexOf(':');
      if (colon <= 0) {
        continue;
      }

      const name = line.slice(0, colon).trim();
      const modsPart = line.slice(colon + 1);
      if (!name) {
        continue;
      }

      const modIds: string[] = [];
      const seen = new Set<string>();
      for (const chunk of modsPart.split(';')) {
        const cleaned = chunk.replace(/\\/g, '').trim();
        if (!cleaned) {
          continue;
        }
        if (!seen.has(cleaned)) {
          seen.add(cleaned);
          modIds.push(cleaned);
        }
      }

      entries.push({ name, modIds });
    }

    return entries;
  }

  upsertLoadoutsFromPresets(
    existing: Loadout[],
    presets: Array<{ name: string; modIds: string[] }>,
    mods: ModSummary[] | null | undefined,
  ): { loadouts: Loadout[]; created: number; updated: number } {
    const out = existing.slice();
    let created = 0;
    let updated = 0;

    for (const preset of presets) {
      const idx = out.findIndex(
        (l) => l.name.trim().toLowerCase() === preset.name.trim().toLowerCase(),
      );
      const ts = nowIso();

      if (idx < 0) {
        const loadout: Loadout = {
          id: newId(),
          name: preset.name.trim(),
          description: 'Imported from Project Zomboid mod preset',
          createdAt: ts,
          updatedAt: ts,
          targetModes: ['singleplayer'],
          modIds: preset.modIds,
          workshopIds: this.resolveWorkshopIds(preset.modIds, mods ?? []),
        };
        out.unshift(loadout);
        created++;
        continue;
      }

      const current = out[idx];
      const mergedModIds = this.mergeUnique(current.modIds ?? [], preset.modIds);
      const changed =
        mergedModIds.length !== (current.modIds ?? []).length ||
        mergedModIds.some((m, i) => (current.modIds ?? [])[i] !== m);

      if (!changed) {
        continue;
      }

      const next: Loadout = {
        ...current,
        updatedAt: ts,
        modIds: mergedModIds,
        workshopIds: this.resolveWorkshopIds(mergedModIds, mods ?? []),
      };
      out[idx] = next;
      updated++;
    }

    return { loadouts: out, created, updated };
  }

  private mergeUnique(a: string[], b: string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of [...(a ?? []), ...(b ?? [])]) {
      const id = (v ?? '').trim();
      if (!id) {
        continue;
      }
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  private resolveWorkshopIds(modIds: string[], mods: ModSummary[]): string[] {
    const ids = new Set<string>();
    const byModId = new Map<string, ModSummary>();
    for (const mod of mods ?? []) {
      const id = (mod.mod_id ?? '').trim();
      if (id) {
        byModId.set(id, mod);
      }
    }

    for (const modId of modIds) {
      const mod = byModId.get(modId);
      const direct = (mod?.workshop_id ?? '').trim();
      if (direct) {
        ids.add(direct);
        continue;
      }
      const fileid =
        mod?.workshop?.fileid != null ? String(mod.workshop.fileid) : '';
      if (fileid) {
        ids.add(fileid);
      }
    }

    return Array.from(ids).sort();
  }
}
