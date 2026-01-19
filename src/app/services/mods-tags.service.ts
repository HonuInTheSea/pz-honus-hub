import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TauriStoreService } from './tauri-store.service';

const DEFAULT_TAGS: string[] = [
  'Animals',
  'Audio',
  'Balance',
  'Build 41',
  'Build 42',
  'Buildings',
  'Clothing/Armor',
  'Farming',
  'Food',
  'Framework',
  'Hardmode',
  'Interface',
  'Items',
  'Language/Translation',
  'Literature',
  'Map',
  'Military',
  'Misc',
  'Models',
  'Multiplayer',
  'Pop Culture',
  'QoL',
  'Realistic',
  'Silly/Fun',
  'Skills',
  'Textures',
  'Traits',
  'Vehicles',
  'Weapons',
  'WIP',
];

interface ModTagsStorage {
  [modId: string]: string[];
}

export type TagMatchMode = 'any' | 'all';

@Injectable({
  providedIn: 'root',
})
export class ModsTagsService {
  private readonly TAG_OPTIONS_KEY = 'pz_tag_options';
  private readonly MOD_TAGS_KEY = 'pz_mod_tags';
  private readonly SELECTED_TAGS_KEY = 'pz_selected_tags';
  private readonly TAG_MATCH_MODE_KEY = 'pz_tag_match_mode';
  private readonly OUTDATED_ONLY_KEY = 'pz_outdated_only';
  private readonly HIDDEN_ONLY_KEY = 'pz_hidden_only';
  private readonly MISSING_STEAM_ONLY_KEY = 'pz_missing_steam_only';
  private readonly HAS_RULES_ONLY_KEY = 'pz_has_rules_only';
  private readonly HAS_ADULT_CONTENT_ONLY_KEY = 'pz_has_adult_content_only';
  private readonly FAVORITED_ONLY_KEY = 'pz_favorited_only';

  private readonly tagOptionsSubject: BehaviorSubject<string[]>;
  readonly tagOptions$;

  private readonly selectedTagsSubject: BehaviorSubject<string[]>;
  readonly selectedTags$;

  private readonly tagMatchModeSubject: BehaviorSubject<TagMatchMode>;
  readonly tagMatchMode$;

  private readonly tagCountsSubject: BehaviorSubject<Record<string, number>>;
  readonly tagCounts$;

  private readonly outdatedOnlySubject: BehaviorSubject<boolean>;
  readonly outdatedOnly$;

  private readonly hiddenOnlySubject: BehaviorSubject<boolean>;
  readonly hiddenOnly$;

  private readonly missingSteamOnlySubject: BehaviorSubject<boolean>;
  readonly missingSteamOnly$;

  private readonly hasRulesOnlySubject: BehaviorSubject<boolean>;
  readonly hasRulesOnly$;

  private readonly hasAdultContentOnlySubject: BehaviorSubject<boolean>;
  readonly hasAdultContentOnly$;

  private readonly favoritedOnlySubject: BehaviorSubject<boolean>;
  readonly favoritedOnly$;

  private modTags: ModTagsStorage = {};
  private readonly tagAliases: Record<string, string> = {
    building: 'Buildings',
    buildings: 'Buildings',
    qol: 'QoL',
  };

  constructor(private readonly store: TauriStoreService) {
    this.tagOptionsSubject = new BehaviorSubject<string[]>([...DEFAULT_TAGS]);
    this.tagOptions$ = this.tagOptionsSubject.asObservable();

    this.modTags = {};

    this.selectedTagsSubject = new BehaviorSubject<string[]>([]);
    this.selectedTags$ = this.selectedTagsSubject.asObservable();

    this.tagMatchModeSubject = new BehaviorSubject<TagMatchMode>('any');
    this.tagMatchMode$ = this.tagMatchModeSubject.asObservable();

    this.tagCountsSubject = new BehaviorSubject<Record<string, number>>({});
    this.tagCounts$ = this.tagCountsSubject.asObservable();

    this.outdatedOnlySubject = new BehaviorSubject<boolean>(false);
    this.outdatedOnly$ = this.outdatedOnlySubject.asObservable();

    this.hiddenOnlySubject = new BehaviorSubject<boolean>(false);
    this.hiddenOnly$ = this.hiddenOnlySubject.asObservable();

    this.missingSteamOnlySubject = new BehaviorSubject<boolean>(false);
    this.missingSteamOnly$ = this.missingSteamOnlySubject.asObservable();

    this.hasRulesOnlySubject = new BehaviorSubject<boolean>(false);
    this.hasRulesOnly$ = this.hasRulesOnlySubject.asObservable();

    this.hasAdultContentOnlySubject = new BehaviorSubject<boolean>(false);
    this.hasAdultContentOnly$ = this.hasAdultContentOnlySubject.asObservable();

    this.favoritedOnlySubject = new BehaviorSubject<boolean>(false);
    this.favoritedOnly$ = this.favoritedOnlySubject.asObservable();

    void this.initializeFromStore();
  }

