import { Directive, DestroyRef, inject } from '@angular/core';
import { MessageService } from 'primeng/api';
import { TauriStoreService } from '../services/tauri-store.service';
import { guard, checkDestroyed } from '../utils/destruction-guard';
import { AppContentLoadingService } from '../services/app-content-loading.service';
import { ModsActionsService } from '../services/mods-actions.service';

@Directive()
export abstract class BasePageComponent {
  /**
   * Injected DestroyRef for use in subclasses (e.g., for takeUntilDestroyed).
   */
  protected readonly destroyRef = inject(DestroyRef);

  /**
   * Injected TauriStoreService for persistence.
   */
  protected readonly store = inject(TauriStoreService);

  /**
   * Injected MessageService for toasts.
   */
  protected readonly messageService = inject(MessageService);

  /**
   * Injected AppContentLoadingService to manage page loading state.
   */
  protected readonly contentLoading = inject(AppContentLoadingService);

  /**
   * Injected ModsActionsService for mod-related triggers and state.
   */
  protected readonly modsActions = inject(ModsActionsService);

  protected readonly untilDestroyed = <T>(p: Promise<T>) => guard(this.destroyRef, p);
  protected readonly check = () => checkDestroyed(this.destroyRef);
}