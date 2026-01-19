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

  constructor(
    private readonly windowState: WindowStateService,
    private readonly store: TauriStoreService,
    private readonly router: Router,
    private readonly contentLoading: AppContentLoadingService,
    private readonly destroyRef: DestroyRef,
    private readonly loadoutsApi: LoadoutsService,
    private readonly appUpdate: AppUpdateService,
    private readonly pzDefaults: PzDefaultPathsService,
  ) {}

  async ngOnInit(): Promise<void> {
    void this.appUpdate.checkForUpdate();

    this.contentLoading.ready$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((ready) => {
        this.contentReady = ready;
      });

    const hasAnyData =
      (await this.store.hasKey('pz_mods')) ||
      (await this.store.hasKey('pz_mod_folder')) ||
      (await this.store.hasKey('pz_game_dir')) ||
      (await this.store.hasKey('steam_api_key'));

    this.onboardingVisible = !hasAnyData;

    if (this.onboardingVisible) {
      const defaultGameDir = await this.pzDefaults.getDefaultGameDir();
      const defaultWorkshopDir = await this.pzDefaults.getDefaultWorkshopDir();
      const storedGame = await this.store.getItem<string>('pz_game_dir');
      const storedWorkshop = await this.store.getItem<string>('pz_mod_folder');
      const storedUserDir = await this.store.getItem<string>('pz_user_dir');
      const storedKey = await this.store.getItem<string>('steam_api_key');

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
      this.steamApiKeyDraft = (storedKey ?? '').toString();
    }
  }

  get showContentLoading(): boolean {
    return !this.onboardingVisible && !this.contentReady;
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
    await this.store.setItem('steam_api_key', this.steamApiKeyDraft.trim());

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

}
