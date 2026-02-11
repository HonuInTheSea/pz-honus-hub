import { Component, DestroyRef, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ModSummary } from '../../models/mod.models';
import { ModsActionsService } from '../../services/mods-actions.service';
import { Table, TableModule } from 'primeng/table';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { convertFileSrc } from '@tauri-apps/api/core';
import { MultiSelectModule } from 'primeng/multiselect';
import { ModsTagsService } from '../../services/mods-tags.service';
import { TooltipModule } from 'primeng/tooltip';
import { ModDetailsComponent } from '../mod-details/mod-details.component';
import { DialogModule } from 'primeng/dialog';
import type { TablePageEvent } from 'primeng/types/table';
import { LocalizationService } from '../../services/localization.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoModule } from '@jsverse/transloco';
import { formatLocalizedDateTime } from '../../i18n/date-time';

@Component({
  selector: 'app-mod-table',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TableModule,
    InputTextModule,
    ButtonModule,
    IconFieldModule,
    InputIconModule,
    MultiSelectModule,
    TooltipModule,
    ModDetailsComponent,
    DialogModule,
    TranslocoModule,
  ],
  templateUrl: './mod-table.component.html',
})
export class ModTableComponent implements OnChanges {
  @Input() mods: ModSummary[] = [];
  @Input() allMods: ModSummary[] = [];
  @Input() rows = 25;
  @Input() first = 0;
  @Input() rowsPerPageOptions: number[] = [];
  @Output() modSelected = new EventEmitter<ModSummary>();
  @Output() rowExpanded = new EventEmitter<ModSummary>();
  @Output() workshopClicked = new EventEmitter<string>();
  @Output() creatorWorkshopClicked = new EventEmitter<string>();
  @Output() openFolderClicked = new EventEmitter<ModSummary>();
  @Output() modUpdated = new EventEmitter<ModSummary>();
  @Output() pageChange = new EventEmitter<TablePageEvent>();
  @Output() searchChanged = new EventEmitter<string>();

  tableMods: Array<
    ModSummary & {
      author_display: string;
      workshop_id_display: string;
      install_date_display: string;
      icon_url?: string;
      author_avatar_medium: string | null;
      author_avatar_full: string | null;
      author_avatar_tooltip: string;
    }
  > = [];

  detailsDialogVisible = false;
  selectedMod: ModSummary | null = null;
  searchKeyword = '';
  private currentLocale = 'en-US';