  get tagOptions(): string[] {
    return this.tagOptionsSubject.value;
  }

  private async initializeFromStore(): Promise<void> {
    const storedOptions = await this.loadTagOptions();
    if (storedOptions.length) {
      this.tagOptionsSubject.next(storedOptions);
    }

    this.modTags = await this.loadModTags();

    const storedSelected = await this.loadSelectedTags();
    if (storedSelected.length) {
      this.selectedTagsSubject.next(storedSelected);
    }

    const storedMatchMode = await this.loadTagMatchMode();
    this.tagMatchModeSubject.next(storedMatchMode);

    const storedOutdatedOnly = await this.loadOutdatedOnly();
    this.outdatedOnlySubject.next(storedOutdatedOnly);

    const storedHiddenOnly = await this.loadHiddenOnly();
    this.hiddenOnlySubject.next(storedHiddenOnly);

    const storedMissingSteamOnly = await this.loadMissingSteamOnly();
    this.missingSteamOnlySubject.next(storedMissingSteamOnly);

    const storedHasRulesOnly = await this.loadHasRulesOnly();
    this.hasRulesOnlySubject.next(storedHasRulesOnly);

    const storedHasAdultContentOnly = await this.loadHasAdultContentOnly();
    this.hasAdultContentOnlySubject.next(storedHasAdultContentOnly);

    const storedFavoritedOnly = await this.loadFavoritedOnly();
    this.favoritedOnlySubject.next(storedFavoritedOnly);
  }

  updateTagOptions(options: string[]): void {
    const cleaned = this.normalizeTags(options);

    this.tagOptionsSubject.next(cleaned);
    void this.store.setItem(this.TAG_OPTIONS_KEY, cleaned);
  }

  getTagsForMod(modId: string): string[] {
    return this.modTags[modId] ?? [];
  }

  setTagsForMod(modId: string, tags: string[]): void {
    const cleaned = this.normalizeTags(tags);

    if (cleaned.length === 0) {
      delete this.modTags[modId];
    } else {
      this.modTags[modId] = cleaned;
    }

    void this.store.setItem(this.MOD_TAGS_KEY, this.modTags);
  }

  get selectedTags(): string[] {
    return this.selectedTagsSubject.value;
  }

  setSelectedTags(tags: string[]): void {
    const cleaned = this.normalizeTags(tags);

    this.selectedTagsSubject.next(cleaned);
    void this.store.setItem(this.SELECTED_TAGS_KEY, cleaned);
  }

  get tagMatchMode(): TagMatchMode {
    return this.tagMatchModeSubject.value;
  }

  setTagMatchMode(mode: TagMatchMode): void {
    const next = mode === 'all' ? 'all' : 'any';
    this.tagMatchModeSubject.next(next);
    void this.store.setItem(this.TAG_MATCH_MODE_KEY, next);
  }

  setTagCounts(counts: Record<string, number>): void {
    this.tagCountsSubject.next(counts);
  }

  get outdatedOnly(): boolean {
    return this.outdatedOnlySubject.value;
  }

  setOutdatedOnly(value: boolean): void {
    this.outdatedOnlySubject.next(!!value);
    void this.store.setItem(this.OUTDATED_ONLY_KEY, !!value);
  }

  get hiddenOnly(): boolean {
    return this.hiddenOnlySubject.value;
  }

  setHiddenOnly(value: boolean): void {
    this.hiddenOnlySubject.next(!!value);
    void this.store.setItem(this.HIDDEN_ONLY_KEY, !!value);
  }

  get missingSteamOnly(): boolean {
    return this.missingSteamOnlySubject.value;
  }

  setMissingSteamOnly(value: boolean): void {
    this.missingSteamOnlySubject.next(!!value);
    void this.store.setItem(this.MISSING_STEAM_ONLY_KEY, !!value);
  }

  get hasRulesOnly(): boolean {
    return this.hasRulesOnlySubject.value;
  }

