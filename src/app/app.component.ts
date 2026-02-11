import { Component, DestroyRef, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet } from '@angular/router';
import { AppConfigurator } from './layout/component/app.configurator';
import { WindowStateService } from './services/window-state.service';
import { DialogModule } from 'primeng/dialog';
import { StepperModule } from 'primeng/stepper';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TauriStoreService } from './services/tauri-store.service';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import {
  RequiredFoldersComponent,
  RequiredFoldersDraft,
} from './components/required-folders/required-folders.component';
import { SteamApiKeyStepComponent } from './components/onboarding/steam-api-key-step/steam-api-key-step.component';
import { AppContentLoadingService } from './services/app-content-loading.service';
import { LoadoutsService } from './services/loadouts.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AppUpdateService } from './services/app-update.service';
import { PzDefaultPathsService } from './services/pz-default-paths.service';
import { TranslocoModule } from '@jsverse/transloco';
import { installPerfConsoleHelpers, profileAsync } from './utils/perf-trace';
import { SteamApiKeyService } from './services/steam-api-key.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    AppConfigurator,
    DialogModule,
    StepperModule,
    ButtonModule,
    CardModule,
    ProgressSpinnerModule,
    RequiredFoldersComponent,
    SteamApiKeyStepComponent,
    TranslocoModule,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent implements OnInit {
  // Injecting WindowStateService ensures it is instantiated
  // and starts managing the Tauri window state.
  onboardingVisible = false;
  onboardingStep = 0;
  foldersDraft: RequiredFoldersDraft = {
    pzGameDir: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\ProjectZomboid',
    pzWorkshopDir: 'C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\108600',
    pzUserDir: '',
  };
  steamApiKeyDraft = '';
  contentReady = false;
  private skipContentLoading = false;

  constructor(
    private readonly windowState: WindowStateService,
    private readonly store: TauriStoreService,
    private readonly router: Router,
    private readonly contentLoading: AppContentLoadingService,
    private readonly destroyRef: DestroyRef,
    private readonly loadoutsApi: LoadoutsService,
    private readonly appUpdate: AppUpdateService,
    private readonly pzDefaults: PzDefaultPathsService,
    private readonly steamApiKeyService: SteamApiKeyService,
  ) {}

  async ngOnInit(): Promise<void> {
    await profileAsync('app.ngOnInit', async () => {
      installPerfConsoleHelpers();
      void this.store.prewarm();
      this.skipContentLoading = this.isReloadNavigation();
      void this.appUpdate.checkForUpdate();

      this.contentLoading.ready$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((ready) => {
          this.contentReady = ready;
        });

      const [bootstrapState, apiKey] = await Promise.all([
        this.store.getItems(['pz_mods', 'pz_mod_folder', 'pz_game_dir']),
        this.steamApiKeyService.get(),
      ]);
      const hasAnyData =
        bootstrapState['pz_mods'] !== null ||
        bootstrapState['pz_mod_folder'] !== null ||
        bootstrapState['pz_game_dir'] !== null ||
        !!apiKey;

      this.onboardingVisible = !hasAnyData;

      if (this.onboardingVisible) {
        const [
          defaultGameDir,
          defaultWorkshopDir,
          onboardingState,
        ] = await Promise.all([
          this.pzDefaults.getDefaultGameDir(),
          this.pzDefaults.getDefaultWorkshopDir(),
          this.store.getItems(['pz_game_dir', 'pz_mod_folder', 'pz_user_dir']),
        ]);

        const storedGame = onboardingState['pz_game_dir'] as string | null;
        const storedWorkshop = onboardingState['pz_mod_folder'] as string | null;
        const storedUserDir = onboardingState['pz_user_dir'] as string | null;

        const detectedUserDir =
          (storedUserDir || '').trim() ||
          (await this.loadoutsApi.getDefaultZomboidUserDir()) ||
          '';

        this.foldersDraft = {
          pzGameDir:
            (storedGame || '').trim() || defaultGameDir,
          pzWorkshopDir:
            (storedWorkshop || '').trim() || defaultWorkshopDir,
          pzUserDir: detectedUserDir,
        };
        this.steamApiKeyDraft = (apiKey ?? '').toString();
      }
    });
  }

  get showContentLoading(): boolean {
    return !this.skipContentLoading && !this.onboardingVisible && !this.contentReady;
  }

  async finishOnboarding(): Promise<void> {
    const previousHonu =
      (await this.store.getItem<string>('pz_honu_mod_info_qol_dir')) ?? '';
    const nextHonu = this.toHonuModInfoQolDir(this.foldersDraft.pzUserDir);

    await this.store.setItem('pz_game_dir', this.foldersDraft.pzGameDir.trim());
    await this.store.setItem('pz_mod_folder', this.foldersDraft.pzWorkshopDir.trim());
    await this.store.setItem(
      'pz_honu_mod_info_qol_dir',
      nextHonu,
    );
    await this.store.setItem('pz_user_dir', this.foldersDraft.pzUserDir.trim());
    await this.steamApiKeyService.set(this.steamApiKeyDraft.trim());

    const honuChanged = previousHonu.trim() !== nextHonu;
    if (honuChanged) {
      await this.store.setItem(
        'pz_honu_mod_info_qol_dir_changed_at',
        new Date().toISOString(),
      );
    }

    await this.store.setItem('pz_onboarding_completed', true);
    await this.store.setItem('pz_onboarding_just_finished', true);

    // Remove the onboarding UI immediately, then navigate to the Mods list.
    this.onboardingVisible = false;
    this.onboardingStep = 0;
    await this.router.navigate(['/']);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('pz-onboarding-finished'));
    }
  }

  private toHonuModInfoQolDir(userDir: string): string {
    const cleaned = (userDir ?? '').trim().replace(/[\\/]+$/, '');
    if (!cleaned) {
      return '';
    }
    return `${cleaned}/Lua`;
  }

  private isReloadNavigation(): boolean {
    if (typeof performance === 'undefined') {
      return false;
    }
    const entries = performance.getEntriesByType?.('navigation') as
      | PerformanceNavigationTiming[]
      | undefined;
    if (entries && entries.length) {
      return entries[0].type === 'reload';
    }
    const legacy = (performance as { navigation?: { type?: number } }).navigation;
    return legacy?.type === 1;
  }

}
