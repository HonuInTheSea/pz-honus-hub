import { Injectable } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';

@Injectable({
  providedIn: 'root',
})
export class ModsActionsService {
  folderPath: string | null = null;

  private readonly browseFolderSubject = new Subject<void>();
  private readonly syncWorkshopSubject = new Subject<void>();
  private readonly createFileSubject = new Subject<void>();
  private readonly scanSubject = new Subject<void>();

  readonly browseFolder$ = this.browseFolderSubject.asObservable();
  readonly syncWorkshop$ = this.syncWorkshopSubject.asObservable();
  readonly createFile$ = this.createFileSubject.asObservable();
  readonly scan$ = this.scanSubject.asObservable();

  private readonly showMediaPlayerSubject = new BehaviorSubject<boolean>(false);
  readonly showMediaPlayer$ = this.showMediaPlayerSubject.asObservable();

  triggerCreateFile(): void {
    this.createFileSubject.next();
  }

  triggerSetFolder(): void {
    this.browseFolderSubject.next();
  }

  triggerSyncWorkshop(): void {
    this.syncWorkshopSubject.next();
  }

  triggerScan(): void {
    this.scanSubject.next();
  }

  /**
   * Checks if the provided path contains any OGG files to determine
   * if the media player should be displayed in the sidebar.
   */
  async checkMusicAvailability(path: string | null) {
    if (!path) {
      this.showMediaPlayerSubject.next(false);
      return;
    }

    try {
      const hasOgg = await invoke<boolean>('has_ogg_files', { path });
      this.showMediaPlayerSubject.next(hasOgg);
    } catch (err) {
      console.error('Failed to check for OGG files:', err);
      this.showMediaPlayerSubject.next(false);
    }
  }
}
