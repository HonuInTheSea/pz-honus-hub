import {
  ApplicationConfig,
  APP_INITIALIZER,
  isDevMode,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideTransloco, translocoConfig } from '@jsverse/transloco';

import { routes } from './app.routes';
import { TranslocoHttpLoader } from './i18n/transloco-loader';
import { SUPPORTED_LOCALES } from './i18n/locales';
import { LocalizationService } from './services/localization.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(
      routes,
      withInMemoryScrolling({
        anchorScrolling: 'enabled',
        scrollPositionRestoration: 'enabled',
      }),
    ),
    provideHttpClient(),
    provideAnimations(),
    {
      provide: APP_INITIALIZER,
      multi: true,
      deps: [LocalizationService],
      useFactory: (localization: LocalizationService) => () => localization.init(),
    },
    provideTransloco({
      config: translocoConfig({
        availableLangs: SUPPORTED_LOCALES,
        defaultLang: 'en-US',
        fallbackLang: 'en-US',
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
      }),
      loader: TranslocoHttpLoader,
    }),
  ],
};
