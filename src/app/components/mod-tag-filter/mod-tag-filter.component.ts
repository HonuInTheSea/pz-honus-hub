import { Component, DestroyRef, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { ModsTagsService } from '../../services/mods-tags.service';
import type { OverlayListenerOptions, OverlayOptions } from 'primeng/api';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { tagKey } from '../../i18n/tag-key';
import { formatTagCount } from '../../i18n/number-format';

interface TagOption {
  label: string;
  value: string;
}

@Component({
  selector: 'app-mod-tag-filter',
  standalone: true,
  imports: [CommonModule, FormsModule, MultiSelectModule, InputTextModule, ButtonModule, TranslocoModule],
  templateUrl: './mod-tag-filter.component.html',
})
export class ModTagFilterComponent {
  @Input() compact = false;
  tagOptions: TagOption[] = [];
  selectedValues: string[] = [];
  matchMode: 'any' | 'all' = 'any';
  tagCounts: Record<string, number> = {};
  readonly overlayOptions: OverlayOptions = {
    hideOnEscape: true,
    listener: (_event: Event, options?: OverlayListenerOptions) => options?.valid,
  };

  editing = false;
  editableOptions: string[] = [];
  newTag = '';

  constructor(
    private readonly tagsService: ModsTagsService,
    private readonly destroyRef: DestroyRef,
    private readonly transloco: TranslocoService,
  ) {
    this.syncFromService();

    this.tagsService.tagOptions$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.refreshTagOptions();
      });

    this.tagsService.tagCounts$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((counts) => {
        this.tagCounts = counts ?? {};
        this.refreshTagOptions();
      });

    this.tagsService.selectedTags$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((tags) => {
        this.selectedValues = [...tags];
      });

    this.tagsService.tagMatchMode$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((mode) => {
        this.matchMode = mode;
      });

    this.transloco.langChanges$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.refreshTagOptions();
      });
  }

  private syncFromService(): void {
    this.refreshTagOptions();
    this.selectedValues = [...this.tagsService.selectedTags];
    this.editableOptions = [...this.tagsService.tagOptions];
  }

  private refreshTagOptions(): void {
    this.tagOptions = this.tagsService.tagOptions.map((t) => ({
      label: `${this.getTagLabel(t)} (${this.getTagCountLabel(t)})`,
      value: t,
    }));
  }

  private getTagLabel(tag: string): string {
    const key = `tags.${tagKey(tag)}`;
    const translated = this.transloco.translate(key);
    return translated === key ? tag : translated;
  }

  private getTagCountLabel(tag: string): string {
    const locale = this.transloco.getActiveLang() || 'en-US';
    return formatTagCount(this.tagCounts[tag] ?? 0, locale);
  }

  onSelectionChange(): void {
    this.tagsService.setSelectedTags(this.selectedValues);
  }

  onMatchModeChange(mode: 'any' | 'all'): void {
    this.tagsService.setTagMatchMode(mode);
  }

  toggleEditing(): void {
    this.editing = !this.editing;
    if (this.editing) {
      this.editableOptions = [...this.tagsService.tagOptions];
    }
  }

  addTag(): void {
    const value = this.newTag.trim();
    if (!value) {
      return;
    }
    this.editableOptions.push(value);
    this.newTag = '';
  }

  removeTag(index: number): void {
    this.editableOptions.splice(index, 1);
  }

  saveEdits(): void {
    this.tagsService.updateTagOptions(this.editableOptions);
    this.refreshTagOptions();
    this.editing = false;
  }
}
