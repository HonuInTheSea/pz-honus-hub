# 🔧 Mods Page Migration Guide

This guide shows you exactly how to migrate from the original 1,200+ line `mods.page.ts` to the modularized architecture.

## 📋 Prerequisites

- Angular 17+ with TypeScript
- All original dependencies still installed
- Tauri 2.x runtime

## 🔄 Migration Strategy

### Step 1: Create Module References

Add these imports to your component:

```typescript
// src/app/pages/mods/mods.page.ts (add these imports)

// Modularized components
import { ModsPageActions } from './actions/mods-page-actions';
import { ModsPageFilter } from './filters/mods-page-filter';
import { ModsPageWorkshopMetadata } from './workshop/mods-page-workshop-metadata';
import { ModsPagePersistence } from './persistence/mods-page-persistence';
import { ModsPageUtils } from './utils/mods-page-utils';
```

### Step 2: Add Module Properties

In your `ModsPageComponent` class, add these properties:

```typescript
export class ModsPageComponent extends BasePageComponent implements OnInit, OnDestroy {
  // ... existing properties
  
  // Modularized components
  private actions!: ModsPageActions;
  private filter!: ModsPageFilter;
  private workshopMetadata!: ModsPageWorkshopMetadata;
  private persistence!: ModsPagePersistence;
  
  // Keep some properties for backward compatibility
  private workshopMetadataById: Record<string, WorkshopMetadata> = {};
  private loadingSource: 'local' | 'workshop' | null = null;
  private presetFilterIds: string[] = [];
  private presetFilterModIds: Set<string> = new Set<string>();
  private currentLocale = 'en-US';
}
```

### Step 3: Initialize Modules in Constructor

Update your constructor:

```typescript
constructor(
  private readonly modService: ModService,
  private readonly tagsService: ModsTagsService,
  private readonly workshopMetadataService: WorkshopMetadataService,
  private readonly modsState: ModsStateService,
  private readonly loadoutsState: LoadoutsStateService,
  private readonly honuQol: HonuModInfoQolService,
  private readonly localization: LocalizationService,
  private readonly transloco: TranslocoService,
  private readonly steamApiKeyService: SteamApiKeyService,
  private readonly messageService: MessageService,
) {
  super();
  this.currentLocale = this.localization.locale || 'en-US';
  
  // Initialize modularized components
  this.actions = new ModsPageActions(
    this.messageService,
    this.transloco,
    this.localization
  );
  
  this.filter = new ModsPageFilter(
    this.tagsService,
    this.loadoutsState
  );
  
  this.workshopMetadata = new ModsPageWorkshopMetadata();
  this.persistence = new ModsPagePersistence(
    this.modsState,
    this.store // Add this to your component if not already present
  );
}
```

### Step 4: Create Helper Method for Original Functionality

Add this method to bridge old and new code:

```typescript
// Add to your component class
private create modsActionsBridge() {
  return {
    folderPath: this.modService.folderPath,
    browseFolder$: this.modService.browseFolder$,
    syncWorkshop$: this.modService.syncWorkshop$,
    createFile$: this.modService.createFile$,
    scan$: this.modService.scan$,
    checkMusicAvailability: (path: string | null) => {
      // Implement or use existing
    }
  };
}
```

### Step 5: Update ngOnInit (Simplified)