  setHasRulesOnly(value: boolean): void {
    this.hasRulesOnlySubject.next(!!value);
    void this.store.setItem(this.HAS_RULES_ONLY_KEY, !!value);
  }

  get hasAdultContentOnly(): boolean {
    return this.hasAdultContentOnlySubject.value;
  }

  setHasAdultContentOnly(value: boolean): void {
    this.hasAdultContentOnlySubject.next(!!value);
    void this.store.setItem(this.HAS_ADULT_CONTENT_ONLY_KEY, !!value);
  }

  get favoritedOnly(): boolean {
    return this.favoritedOnlySubject.value;
  }

  setFavoritedOnly(value: boolean): void {
    this.favoritedOnlySubject.next(!!value);
    void this.store.setItem(this.FAVORITED_ONLY_KEY, !!value);
  }

  private async loadTagOptions(): Promise<string[]> {
    const parsed = await this.store.getItem<string[]>(this.TAG_OPTIONS_KEY);
    if (!parsed || !Array.isArray(parsed)) {
      return [...DEFAULT_TAGS];
    }
    return this.normalizeTags(parsed);
  }

  private async loadModTags(): Promise<ModTagsStorage> {
    const parsed = await this.store.getItem<ModTagsStorage>(this.MOD_TAGS_KEY);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const normalized: ModTagsStorage = {};
    for (const [modId, tags] of Object.entries(parsed)) {
      const cleaned = this.normalizeTags(tags ?? []);
      if (cleaned.length) {
        normalized[modId] = cleaned;
      }
    }
    if (Object.keys(normalized).length !== Object.keys(parsed).length) {
      void this.store.setItem(this.MOD_TAGS_KEY, normalized);
    }
    return normalized;
  }

  private async loadSelectedTags(): Promise<string[]> {
    const parsed = await this.store.getItem<string[]>(this.SELECTED_TAGS_KEY);
    if (!parsed || !Array.isArray(parsed)) {
      return [];
    }
    const cleaned = this.normalizeTags(parsed);
    if (cleaned.length !== parsed.length) {
      void this.store.setItem(this.SELECTED_TAGS_KEY, cleaned);
    }
    return cleaned;
  }

  private async loadTagMatchMode(): Promise<TagMatchMode> {
    const parsed = await this.store.getItem<TagMatchMode>(this.TAG_MATCH_MODE_KEY);
    if (parsed === 'all') {
      return 'all';
    }
    return 'any';
  }

  private async loadOutdatedOnly(): Promise<boolean> {
    const parsed = await this.store.getItem<boolean>(this.OUTDATED_ONLY_KEY);
    if (typeof parsed !== 'boolean') {
      return false;
    }
    return parsed;
  }

  private async loadHiddenOnly(): Promise<boolean> {
    const parsed = await this.store.getItem<boolean>(this.HIDDEN_ONLY_KEY);
    if (typeof parsed !== 'boolean') {
      return false;
    }
    return parsed;
  }

  private async loadMissingSteamOnly(): Promise<boolean> {
    const parsed = await this.store.getItem<boolean>(
      this.MISSING_STEAM_ONLY_KEY,
    );
    if (typeof parsed !== 'boolean') {
      return false;
    }
    return parsed;
  }

  private async loadHasRulesOnly(): Promise<boolean> {
    const parsed = await this.store.getItem<boolean>(this.HAS_RULES_ONLY_KEY);
    if (typeof parsed !== 'boolean') {
      return false;
    }
    return parsed;
  }

  private async loadHasAdultContentOnly(): Promise<boolean> {
    const parsed = await this.store.getItem<boolean>(
      this.HAS_ADULT_CONTENT_ONLY_KEY,
    );
    if (typeof parsed !== 'boolean') {
      return false;
    }
    return parsed;
  }

  private async loadFavoritedOnly(): Promise<boolean> {
    const parsed = await this.store.getItem<boolean>(this.FAVORITED_ONLY_KEY);
    if (typeof parsed !== 'boolean') {
      return false;
    }
    return parsed;
  }

  private normalizeTag(value: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) {
      return '';
    }
    const key = trimmed.toLowerCase();
    return this.tagAliases[key] ?? trimmed;
  }

  private normalizeTags(tags: string[]): string[] {
    const cleaned = Array.from(
      new Set(
        (tags ?? [])
          .map((t) => this.normalizeTag(t))
          .filter((t) => t.length > 0),
      ),
    ).sort((a, b) => a.localeCompare(b));
    return cleaned;
  }
}
