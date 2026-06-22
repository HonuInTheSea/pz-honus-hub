# Mods Page Modularization Guide

## Overview

The `mods.page.ts` file has been modularized into smaller, focused components for better maintainability, testability, and performance. This document explains the new architecture and how to use the modularized code.

## Benefits of Modularization

1. **Single Responsibility Principle**: Each module has one clear purpose
2. **Testability**: Modules can be unit tested in isolation
3. **Reusability**: Common logic can be shared across components
4. **Maintainability**: Easier to find and modify specific functionality
5. **Readability**: Smaller files are easier to understand
6. **Performance**: Only the necessary modules need to be loaded

## Module Structure

```
src/app/pages/mods/
├── mods.page.ts (original - can be deleted after migration)
├── mods.page-refactored.ts (new refactored component)
├── actions/
│   └── mods-page-actions.ts (User actions and operations)
├── filters/
│   └── mods-page-filter.ts (Mod filtering logic)
├── workshop/
│   └── mods-page-workshop-metadata.ts (Workshop metadata operations)
├── persistence/
│   └── mods-page-persistence.ts (Persistence and storage operations)
└── utils/
    └── mods-page-utils.ts (Helper utilities)
```

## Module Descriptions

### 1. ModsPageActions (`actions/mods-page-actions.ts`)

**Purpose**: Handles user actions and operations

**Key Methods**:
- `scan()` - Perform local folder scanning
- `syncWorkshopMetadata()` - Fetch and update Workshop metadata
- `pickFolder()` - Open folder picker dialog

**Dependencies**: `MessageService`, `TranslocoService`, `LocalizationService`

**Responsibilities**:
- User-triggered operations
- Error handling and user feedback
- Loading state management

### 2. ModsPageFilter (`filters/mods-page-filter.ts`)

**Purpose**: Handles mod filtering logic

**Key Methods**:
- `applyFilters()` - Apply all filters to mods list
- `matchesSearch()` - Search keyword filtering
- `matchesPresetFilter()` - Preset-based filtering
- `matchesTagFilter()` - Tag-based filtering
- `matchesAdvancedFilters()` - Advanced filters (outdated, hidden, etc.)
- `refreshPresetFilterCache()` - Update preset cache

**Dependencies**: `ModsTagsService`, `LoadoutsStateService`

**Responsibilities**:
- Search filtering
- Tag matching
- Preset filtering
- Advanced filtering (outdated mods, hidden mods, adult content, etc.)

### 3. ModsPageWorkshopMetadata (`workshop/mods-page-workshop-metadata.ts`)

**Purpose**: Handles Workshop metadata operations

**Key Methods**:
- `fetchBatchMetadata()` - Fetch metadata for multiple mods
- `mergeMetadata()` - Merge new metadata with existing
- `getMetadata()` - Get all stored metadata
- `mergeWorkshopMetadataIntoMods()` - Attach metadata to mod objects
- `maybeUpdateHonuModsDb()` - Update external database if needed

**Dependencies**: None (pure data management)

**Responsibilities**:
- Metadata fetching from Steam API
- Metadata storage and management
- Metadata merging and synchronization

### 4. ModsPagePersistence (`persistence/mods-page-persistence.ts`)

**Purpose**: Handles persistence and storage operations

**Key Methods**:
- `saveModsToStorage()` - Save mods with debouncing
- `persistFolderSelection()` - Save folder path
- `persistPresetFilterIds()` - Save preset filter selections
- `persistWorkshopAutoFetch()` - Save auto-fetch preference
- `persistItemsPerPage()` - Save page size preference

**Dependencies**: `ModsStateService`, `StoreService`

**Responsibilities**:
- State persistence to Tauri store
- Debounced saves for performance
- Cache management
- Migration handling

### 5. ModsPageUtils (`utils/mods-page-utils.ts`)

**Purpose**: Provides shared utility functions

**Key Methods**:
- `isNumericId()` - Validate workshop IDs
- `steamWorkshopUrl()` - Generate Steam Workshop URL
- `getFolderId()` - Extract folder ID from mod path
- `normalizeModRefs()` - Parse mod reference strings
- `computeIncompatibleWithModIds()` - Find incompatible mods
- `formatDateTime()` - Format timestamps for display
- `debounce()` - Create debounced function

**Dependencies**: None (pure utility functions)

**Responsibilities**:
- Common utility operations
- String parsing and formatting
- ID validation
- Date/time formatting

## Migration Guide

### Step 1: Update Component Dependencies

Update your component's constructor to inject the services needed by each module:

```typescript
constructor(
  private readonly messageService: MessageService,
  private readonly transloco: TranslocoService,
  private readonly localization: LocalizationService,
  private readonly tagsService: ModsTagsService,
  private readonly loadoutsState: LoadoutsStateService,
  private readonly workshopMetadataService: WorkshopMetadataService,
  private readonly modsState: ModsStateService,
  private readonly store: TauriStoreService,
  private readonly steamApiKeyService: SteamApiKeyService,
) {}
```

### Step 2: Initialize Modules

Initialize the modularized components in your component:

```typescript
private readonly actions = new ModsPageActions(
  this.messageService,
  this.transloco,
  this.localization,
);

private readonly filter = new ModsPageFilter(
  this.tagsService,
  this.loadoutsState,
);

private readonly workshopMetadata = new ModsPageWorkshopMetadata();

private readonly persistence = new ModsPagePersistence(
  this.modsState,
  this.store,
);
```