```typescript
async ngOnInit(): Promise<void> {
  await profileAsync('mods.ngOnInit', async () => {
    try {
      // Initialize modules
      await this.initializeModules();
      
      // Setup subscriptions
      this.setupEventListeners();
      this.setupSubscriptions();
      
      // Apply filters
      this.applyFilters();
      
    } catch (err) {
      if (isDestroyedError(err)) return;
      throw err;
    } finally {
      if (!this.destroyRef.destroyed) {
        this.contentLoading.markReady();
      }
    }
  });
}

private async initializeModules(): Promise<void> {
  const bootstrap = await this.store.getItems([
    'pz_onboarding_completed',
    'pz_mods_items_per_page',
    'pz_mod_folder',
  ]);

  const persistedLimit = bootstrap['pz_mods_items_per_page'] as number | null;
  const savedFolder = bootstrap['pz_mod_folder'] as string | null;
  
  if (persistedLimit) {
    this.limit = persistedLimit;
  }

  if (savedFolder) {
    this.modService.folderPath = savedFolder;
  }

  const persisted = await this.untilDestroyed(this.modsState.loadPersistedMods());
  if (persisted) {
    this.mods = persisted.local;
    this.workshopMetadataById = persisted.workshop;
  }
}

private setupEventListeners(): void {
  if (typeof window !== 'undefined') {
    window.addEventListener('pz-onboarding-finished', this.handleOnboardingFinished);
    window.addEventListener('pz-preset-filter-changed', this.onPresetFilterChanged);
  }
}

private setupSubscriptions(): void {
  this.modService.browseFolder$
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(() => void this.pickFolder());
  
  this.modService.scan$
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(() => void this.scan(true));
}
```

### Step 6: Update scan() Method

```typescript
async scan(force = false): Promise<void> {
  // Use the actions module
  await this.actions.scan(
    this.modService,
    this.mods,
    this.workshopMetadata,
    this.persistence,
    this.messageService,
    this.transloco
  );
}
```

### Step 7: Update syncWorkshopMetadata() Method

```typescript
async syncWorkshopMetadata(force = false): Promise<void> {
  await this.actions.syncWorkshopMetadata(
    this.modService,
    this.workshopMetadataService,
    this.mods,
    this.workshopMetadata,
    this.persistence,
    this.steamApiKeyService,
    this.messageService,
    this.transloco
  );
}
```

### Step 8: Update applyFilters() Method

```typescript
applyFilters(): void {
  profileSync('mods.applyFilters', () => {
    this.filteredMods = this.filter.applyFilters(
      this.mods,
      this.searchKeyword,
      this.tagsService
    );
    this.updateTagCounts(this.filteredMods);
    this.first = 0;
  });
}
```

### Step 9: Update pickFolder() Method

```typescript
async pickFolder(): Promise<void> {
  await this.actions.pickFolder(
    openDialog,
    this.modService,
    this.persistence,
    this.messageService,
    this.transloco
  );
}
```

### Step 10: Update saveModsToStorage() Method

```typescript
private async saveModsToStorage(
  source?: 'local' | 'workshop',
  options?: { immediate?: boolean }
): Promise<void> {
  await this.persistence.saveModsToStorage(
    source || 'local',
    options?.immediate || false
  );
}
```

### Step 11: Keep Utility Methods

Keep these helper methods in your component as they're simple:

```typescript
isNumericId(id: string | undefined | null): boolean {
  return ModsPageUtils.isNumericId(id);
}

steamWorkshopUrl(id: string | undefined | null): string {
  return ModsPageUtils.steamWorkshopUrl(id);
}

async openSteamWorkshop(id: string | undefined | null): Promise<void> {
  if (!this.isNumericId(id)) return;
  await openUrl(this.steamWorkshopUrl(id));
}

async openModFolder(mod: ModSummary): Promise<void> {
  if (mod.mod_info_path) {
    await invoke('open_mod_in_explorer', { path: mod.mod_info_path });
  }
}
```

### Step 12: Update ngOnDestroy()

```typescript
async ngOnDestroy(): Promise<void> {
  if (typeof window !== 'undefined') {
    window.removeEventListener('pz-onboarding-finished', this.handleOnboardingFinished);
    window.removeEventListener('pz-preset-filter-changed', this.onPresetFilterChanged);
  }

  try {
    await this.persistence.saveModsToStorage(undefined, true);
  } catch {
    // Ignore persistence errors on teardown
  }
}
```

## 🎯 Migration Checklist

- [ ] Import all module classes
- [ ] Add module properties to component
- [ ] Initialize modules in constructor
- [ ] Update `scan()` method
- [ ] Update `syncWorkshopMetadata()` method
- [ ] Update `applyFilters()` method
- [ ] Update `pickFolder()` method
- [ ] Update `saveModsToStorage()` method
- [ ] Update `ngOnInit()` method
- [ ] Update `ngOnDestroy()` method
- [ ] Test all functionality
- [ ] Update UI templates if needed
- [ ] Run full test suite

