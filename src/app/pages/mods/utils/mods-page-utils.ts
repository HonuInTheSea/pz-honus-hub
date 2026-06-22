/**
 * Helper utilities for mods page operations.
 */
export class ModsPageUtils {
  static isNumericId(id: string | undefined | null): boolean {
    if (!id) {
      return false;
    }

    return /^[0-9]+$/.test(id);
  }

  static steamWorkshopUrl(id: string | undefined | null): string {
    return `https://steamcommunity.com/sharedfiles/filedetails/?id=${id ?? ''}`;
  }

  static getFolderId(mod: any): string | null {
    const base = mod.folderPath;
    const modInfoPath = mod.mod_info_path;

    if (!base || !modInfoPath) {
      return null;
    }

    const baseNorm = base.replace(/\\/g, '/');
    const modNorm = modInfoPath.replace(/\\/g, '/');

    if (!modNorm.startsWith(baseNorm)) {
      return null;
    }

    const relative = modNorm.slice(baseNorm.length).replace(/^\/+/, '');
    const parts = relative.split('/').filter((part: string) => part.length > 0);

    if (!parts.length) {
      return null;
    }

    const folderId = parts[0];
    return ModsPageUtils.isNumericId(folderId) ? folderId : null;
  }

  static normalizeModRefs(
    rawValues: Array<string | null | undefined>,
  ): string[] {
    const cleaned: string[] = [];

    for (const raw of rawValues) {
      if (!raw) {
        continue;
      }

      const cleanedRaw = String(raw).replace(/^\\+/, '');
      const parts = cleanedRaw
        .split(/[;,\s]+/g)
        .map((part) => part.trim().replace(/^['"]+|['"]+$/g, '').trim())
        .filter((part) => part.length > 0);

      cleaned.push(...parts);
    }

    const seen = new Set<string>();
    const unique: string[] = [];
    for (const value of cleaned) {
      const key = value.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(value);
    }

    return unique;
  }

  static async computeIncompatibleWithModIds(mods: any[]): Promise<Set<string>> {
    const byKey = new Map<string, string>();
    for (const mod of mods ?? []) {
      if (!mod) {
        continue;
      }

      const recordId = (mod.id ?? '').trim();
      if (recordId) {
        byKey.set(recordId.toLowerCase(), mod.id);
      }

      const modId = (mod.mod_id ?? '').trim();
      if (modId) {
        byKey.set(modId.toLowerCase(), mod.id);
      }

      const workshopId = (mod.workshop_id ?? '').trim();
      if (workshopId) {
        byKey.set(workshopId.toLowerCase(), mod.id);
      }
    }

    const incompatibleWith = new Set<string>();
    for (const mod of mods ?? []) {
      if (!mod) {
        continue;
      }

      const incompatibleValues = this.normalizeModRefs(mod.incompatible ?? []);
      for (const raw of incompatibleValues) {
        const targetId = byKey.get(raw.toLowerCase());
        if (targetId) {
          incompatibleWith.add(targetId);
        }
      }
    }

    return incompatibleWith;
  }

  static formatDateTime(
    value: string | number | null | undefined,
    locale = 'en-US',
  ): string {
    if (value == null || value === '') {
      return '';
    }

    let timestampMs: number | null = null;

    if (typeof value === 'number') {
      timestampMs = value < 1e12 ? value * 1000 : value;
    } else {
      const numeric = Number(value);
      if (!Number.isNaN(numeric)) {
        timestampMs = numeric < 1e12 ? numeric * 1000 : numeric;
      } else {
        const parsed = new Date(value).getTime();
        timestampMs = Number.isNaN(parsed) ? null : parsed;
      }
    }

    if (timestampMs == null) {
      return '';
    }

    const date = new Date(timestampMs);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return date.toLocaleString(locale);
  }

  static getAuthorDisplay(mod: any): string {
    const authorRaw = (mod.author ?? '').trim();
    if (authorRaw && authorRaw.toLowerCase() !== 'unknown') {
      return authorRaw;
    }

    const creatorName = (mod.workshop?.creator_name ?? '').trim();
    return creatorName || authorRaw || 'Unknown';
  }

  static extractWorkshopIds(mods: any[]): string[] {
    const ids: string[] = [];
    for (const mod of mods) {
      const folderId = this.getFolderId(mod);
      if (folderId) {
        ids.push(folderId);
      }
    }
    return ids;
  }

  static getUniqueIds(ids: string[]): string[] {
    return Array.from(new Set(ids));
  }

  static debounce<T extends (...args: any[]) => Promise<any>>(
    func: T,
    wait: number,
  ): (...args: Parameters<T>) => Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return async (...args: Parameters<T>) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      timeout = setTimeout(() => {
        void func(...args);
      }, wait);
    };
  }

  static async shouldRunFolderAction(
    key: string,
    currentFolder: string,
    store: { getItem<T>(key: string): Promise<T | null> },
  ): Promise<boolean> {
    const stored = await store.getItem<string>(key);
    return (stored ?? '').trim() !== currentFolder;
  }
}