  constructor(
    private readonly modsActions: ModsActionsService,
    public readonly tagsService: ModsTagsService,
    private readonly localization: LocalizationService,
    private readonly destroyRef: DestroyRef,
  ) {
    this.currentLocale = this.localization.locale || 'en-US';
    this.localization.locale$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((locale) => {
        this.currentLocale = locale;
        this.refreshTableMods();
      });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['mods']) {
      this.refreshTableMods();
    }
  }

  private refreshTableMods(): void {
    this.tableMods = (this.mods ?? []).map((mod) => {
      const authorAvatarFull = this.resolveAuthorAvatarFull(mod);
      const authorAvatarMedium = this.resolveAuthorAvatarMedium(mod);
      return {
      ...mod,
      author_display: this.getAuthorDisplay(mod),
      workshop_id_display: mod.workshop_id || 'Unknown',
      install_date_display: mod.install_date
        ? this.formatDateTime(mod.install_date)
        : 'Unknown',
      icon_url: mod.icon ? convertFileSrc(mod.icon) : undefined,
      author_avatar_medium: authorAvatarMedium,
      author_avatar_full: authorAvatarFull,
      author_avatar_tooltip: this.buildAuthorAvatarTooltip(authorAvatarFull),
    };
    });
  }

  get allModsForLinks(): ModSummary[] {
    return (this.allMods?.length ? this.allMods : this.mods) ?? [];
  }

  onRowExpand(event: any): void {
    if (event?.data) {
      this.rowExpanded.emit(event.data as ModSummary);
    }
  }

  onPage(event: TablePageEvent): void {
    this.pageChange.emit(event);
  }

  onGlobalFilter(table: Table, event: Event) {
    const value = (event.target as HTMLInputElement).value ?? '';
    this.searchKeyword = value;
    table.filterGlobal(value, 'contains');
    this.searchChanged.emit(this.searchKeyword);
  }

  onClearFilters(table: Table): void {
    table.clear();
    this.searchKeyword = '';
    this.searchChanged.emit(this.searchKeyword);
  }

  isNumericId(id: string | undefined | null): boolean {
    if (!id) {
      return false;
    }
    return /^[0-9]+$/.test(id);
  }

  openWorkshop(id: string | undefined | null): void {
    if (!this.isNumericId(id)) {
      return;
    }
    this.workshopClicked.emit(id as string);
  }

  openCreatorWorkshop(url: string | undefined | null): void {
    if (!url) {
      return;
    }
    this.creatorWorkshopClicked.emit(url);
  }

  openFolder(mod: ModSummary): void {
    this.openFolderClicked.emit(mod);
  }

  getRelativeFolderName(mod: ModSummary): string | null {
    const base = this.modsActions.folderPath;
    const modInfoPath = mod.mod_info_path;

    if (!base || !modInfoPath) {
      return null;
    }

    const baseNorm = base.replace(/\\/g, '/');
    const modNorm = modInfoPath.replace(/\\/g, '/');

    if (!modNorm.startsWith(baseNorm)) {
      return null;
    }

    const relative = modNorm.slice(baseNorm.length).replace(/^\/+/, '');
    const parts = relative.split('/').filter((p) => p.length > 0);

    if (!parts.length) {
      return null;
    }

    return parts[0];
  }

  formatDateTime(value: string | number | null | undefined): string {
    if (value == null || value === '') {
      return '';
    }

    let timestampMs: number | null = null;

    if (typeof value === 'number') {
      // Steam Workshop timestamps are seconds since epoch.
      timestampMs = value < 1e12 ? value * 1000 : value;
    } else {
      const numeric = Number(value);
      if (!Number.isNaN(numeric)) {
        timestampMs = numeric < 1e12 ? numeric * 1000 : numeric;
      } else {
        const parsed = new Date(value).getTime();
        timestampMs = Number.isNaN(parsed) ? null : parsed;
      }
    }

    if (timestampMs == null) {
      return '';
    }

    const date = new Date(timestampMs);
    if (isNaN(date.getTime())) {
      return '';
    }

    // Use the user's locale and a consistent medium date / short time style
    // so the main Date column and the detail fields match.
    return formatLocalizedDateTime(date, this.currentLocale);
  }

  getTags(mod: ModSummary): string[] {
    return this.tagsService.getTagsForMod(mod.id);
  }

  getAuthorDisplay(mod: ModSummary): string {
    const authorRaw = (mod.author ?? '').trim();

    if (authorRaw && authorRaw.toLowerCase() !== 'unknown') {
      return authorRaw;
    }

    const creatorName = (mod.workshop?.creator_name ?? '').trim();
    if (creatorName) {
      return creatorName;
    }

    return authorRaw || 'Unknown';
  }

  private resolveAuthorAvatarMedium(mod: ModSummary): string | null {
    const workshop = mod.workshop;
    if (!workshop) {
      return null;
    }

    const avatarRaw = workshop.creator_avatar_medium;
    if (typeof avatarRaw !== 'string') {
      return null;
    }

    const avatar = avatarRaw.trim();
    return avatar ? avatar : null;
  }

  private resolveAuthorAvatarFull(mod: ModSummary): string | null {
    const workshop = mod.workshop;
    if (!workshop) {
      return null;
    }

    const avatarRaw = workshop.creator_avatar;
    if (typeof avatarRaw !== 'string') {
      return null;
    }

    const avatar = avatarRaw.trim();
    return avatar ? avatar : null;
  }

  private buildAuthorAvatarTooltip(url: string | null): string {
    if (!url) {
      return '';
    }

    // Minimal attribute escaping to keep tooltip HTML safe.
    const safeUrl = url.replace(/&/g, '&amp;').replace(/\"/g, '&quot;');
    return `<img src="${safeUrl}" class="author-avatar-tooltip" alt="Author avatar" referrerpolicy="no-referrer" />`;
  }

  onModUpdatedInternal(mod: ModSummary): void {
    this.modUpdated.emit(mod);
  }

  openModDetails(mod: ModSummary): void {
    this.selectedMod = mod;
    this.detailsDialogVisible = true;
  }
}