## 🔍 Testing Strategy

### 1. Unit Tests

Test each module in isolation:

```typescript
describe('ModsPageActions', () => {
  it('should handle scan operation', async () => {
    const messageService = jasmine.createSpyObj<MessageService>('MessageService', ['add']);
    const transloco = jasmine.createSpyObj<TranslocoService>('TranslocoService', ['translate']);
    const localization = jasmine.createSpyObj<LocalizationService>('LocalizationService', ['locale$']);
    
    const actions = new ModsPageActions(messageService, transloco, localization);
    
    // Test scan functionality
    await actions.scan(modService);
    
    expect(messageService.add).toHaveBeenCalled();
  });
});
```

### 2. Integration Tests

Test the interaction between modules:

```typescript
describe('ModsPageComponent Integration', () => {
  it('should filter mods correctly', () => {
    component.applyFilters();
    expect(component.filteredMods.length).toBe(expectedCount);
  });
  
  it('should persist state correctly', async () => {
    await component.saveModsToStorage('local');
    // Verify persistence
  });
});
```

### 3. E2E Tests

Test complete user workflows:

```typescript
it('should complete full mod scanning workflow', async () => {
  // Select folder
  await page.selectFolder('/path/to/mods');
  
  // Trigger scan
  await page.triggerScan();
  
  // Verify results
  expect(await page.getModCount()).toBeGreaterThan(0);
});
```

## 🚨 Common Issues and Solutions

### Issue 1: Module Not Found

**Solution**: Ensure all files exist and import paths are correct:

```typescript
// Check these paths:
import { ModsPageActions } from './actions/mods-page-actions';
import { ModsPageFilter } from './filters/mods-page-filter';
```

### Issue 2: Dependency Injection Error

**Solution**: Verify all services are provided:

```typescript
providers: [
  MessageService,
  TranslocoService,
  LocalizationService,
  // Add any other required services
]
```

### Issue 3: State Not Updating

**Solution**: Ensure proper module initialization and state management:

```typescript
constructor(
  // ...
) {
  super();
  this.actions = new ModsPageActions(
    this.messageService,
    this.transloco,
    this.localization
  );
  // Verify all dependencies are injected
}
```

### Issue 4: Performance Issues

**Solution**: Check for unnecessary re-renders:

```typescript
applyFilters(): void {
  profileSync('mods.applyFilters', () => {
    // Only reassign if changed
    const newFiltered = this.filter.applyFilters(/*...*/);
    if (newFiltered !== this.filteredMods) {
      this.filteredMods = newFiltered;
    }
  });
}
```

## 📊 Migration Timeline

| Step | Time Estimate | Complexity |
|------|---------------|------------|
| Setup (steps 1-3) | 30 minutes | Easy |
| Method updates (steps 4-10) | 2 hours | Medium |
| Testing | 1 hour | Medium |
| Bug fixes | 1-2 hours | Medium |
| Documentation | 30 minutes | Easy |
| **Total** | **~5 hours** | **Medium** |

## ✅ Success Criteria

- [ ] All original functionality works
- [ ] Test coverage > 70%
- [ ] Parse time < 100ms
- [ ] Memory usage < 20MB
- [ ] No console errors
- [ ] All user tests pass

## 🎉 Final Steps

1. **Backup original file**: `mods.page.ts` → `mods.page.backup.ts`
2. **Verify all features work**
3. **Run performance benchmarks**
4. **Update documentation**
5. **Delete backup after 2 weeks**

## 📞 Support

For issues during migration:
1. Check this guide's troubleshooting section
2. Review module documentation
3. Run unit tests to identify issues
4. Contact development team

## 🎓 Learning Resources

- [Angular Services](https://angular.io/guide/architecture-services)
- [Modular Architecture](https://en.wikipedia.org/wiki/Modular_programming)
- [Single Responsibility Principle](https://en.wikipedia.org/wiki/Single_responsibility_principle)

---

**Remember**: Take your time with the migration. Test after each step and don't hesitate to ask for help!

*Last updated: 2024* | *Version: 1.0.0* | *Angular 17+*
