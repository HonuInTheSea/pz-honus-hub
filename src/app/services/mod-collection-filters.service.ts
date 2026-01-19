import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type ModCollectionSort = 'trend' | 'mostrecent' | 'lastupdated';

export interface ModCollectionFilters {
  searchText: string;
  sort: ModCollectionSort;
  days: number;
  tags: string[];
}

export interface ModCollectionTagOption {
  label: string;
  value: string;
}

const DEFAULT_FILTERS: ModCollectionFilters = {
  searchText: '',
  sort: 'trend',
  days: 7,
  tags: [],
};

@Injectable({ providedIn: 'root' })
export class ModCollectionFiltersService {
  private readonly filtersSubject = new BehaviorSubject<ModCollectionFilters>({
    ...DEFAULT_FILTERS,
  });
  private readonly tagOptionsSubject = new BehaviorSubject<ModCollectionTagOption[]>([]);

  readonly filters$ = this.filtersSubject.asObservable();
  readonly tagOptions$ = this.tagOptionsSubject.asObservable();

  get filters(): ModCollectionFilters {
    return this.filtersSubject.value;
  }

  updateFilters(next: Partial<ModCollectionFilters>): void {
    this.filtersSubject.next({
      ...this.filtersSubject.value,
      ...next,
    });
  }

  setTagOptions(options: ModCollectionTagOption[]): void {
    this.tagOptionsSubject.next(options);
  }
}
