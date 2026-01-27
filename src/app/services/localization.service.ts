import { Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom, Subject } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { HttpClient } from '@angular/common/http';
import { TauriStoreService } from './tauri-store.service';
import { SUPPORTED_LOCALES } from '../i18n/locales';
import { locale as osLocale } from '@tauri-apps/plugin-os';
import { PrimeNG } from 'primeng/config';

@Injectable({
  providedIn: 'root',
})
export class LocalizationService {
  private readonly LOCALE_KEY = 'pz_locale';
  private readonly localeSubject = new BehaviorSubject<string>('en-US');
  readonly locale$ = this.localeSubject.asObservable();
  private readonly localeLoadingSubject = new BehaviorSubject<boolean>(false);
  readonly localeLoading$ = this.localeLoadingSubject.asObservable();
  private localeLoadingCount = 0;
  private initPromise: Promise<void> | null = null;
  private readonly loadedLocales = new Set<string>();
  private readonly loadedServerScopes = new Set<string>();
  private readonly cacheEventsSubject = new Subject<{
    type: 'locale' | 'page' | 'tab';
    name: string;
  }>();
  readonly cacheEvents$ = this.cacheEventsSubject.asObservable();

  constructor(
    private readonly store: TauriStoreService,
    private readonly transloco: TranslocoService,
    private readonly primeng: PrimeNG,
    private readonly http: HttpClient,
  ) {
    void this.init();
    this.syncPrimeNgTranslations();
  }

  get locale(): string {
    return this.localeSubject.value;
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.loadLocale();
    }
    return this.initPromise;
  }

  async setLocale(locale: string): Promise<void> {
    const cleaned = this.normalizeLocale(locale);
    if (!cleaned || cleaned === this.localeSubject.value) {
      return;
    }
    this.beginLocaleLoading();
    try {
      await this.preloadLocale(cleaned);
      this.applyLocale(cleaned);
      void this.store.setItem(this.LOCALE_KEY, cleaned);
    } finally {
      this.endLocaleLoading();
    }
  }

  private async loadLocale(): Promise<void> {
    const stored = await this.store.getItem<string>(this.LOCALE_KEY);
    const cleaned = this.normalizeLocale(stored);
    if (cleaned) {
      await this.preloadLocale(cleaned);
      this.applyLocale(cleaned);
      return;
    }
    const detected = await this.resolveSystemLocale();
    await this.preloadLocale(detected);
    this.applyLocale(detected);
    void this.store.setItem(this.LOCALE_KEY, detected);
  }

  private applyDocumentLocale(locale: string): void {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.lang = locale;
  }

  private applyLocale(locale: string): void {
    if (!locale) {
      return;
    }
    if (locale !== this.localeSubject.value) {
      this.localeSubject.next(locale);
    }
    this.transloco.setActiveLang(locale);
    this.applyDocumentLocale(locale);
  }

  private async preloadLocale(locale: string): Promise<void> {
    const normalized = this.normalizeLocale(locale);
    if (!normalized || this.loadedLocales.has(normalized)) {
      return;
    }
    await firstValueFrom(this.transloco.selectTranslation(normalized));
    this.loadedLocales.add(normalized);
    await this.preloadServerScopes(normalized);
    this.notifyCache({ type: 'locale', name: normalized });
  }

  beginLocaleLoading(): void {
    this.localeLoadingCount += 1;
    if (this.localeLoadingCount === 1) {
      this.localeLoadingSubject.next(true);
    }
  }

  endLocaleLoading(): void {
    this.localeLoadingCount = Math.max(this.localeLoadingCount - 1, 0);
    if (this.localeLoadingCount === 0) {
      this.localeLoadingSubject.next(false);
    }
  }

  private async preloadServerScopes(locale: string): Promise<void> {
    const scopes = ['ini', 'sandbox', 'spawnpoints', 'spawnregions'];
    await Promise.all(
      scopes.map(async (scope) => {
        const key = `${scope}:${locale}`;
        if (this.loadedServerScopes.has(key)) {
          return;
        }
        try {
          const data = await this.fetchJsonWithTimeout(
            `/assets/i18n/server/${scope}/${locale}.json`,
            3000,
          );
          const payload =
            scope === 'ini'
              ? { server: { ini: (data as { ini?: Record<string, string> }).ini ?? data } }
              : { server: { [scope]: data } };
          this.transloco.setTranslation(payload, locale, { merge: true });
          this.loadedServerScopes.add(key);
          this.notifyCache({ type: 'page', name: `server:${key}` });
        } catch {
          // Ignore missing scope files.
        }
      }),
    );
  }

  private async fetchJsonWithTimeout(
    url: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    try {
      const data = await Promise.race([
        firstValueFrom(this.http.get<Record<string, unknown>>(url)),
        new Promise<Record<string, unknown>>((resolve) =>
          setTimeout(() => resolve({}), timeoutMs),
        ),
      ]);
      return data ?? {};
    } catch {
      return {};
    }
  }

  notifyCache(event: { type: 'locale' | 'page' | 'tab'; name: string }): void {
    if (!event.name) {
      return;
    }
    this.cacheEventsSubject.next(event);
  }

  private syncPrimeNgTranslations(): void {
    this.transloco.selectTranslateObject('primeng').subscribe((translation) => {
      if (!translation || Object.keys(translation).length === 0) {
        return;
      }
      this.primeng.setTranslation(translation);
    });
  }

  private normalizeLocale(locale: string | null | undefined): string {
    const raw = (locale ?? '').trim();
    if (!raw) {
      return '';
    }
    const normalized = raw.split('@')[0].split('.')[0].replace('_', '-');
    const parts = normalized.split('-').filter(Boolean);
    if (parts.length === 0) {
      return '';
    }
    const language = parts[0].toLowerCase();
    const region = parts.length > 1 ? parts[1].toUpperCase() : '';
    const candidate = region ? `${language}-${region}` : language;
    const directMatch = SUPPORTED_LOCALES.find(
      (supported) => supported.toLowerCase() === candidate.toLowerCase(),
    );
    if (directMatch) {
      return directMatch;
    }
    const languageMatch = SUPPORTED_LOCALES.find((supported) =>
      supported.toLowerCase().startsWith(`${language}-`),
    );
    if (languageMatch) {
      return languageMatch;
    }
    return '';
  }

  private async resolveSystemLocale(): Promise<string> {
    if (this.store.isTauriRuntime()) {
      try {
        const tauriLocale = await osLocale();
        const cleaned = this.normalizeLocale(tauriLocale);
        if (cleaned) {
          return cleaned;
        }
      } catch {
        // Fall back to browser locale hints.
      }
    }
    const browserLocale = LocalizationService.getBrowserLocale();
    const cleaned = this.normalizeLocale(browserLocale);
    return cleaned || 'en-US';
  }

  private static getBrowserLocale(): string {
    if (typeof navigator === 'undefined') {
      return '';
    }
    const language = navigator.languages?.[0] || navigator.language || '';
    if (language) {
      return language;
    }
    if (typeof Intl !== 'undefined') {
      return Intl.DateTimeFormat().resolvedOptions().locale || '';
    }
    return '';
  }
}