### Step 3: Replace Method Calls

Replace the old monolithic method calls with calls to the modularized components:

```typescript
// Old approach
async scan(force = false) {
  // 100+ lines of mixed logic
}

// New approach
async scan(force = false): Promise<void> {
  await this.actions.scan(this.modService);
}
```

### Step 4: Update Filtering Logic

Replace the filtering logic in `applyFilters()`:

```typescript
applyFilters(): void {
  profileSync('mods.applyFilters', () => {
    this.filteredMods = this.filter.applyFilters(
      this.mods,
      this.searchKeyword,
      this.tagsService,
    );
    this.updateTagCounts(this.filteredMods);
    this.first = 0;
  });
}
```

### Step 5: Update Persistence Calls

Replace direct storage calls with persistence module methods:

```typescript
// Old approach
void this.store.setItem('pz_mod_folder', folderPath);

// New approach
await this.persistence.persistFolderSelection(folderPath);
```

## Testing

### Unit Testing

Each module can be tested in isolation:

```typescript
describe('ModsPageFilter', () => {
  let filter: ModsPageFilter;
  let tagsService: jasmine.SpyObj<ModsTagsService>;
  let loadoutsState: jasmine.SpyObj<any>;

  beforeEach(() => {
    tagsService = jasmine.createSpyObj<ModsTagsService>('ModsTagsService', [
      'getTagsForMod',
      'selectedTags',
      'tagMatchMode',
    ]);
    loadoutsState = jasmine.createSpyObj<any>('LoadoutsStateService', ['load']);

    filter = new ModsPageFilter(tagsService, loadoutsState);
  });

  it('should filter mods by search keyword', () => {
    const mods = [
      { name: 'Test Mod 1', id: '1' },
      { name: 'Test Mod 2', id: '2' },
    ];
    const result = filter.applyFilters(mods, 'Test 1', tagsService);
    expect(result.length).toBe(1);
  });
});
```

### Integration Testing

Test the integration between modules:

```typescript
describe('ModsPageComponent Integration', () => {
  let component: ModsPageComponent;
  let fixture: ComponentFixture<ModsPageComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      // ... test configuration
    }).compileComponents();
  });

  it('should apply filters correctly when mod is updated', () => {
    component.ngOnInit();
    fixture.detectChanges();

    // Simulate mod update
    const updatedMod = { id: '1', name: 'Updated Mod', hidden: false };
    component.onModUpdated(updatedMod);

    // Verify filters were reapplied
    expect(component.filteredMods.length).toBeGreaterThan(0);
  });
});
```

## Performance Considerations

### Debounced Saves

The persistence module implements debounced saves to prevent excessive storage operations:

```typescript
// Save with debounce (default 150ms)
await this.persistence.saveModsToStorage();

// Force immediate save
await this.persistence.saveModsToStorage(undefined, true);
```

### Lazy Loading

Consider lazy loading modules for larger applications:

```typescript
// In app.config.ts
providers: [
  {
    provide: 'MODS_PAGE_MODULES',
    useFactory: async () => {
      const { ModsPageActions } = await import('./pages/mods/actions/mods-page-actions');
      const { ModsPageFilter } = await import('./pages/mods/filters/mods-page-filter');
      return { ModsPageActions, ModsPageFilter };
    },
    deps: [],
  },
]
```

## Common Patterns

### Error Handling

The actions module provides consistent error handling:

```typescript
try {
  await this.actions.scan(modService);
} catch (error) {
  console.error('Scan failed:', error);
  // Error message is already shown via MessageService
}
```

### State Management

Modules maintain their own state but can be synchronized:

```typescript
// Workshop metadata state
this.workshopMetadata.mergeMetadata(newMetadata);
const metadata = this.workshopMetadata.getMetadata();

// Filter state
this.filter.setPresetFilterIds(selectedPresets);
```

## Troubleshooting

### Module Not Found Errors

Ensure all modules are properly imported:

```typescript
import { ModsPageActions } from './actions/mods-page-actions';
import { ModsPageFilter } from './filters/mods-page-filter';
// ... other imports
```

### Dependency Injection Issues

Make sure all required services are provided:

```typescript
providers: [
  MessageService,
  TranslocoService,
  ModsTagsService,
  // ... other dependencies
]
```

### State Synchronization

If state isn't updating, ensure proper module initialization:

```typescript
constructor(
  private readonly modService: ModService,
  // ...
) {
  this.filter = new ModsPageFilter(tagsService, loadoutsState);
  this.workshopMetadata = new ModsPageWorkshopMetadata();
  // Ensure modules have access to shared state
}
```

## Future Enhancements

1. **State Management**: Consider using NgRx or Signals for more complex state management
2. **Web Workers**: Move heavy filtering operations to Web Workers
3. **Caching**: Implement caching for expensive operations
4. **Type Safety**: Add more specific TypeScript types for better IDE support
5. **Testing**: Increase test coverage for edge cases

## Conclusion

Modularizing the mods page has significantly improved the codebase's maintainability and testability. By separating concerns into focused modules, we've created a foundation that's easier to understand, test, and extend.

For questions or issues, please refer to the unit tests or contact the development team.
