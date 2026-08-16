import { Component, DestroyRef, NgZone, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet } from '@angular/router';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AppConfigurator } from './layout/component/app.configurator';
import { WindowStateService } from './services/window-state.service';
import { DialogModule } from 'primeng/dialog';
import { StepperModule } from 'primeng/stepper';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { TauriStoreService } from './services/tauri-store.service';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { ProgressBarModule } from 'primeng/progressbar';
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
import { PROJECT_ZOMBOID } from './models/pz.models';
import {
  MapBuildStatus,
  Pzmap2DziJobService,
} from './services/pzmap2dzi-job.service';

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
    ProgressBarModule,
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
    pzWorkshopDir: `C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\${PROJECT_ZOMBOID.workshopAppId}`,
    pzUserDir: '',
  };
  steamApiKeyDraft = '';
  contentReady = false;
  mapJobStatus: MapBuildStatus | null = null;
  mapJobToastDismissed = false;
  private skipContentLoading = false;
  private closeRequestInProgress = false;
  private allowWindowClose = false;
  closeConfirmationVisible = false;
  closeConfirmationBusy = false;
  closeConfirmationError = '';

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
    private readonly mapJob: Pzmap2DziJobService,
    private readonly ngZone: NgZone,
  ) {}

  async ngOnInit(): Promise<void> {
    await profileAsync('app.ngOnInit', async () => {
      installPerfConsoleHelpers();
      void this.store.prewarm();
      this.mapJob.status$
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe((status) => {
          this.mapJobStatus = status;
          if (this.mapJob.isActive(status)) {
            this.mapJobToastDismissed = false;
          }
        });
      void this.installCloseGuard();
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

  isMapJobActive(status: MapBuildStatus | null = this.mapJobStatus): boolean {
    return this.mapJob.isActive(status);
  }

  mapJobStateLabel(state: string): string {
    switch (state) {
      case 'starting':
        return 'starting';
      case 'running':
        return 'running';
      case 'stopping':
        return 'stopping';
      case 'completed':
        return 'complete';
      case 'stopped':
        return 'stopped';
      case 'error':
        return 'failed';
      default:
        return state;
    }
  }

  formatElapsed(seconds: number | null | undefined): string {
    const total = Math.max(0, Math.floor(seconds ?? 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remaining = total % 60;
    return hours > 0
      ? `${hours}h ${minutes.toString().padStart(2, '0')}m ${remaining.toString().padStart(2, '0')}s`
      : `${minutes}m ${remaining.toString().padStart(2, '0')}s`;
  }

  formatBytes(bytes: number | null | undefined): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = Math.max(0, bytes ?? 0);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
  }

  async stopMapJob(): Promise<void> {
    try {
      await this.mapJob.stop();
    } catch {
      // The job status toast will continue showing the last known state.
    }
  }

  cancelApplicationClose(): void {
    if (this.closeConfirmationBusy) {
      return;
    }
    this.closeConfirmationVisible = false;
    this.closeConfirmationError = '';
  }

  async confirmApplicationClose(): Promise<void> {
    if (this.closeConfirmationBusy) {
      return;
    }
    this.closeConfirmationBusy = true;
    this.closeConfirmationError = '';
    try {
      const status = await this.mapJob.refresh();
      if (this.mapJob.isActive(status)) {
        await this.mapJob.terminate();
      }
      this.allowWindowClose = true;
      this.closeConfirmationVisible = false;
      await getCurrentWindow().destroy();
    } catch (error) {
      this.closeConfirmationError =
        `The application could not stop the active map job: ${String(error)}`;
    } finally {
      this.closeConfirmationBusy = false;
    }
  }

  private async installCloseGuard(): Promise<void> {
    if (!this.isTauriRuntime()) {
      return;
    }
    try {
      await getCurrentWindow().onCloseRequested(async (event) => {
        if (this.allowWindowClose) {
          return;
        }
        if (this.closeRequestInProgress || this.closeConfirmationVisible) {
          event.preventDefault();
          return;
        }

        this.closeRequestInProgress = true;
        try {
          // Use the service's current snapshot so the native close request is
          // resolved synchronously. Waiting on an invoke here can leave the
          // native close event pending in WebView2.
          if (!this.mapJob.isActive()) {
            // Do not prevent the close request. Tauri's onCloseRequested
            // implementation will finish the native close for us.
            return;
          }
          event.preventDefault();
          this.ngZone.run(() => {
            this.closeConfirmationError = '';
            this.closeConfirmationVisible = true;
          });
        } catch {
          // Keep the window open if the active-job check fails.
          event.preventDefault();
        } finally {
          this.closeRequestInProgress = false;
        }
      });
    } catch {
      // Browser mode and older Tauri runtimes do not expose close interception.
    }
  }

  private isTauriRuntime(): boolean {
    return typeof window !== 'undefined' &&
      (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));
  }

  dismissMapJobToast(): void {
    if (this.isMapJobActive()) {
      return;
    }
    this.mapJobToastDismissed = true;
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
