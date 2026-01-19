import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ModSummary } from '../../models/mod.models';
import { CardModule } from 'primeng/card';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';

@Component({
  selector: 'app-mod-list',
  standalone: true,
  imports: [FormsModule, CardModule, PaginatorModule, InputTextModule, SelectModule],
  templateUrl: './mod-list.component.html',
})
export class ModListComponent implements OnChanges {
  @Input() mods: ModSummary[] = [];
  @Output() modSelected = new EventEmitter<ModSummary>();

  searchTerm = '';
  @Input() pageSize = 12;
  rows = this.pageSize;
  first = 0;
  @Input() rowsPerPageOptions: number[] = [10, 20, 30];

  get options(): { label: string; value: number }[] {
    return this.rowsPerPageOptions.map((value) => ({ label: `${value}`, value }));
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['pageSize']) {
      this.rows = this.pageSize;
      this.first = 0;
    }
  }

  get filteredMods(): ModSummary[] {
    const term = this.searchTerm.toLowerCase();
    const filtered = this.mods.filter((m) =>
      m.name.toLowerCase().includes(term),
    );
    return filtered.slice(this.first, this.first + this.rows);
  }

  onPageChange(event: PaginatorState) {
    const nextRows = event.rows ?? this.rows;
    const nextFirst = event.first ?? 0;

    if (nextRows !== this.rows) {
      this.rows = nextRows;
      this.first = 0;
      return;
    }

    this.rows = nextRows;
    this.first = nextFirst;
  }

  onRowsChange(nextRows: number): void {
    this.rows = nextRows;
    this.first = 0;
  }
}
