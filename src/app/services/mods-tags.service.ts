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
  private readonly selectedTagsDebounceMs = 200;
  private readonly tagMatchModeDebounceMs = 300;
  private readonly toggleDebounceMs = 1000;
  private persistTimer: number | null = null;
  private readonly pendingPersistValueByKey = new Map<string, unknown>();
  private readonly pendingPersistDueAtByKey = new Map<string, number>();
  private readonly persistedValueByKey = new Map<string, unknown>();

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

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.flushPendingPersists();
      });
    }
  }

  get tagOptions(): string[] {
    return this.tagOptionsSubject.value;
  }

  private async initializeFromStore(): Promise<void> {
    const snapshot = await this.store.getItems([
      this.TAG_OPTIONS_KEY,
      this.MOD_TAGS_KEY,
      this.SELECTED_TAGS_KEY,
      this.TAG_MATCH_MODE_KEY,
      this.OUTDATED_ONLY_KEY,
      this.HIDDEN_ONLY_KEY,
      this.MISSING_STEAM_ONLY_KEY,
      this.HAS_RULES_ONLY_KEY,
      this.HAS_ADULT_CONTENT_ONLY_KEY,
      this.FAVORITED_ONLY_KEY,
    ]);

    const storedOptions = this.parseTagOptions(snapshot[this.TAG_OPTIONS_KEY]);
    if (storedOptions.length) {
      this.tagOptionsSubject.next(storedOptions);
    }

    this.modTags = this.parseModTags(snapshot[this.MOD_TAGS_KEY]);

    const storedSelected = this.parseSelectedTags(snapshot[this.SELECTED_TAGS_KEY]);
    if (storedSelected.length) {
      this.selectedTagsSubject.next(storedSelected);
    }
    this.persistedValueByKey.set(this.SELECTED_TAGS_KEY, [...storedSelected]);

    const storedMatchMode = this.parseTagMatchMode(snapshot[this.TAG_MATCH_MODE_KEY]);
    this.tagMatchModeSubject.next(storedMatchMode);
    this.persistedValueByKey.set(this.TAG_MATCH_MODE_KEY, storedMatchMode);

    const storedOutdatedOnly = this.parseBoolean(snapshot[this.OUTDATED_ONLY_KEY]);
    this.outdatedOnlySubject.next(storedOutdatedOnly);
    this.persistedValueByKey.set(this.OUTDATED_ONLY_KEY, storedOutdatedOnly);

    const storedHiddenOnly = this.parseBoolean(snapshot[this.HIDDEN_ONLY_KEY]);
    this.hiddenOnlySubject.next(storedHiddenOnly);
    this.persistedValueByKey.set(this.HIDDEN_ONLY_KEY, storedHiddenOnly);

    const storedMissingSteamOnly = this.parseBoolean(
      snapshot[this.MISSING_STEAM_ONLY_KEY],
    );
    this.missingSteamOnlySubject.next(storedMissingSteamOnly);
    this.persistedValueByKey.set(
      this.MISSING_STEAM_ONLY_KEY,
      storedMissingSteamOnly,
    );

    const storedHasRulesOnly = this.parseBoolean(snapshot[this.HAS_RULES_ONLY_KEY]);
    this.hasRulesOnlySubject.next(storedHasRulesOnly);
    this.persistedValueByKey.set(this.HAS_RULES_ONLY_KEY, storedHasRulesOnly);

    const storedHasAdultContentOnly = this.parseBoolean(
      snapshot[this.HAS_ADULT_CONTENT_ONLY_KEY],
    );
    this.hasAdultContentOnlySubject.next(storedHasAdultContentOnly);
    this.persistedValueByKey.set(
      this.HAS_ADULT_CONTENT_ONLY_KEY,
      storedHasAdultContentOnly,
    );

    const storedFavoritedOnly = this.parseBoolean(snapshot[this.FAVORITED_ONLY_KEY]);
    this.favoritedOnlySubject.next(storedFavoritedOnly);
    this.persistedValueByKey.set(this.FAVORITED_ONLY_KEY, storedFavoritedOnly);
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
    this.persistDebounced(
      this.SELECTED_TAGS_KEY,
      cleaned,
      this.selectedTagsDebounceMs,
    );
  }

  get tagMatchMode(): TagMatchMode {
    return this.tagMatchModeSubject.value;
  }

  setTagMatchMode(mode: TagMatchMode): void {
    const next = mode === 'all' ? 'all' : 'any';
    this.tagMatchModeSubject.next(next);
    this.persistDebounced(
      this.TAG_MATCH_MODE_KEY,
      next,
      this.tagMatchModeDebounceMs,
    );
  }

  setTagCounts(counts: Record<string, number>): void {
    this.tagCountsSubject.next(counts);
  }

  get outdatedOnly(): boolean {
    return this.outdatedOnlySubject.value;
  }

  setOutdatedOnly(value: boolean): void {
    this.outdatedOnlySubject.next(!!value);
    this.persistDebounced(this.OUTDATED_ONLY_KEY, !!value, this.toggleDebounceMs);
  }

  get hiddenOnly(): boolean {
    return this.hiddenOnlySubject.value;
  }

  setHiddenOnly(value: boolean): void {
    this.hiddenOnlySubject.next(!!value);
    this.persistDebounced(this.HIDDEN_ONLY_KEY, !!value, this.toggleDebounceMs);
  }

  get missingSteamOnly(): boolean {
    return this.missingSteamOnlySubject.value;
  }

  setMissingSteamOnly(value: boolean): void {
    this.missingSteamOnlySubject.next(!!value);
    this.persistDebounced(
      this.MISSING_STEAM_ONLY_KEY,
      !!value,
      this.toggleDebounceMs,
    );
  }

  get hasRulesOnly(): boolean {
    return this.hasRulesOnlySubject.value;
  }

  setHasRulesOnly(value: boolean): void {
    this.hasRulesOnlySubject.next(!!value);
    this.persistDebounced(this.HAS_RULES_ONLY_KEY, !!value, this.toggleDebounceMs);
  }

  get hasAdultContentOnly(): boolean {
    return this.hasAdultContentOnlySubject.value;
  }

  setHasAdultContentOnly(value: boolean): void {
    this.hasAdultContentOnlySubject.next(!!value);
    this.persistDebounced(
      this.HAS_ADULT_CONTENT_ONLY_KEY,
      !!value,
      this.toggleDebounceMs,
    );
  }

  get favoritedOnly(): boolean {
    return this.favoritedOnlySubject.value;
  }

  setFavoritedOnly(value: boolean): void {
    this.favoritedOnlySubject.next(!!value);
    this.persistDebounced(this.FAVORITED_ONLY_KEY, !!value, this.toggleDebounceMs);
  }

  private persistDebounced(
    key: string,
    value: unknown,
    debounceMs: number,
  ): void {
    const persistedValue = this.persistedValueByKey.get(key);
    if (this.areValuesEqual(value, persistedValue)) {
      this.pendingPersistValueByKey.delete(key);
      this.pendingPersistDueAtByKey.delete(key);
      this.scheduleNextPersistFlush();
      return;
    }

    this.pendingPersistValueByKey.set(key, value);
    this.pendingPersistDueAtByKey.set(key, Date.now() + debounceMs);
    this.scheduleNextPersistFlush();
  }

  private areValuesEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) {
      return true;
    }
    if (typeof a !== typeof b) {
      return false;
    }
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }

  private scheduleNextPersistFlush(): void {
    if (this.persistTimer != null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    if (!this.pendingPersistDueAtByKey.size) {
      return;
    }

    const now = Date.now();
    let nextDueAt = Number.POSITIVE_INFINITY;
    for (const dueAt of this.pendingPersistDueAtByKey.values()) {
      if (dueAt < nextDueAt) {
        nextDueAt = dueAt;
      }
    }

    const delay = Math.max(0, nextDueAt - now);
    this.persistTimer = window.setTimeout(() => {
      void this.flushDuePersists();
    }, delay);
  }

  private async flushDuePersists(): Promise<void> {
    this.persistTimer = null;
    const now = Date.now();
    const keysToFlush: string[] = [];
    for (const [key, dueAt] of this.pendingPersistDueAtByKey.entries()) {
      if (dueAt <= now) {
        keysToFlush.push(key);
      }
    }

    for (const key of keysToFlush) {
      this.pendingPersistDueAtByKey.delete(key);
      const pending = this.pendingPersistValueByKey.get(key);
      this.pendingPersistValueByKey.delete(key);
      await this.store.setItem(key, pending);
      this.persistedValueByKey.set(key, pending);
    }

    this.scheduleNextPersistFlush();
  }

  private flushPendingPersists(): void {
    if (this.persistTimer != null) {
      window.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }

    for (const key of this.pendingPersistValueByKey.keys()) {
      const pending = this.pendingPersistValueByKey.get(key);
      void this.store.setItem(key, pending);
    }
    this.pendingPersistValueByKey.clear();
    this.pendingPersistDueAtByKey.clear();
  }

  private parseTagOptions(parsed: unknown): string[] {
    if (!parsed || !Array.isArray(parsed)) {
      return [...DEFAULT_TAGS];
    }
    return this.normalizeTags(parsed as string[]);
  }

  private parseModTags(parsed: unknown): ModTagsStorage {
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const normalized: ModTagsStorage = {};
    for (const [modId, tags] of Object.entries(parsed as ModTagsStorage)) {
      const cleaned = this.normalizeTags(tags ?? []);
      if (cleaned.length) {
        normalized[modId] = cleaned;
      }
    }
    if (Object.keys(normalized).length !== Object.keys(parsed as ModTagsStorage).length) {
      void this.store.setItem(this.MOD_TAGS_KEY, normalized);
    }
    return normalized;
  }

  private parseSelectedTags(parsed: unknown): string[] {
    if (!parsed || !Array.isArray(parsed)) {
      return [];
    }
    const cleaned = this.normalizeTags(parsed as string[]);
    if (cleaned.length !== (parsed as string[]).length) {
      void this.store.setItem(this.SELECTED_TAGS_KEY, cleaned);
    }
    return cleaned;
  }

  private parseTagMatchMode(parsed: unknown): TagMatchMode {
    if (parsed === 'all') {
      return 'all';
    }
    return 'any';
  }

  private parseBoolean(parsed: unknown): boolean {
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
