import { Injectable } from '@angular/core';
import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { TauriStoreService } from './tauri-store.service';

interface WindowState {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized?: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class WindowStateService {
  private readonly storageKey = 'pz_window_state';
  private readonly saveDebounceMs = 500;
  private pendingSaveTimer: number | null = null;
  private lastSavedSignature: string | null = null;

  constructor(private readonly store: TauriStoreService) {
    void this.initialize();
  }

  private isTauri(): boolean {
    return (
      typeof window !== 'undefined' &&
      (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window))
    );
  }

  private async initialize(): Promise<void> {
    if (!this.isTauri()) {
      return;
    }

    const win = getCurrentWindow();

    try {
      const saved = await this.store.getItem<WindowState>(this.storageKey);
      if (saved) {
        this.lastSavedSignature = JSON.stringify({
          width: saved.width,
          height: saved.height,
          x: saved.x,
          y: saved.y,
          maximized: !!saved.maximized,
        });
        if (typeof saved.width === 'number' && typeof saved.height === 'number') {
          await win.setSize(new LogicalSize(saved.width, saved.height));
        }
        if (typeof saved.x === 'number' && typeof saved.y === 'number') {
          await win.setPosition(new LogicalPosition(saved.x, saved.y));
        }
        if (saved.maximized) {
          await win.maximize();
        }
      }
    } catch {
      // ignore restore errors
    }

    // Listen for move/resize events to persist the latest state.
    try {
      await win.onResized(() => {
        this.scheduleSave(win);
      });
      await win.onMoved(() => {
        this.scheduleSave(win);
      });
    } catch {
      // ignore listener errors
    }
  }

  private scheduleSave(win: ReturnType<typeof getCurrentWindow>): void {
    if (this.pendingSaveTimer != null) {
      window.clearTimeout(this.pendingSaveTimer);
    }

    this.pendingSaveTimer = window.setTimeout(() => {
      this.pendingSaveTimer = null;
      void this.saveCurrentState(win);
    }, this.saveDebounceMs);
  }

  private async saveCurrentState(win: ReturnType<typeof getCurrentWindow>): Promise<void> {
    try {
      const [size, position, isMaximized] = await Promise.all([
        win.outerSize(),
        win.outerPosition(),
        win.isMaximized(),
      ]);

      const state: WindowState = {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized: isMaximized,
      };

      const signature = JSON.stringify(state);
      if (signature === this.lastSavedSignature) {
        return;
      }

      this.lastSavedSignature = signature;
      await this.store.setItem(this.storageKey, state);
    } catch {
      // ignore save errors
    }
  }
}
