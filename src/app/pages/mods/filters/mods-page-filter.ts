import { ModSummary } from '../../../models/mod.models';
import { LoadoutsStateService } from '../../../services/loadouts-state.service';
import { ModsTagsService } from '../../../services/mods-tags.service';

/**
 * Handles mod filtering logic:
 * - Search filtering
 * - Tag-based filtering
 * - Preset filtering
 * - Advanced filters (outdated, hidden, adult content, etc.)
 */
export class ModsPageFilter {
  private presetFilterIds: string[] = [];
  private presetFilterModIds = new Set<string>();
  private readonly presetFilterKey = 'pz_filter_in_preset_ids';

  constructor(
    private readonly modsTagsService: ModsTagsService,
    private readonly loadoutsState: LoadoutsStateService & {
      getItem?: <T>(key: string) => Promise<T | null>;
    },
  ) {}

  applyFilters(
    mods: ModSummary[],
    searchKeyword: string,
    tagsService: ModsTagsService = this.modsTagsService,
  ): ModSummary[] {
    return mods.filter((mod) => {
      if (!this.matchesSearch(mod, searchKeyword)) {
        return false;
      }

      if (!this.matchesPresetFilter(mod)) {
        return false;
      }

      if (!this.matchesTagFilter(mod, tagsService)) {
        return false;
      }

      if (!this.matchesAdvancedFilters(mod, tagsService)) {
        return false;
      }

      return true;
    });
  }

  async refreshPresetFilterCache(): Promise<void> {
    if (typeof this.loadoutsState.getItem === 'function') {
      const selected = await this.loadoutsState.getItem<string[]>(
        this.presetFilterKey,
      );
      this.presetFilterIds = Array.isArray(selected) ? selected : [];
    }

    if (!this.presetFilterIds.length) {
      this.presetFilterModIds.clear();
      return;
    }

    const presets = await this.loadoutsState.load();
    const allowed = new Set(this.presetFilterIds);
    const modIds = new Set<string>();

    for (const preset of presets) {
      if (!allowed.has(preset.id)) {
        continue;
      }

      for (const modId of preset.modIds ?? []) {
        const cleaned = (modId ?? '').trim();
        if (cleaned) {
          modIds.add(cleaned);
        }
      }
    }

    this.presetFilterModIds = modIds;
  }

  setPresetFilterIds(ids: string[]): void {
    this.presetFilterIds = ids;
  }

  getPresetFilterIds(): string[] {
    return this.presetFilterIds;
  }

  private matchesSearch(mod: ModSummary, keyword: string): boolean {
    const needle = (keyword ?? '').trim().toLowerCase();
    if (!needle) {
      return true;
    }

    const name = (mod.name ?? '').toLowerCase();
    const author = this.getAuthorDisplay(mod).toLowerCase();
    const workshopId = (mod.workshop_id ?? '').toLowerCase();
    const installDate = this.formatDateTime(mod.install_date).toLowerCase();

    return (
      name.includes(needle) ||
      author.includes(needle) ||
      workshopId.includes(needle) ||
      installDate.includes(needle)
    );
  }

  private matchesPresetFilter(mod: ModSummary): boolean {
    if (this.presetFilterIds.length === 0) {
      return true;
    }

    const modId = (mod.mod_id ?? '').trim();
    return !!modId && this.presetFilterModIds.has(modId);
  }

  private matchesTagFilter(
    mod: ModSummary,
    tagsService: ModsTagsService,
  ): boolean {
    if (!tagsService.selectedTags.length) {
      return true;
    }

    const modTags = tagsService.getTagsForMod(mod.id);
    if (!modTags || modTags.length === 0) {
      return false;
    }

    return tagsService.tagMatchMode === 'all'
      ? tagsService.selectedTags.every((tag) => modTags.includes(tag))
      : tagsService.selectedTags.some((tag) => modTags.includes(tag));
  }

  private matchesAdvancedFilters(
    mod: ModSummary,
    tagsService: ModsTagsService,
  ): boolean {
    if (tagsService.missingSteamOnly) {
      const fileSize = mod.file_size;
      if (typeof fileSize === 'number' && fileSize > 0) {
        return false;
      }
    }

    if (tagsService.hasAdultContentOnly && !mod.workshop?.maybe_inappropriate_sex) {
      return false;
    }

    if (tagsService.outdatedOnly && !this.isModOutdated(mod)) {
      return false;
    }

    if (tagsService.hiddenOnly && !mod.hidden) {
      return false;
    }

    if (tagsService.favoritedOnly && !mod.favorite) {
      return false;
    }

    if (tagsService.hasRulesOnly && !this.hasModRules(mod)) {
      return false;
    }

    return true;
  }

  private isModOutdated(mod: ModSummary): boolean {
    const timeUpdatedRaw = mod.workshop?.time_updated ?? null;
    if (!mod.install_date || timeUpdatedRaw == null) {
      return false;
    }

    const installDate = new Date(mod.install_date);
    const timeUpdated = this.parseTimestamp(timeUpdatedRaw);

    if (Number.isNaN(installDate.getTime()) || Number.isNaN(timeUpdated.getTime())) {
      return false;
    }

    return installDate.getTime() < timeUpdated.getTime();
  }

  private hasModRules(mod: ModSummary): boolean {
    const hasDependencies =
      this.normalizeModRefs([...(mod.dependencies ?? []), ...(mod.requires ?? [])])
        .length > 0;
    const hasLoadAfter = this.normalizeModRefs(mod.load_after ?? []).length > 0;
    const hasLoadBefore = this.normalizeModRefs(mod.load_before ?? []).length > 0;
    const hasIncompatible =
      this.normalizeModRefs(mod.incompatible ?? []).length > 0;

    return hasDependencies || hasLoadAfter || hasLoadBefore || hasIncompatible;
  }

  private parseTimestamp(value: string | number | null | undefined): Date {
    if (value == null) {
      return new Date(NaN);
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

    return timestampMs != null ? new Date(timestampMs) : new Date(NaN);
  }

  private normalizeModRefs(
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

  private getAuthorDisplay(mod: ModSummary): string {
    const authorRaw = (mod.author ?? '').trim();
    if (authorRaw && authorRaw.toLowerCase() !== 'unknown') {
      return authorRaw;
    }

    const creatorName = (mod.workshop?.creator_name ?? '').trim();
    return creatorName || authorRaw || 'Unknown';
  }

  private formatDateTime(value: string | number | null | undefined): string {
    if (value == null || value === '') {
      return '';
    }

    const date = this.parseTimestamp(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
}
