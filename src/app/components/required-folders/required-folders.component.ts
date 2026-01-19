import { Component, EventEmitter, Input, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { PzDefaultPathsService } from '../../services/pz-default-paths.service';
import { TranslocoModule } from '@jsverse/transloco';

export interface RequiredFoldersDraft {
  pzGameDir: string;
  pzWorkshopDir: string;
  pzUserDir: string;
}

@Component({
  selector: 'app-required-folders',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    InputTextModule,
    ButtonModule,
    CardModule,
    ToggleSwitchModule,
    TranslocoModule,
  ],
  templateUrl: './required-folders.component.html',
})
export class RequiredFoldersComponent implements OnInit {
  @Input({ required: true }) draft!: RequiredFoldersDraft;
  @Output() draftChange = new EventEmitter<RequiredFoldersDraft>();
  gameDirPlaceholder = '';
  workshopDirPlaceholder = '';
  userDirPlaceholder = '';

  constructor(private readonly pzDefaults: PzDefaultPathsService) {}

  async ngOnInit(): Promise<void> {
    this.gameDirPlaceholder = await this.pzDefaults.getDefaultGameDir();
    this.workshopDirPlaceholder = await this.pzDefaults.getDefaultWorkshopDir();
    this.userDirPlaceholder = await this.pzDefaults.getDefaultUserDirExample();
  }

  async browseFor(
    target:
      | 'pzGameDir'
      | 'pzWorkshopDir'
      | 'pzUserDir',
  ): Promise<void> {
    const current =
      target === 'pzGameDir'
        ? this.draft.pzGameDir
        : target === 'pzWorkshopDir'
          ? this.draft.pzWorkshopDir
          : this.draft.pzUserDir;

    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: current,
    });

    if (typeof selected !== 'string' || !selected) {
      return;
    }

    if (target === 'pzGameDir') {
      this.draft.pzGameDir = selected;
      this.emitChange();
      return;
    }

    if (target === 'pzWorkshopDir') {
      this.draft.pzWorkshopDir = selected;
      this.emitChange();
      return;
    }

    if (target === 'pzUserDir') {
      this.draft.pzUserDir = selected;
      this.emitChange();
      return;
    }
  }

  emitChange(): void {
    this.draftChange.emit({
      pzGameDir: this.draft.pzGameDir,
      pzWorkshopDir: this.draft.pzWorkshopDir,
      pzUserDir: this.draft.pzUserDir,
    });
  }
}
