import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
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
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly store: TauriStoreService,
    private readonly transloco: TranslocoService,
    private readonly primeng: PrimeNG,
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

  setLocale(locale: string): void {
    const cleaned = this.normalizeLocale(locale);
    if (!cleaned || cleaned === this.localeSubject.value) {
      return;
    }
    this.applyLocale(cleaned);
    void this.store.setItem(this.LOCALE_KEY, cleaned);
  }

  private async loadLocale(): Promise<void> {
    const stored = await this.store.getItem<string>(this.LOCALE_KEY);
    const cleaned = this.normalizeLocale(stored);
    if (cleaned) {
      this.applyLocale(cleaned);
      return;
    }
    const detected = await this.resolveSystemLocale();
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
