import { ChangeDetectionStrategy, Component, HostListener, Input, Output, EventEmitter } from '@angular/core';
import type { CharacterCustomizationOption } from '../../models/character.models';

@Component({
  selector: 'app-character-option-picker',
  standalone: true,
  template: `
    <div class="asset-option-picker">
      <button type="button" class="asset-option-trigger" [attr.aria-expanded]="open" (click)="toggleOpen()">
        <span class="asset-option-value">{{ selectedLabel() }}</span>
        <span class="asset-option-chevron">▾</span>
      </button>
      @if (open) {
        <div class="asset-option-menu" role="listbox">
          <input
            class="asset-option-filter"
            type="search"
            [value]="filterText"
            placeholder="Filter options"
            aria-label="Filter options"
            (input)="filterOptions($any($event.target).value)" />
          <button type="button" class="asset-option-item" [class.selected]="!value" (click)="choose('')">
            <span>{{ noneLabel }}</span>
          </button>
          @for (option of filteredOptions(); track option.id) {
            <button
              type="button"
              class="asset-option-item"
              [class.selected]="option.id === value"
              (click)="choose(option.id)">
              <span>{{ option.label }}</span>
            </button>
          }
          @if (!filteredOptions().length) {
            <p class="asset-option-empty">No matching options.</p>
          }
        </div>
      }
    </div>
  `,
  styleUrl: './character-option-picker.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CharacterOptionPickerComponent {
  @Input() options: CharacterCustomizationOption[] = [];
  @Input() value = '';
  @Input() noneLabel = 'None';
  @Output() valueChange = new EventEmitter<string>();

  open = false;
  filterText = '';

  toggleOpen(): void {
    this.open = !this.open;
    if (!this.open) this.filterText = '';
  }

  filterOptions(value: string): void {
    this.filterText = value;
  }

  filteredOptions(): CharacterCustomizationOption[] {
    const filter = this.filterText.trim().toLocaleLowerCase();
    if (!filter) return this.options;
    return this.options.filter((option) =>
      `${option.label} ${option.id}`.toLocaleLowerCase().includes(filter),
    );
  }

  selectedLabel(): string {
    return this.options.find((option) => option.id === this.value)?.label ?? this.noneLabel;
  }

  choose(id: string): void {
    this.value = id;
    this.valueChange.emit(id);
    this.open = false;
    this.filterText = '';
  }

  @HostListener('document:pointerdown', ['$event'])
  closeWhenOutside(event: PointerEvent): void {
    const target = event.target as HTMLElement | null;
    if (this.open && target && !target.closest('app-character-option-picker')) {
      this.open = false;
      this.filterText = '';
    }
  }
}
