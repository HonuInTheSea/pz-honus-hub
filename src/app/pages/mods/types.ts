// Type definitions for mods page modules

import { ModSummary } from '../../models/mod.models';
import { WorkshopMetadata } from '../../services/workshop-metadata.service';

/**
 * Options for ModsPageActions
 */
export interface ModsPageActionsOptions {
  persistDebounceMs?: number;
  workshopAutoFetch?: boolean;
}

/**
 * Options for ModsPageFilter
 */
export interface ModsPageFilterOptions {
  presetFilterKey?: string;
  tagMatchMode?: 'all' | 'any';
}

/**
 * Options for ModsPageWorkshopMetadata
 */
export interface ModsPageWorkshopMetadataOptions {
  maxRetries?: number;
  retryDelay?: number;
}

/**
 * Options for ModsPagePersistence
 */
export interface ModsPagePersistenceOptions {
  persistDebounceMs?: number;
  storageKey?: string;
}

/**
 * Filter result interface
 */
export interface FilterResult {
  mods: ModSummary[];
  totalCount: number;
  filteredCount: number;
  appliedFilters: string[];
}

/**
 * Workshop metadata map type
 */
export type WorkshopMetadataMap = Record<string, WorkshopMetadata>;

/**
 * Persistence options interface
 */
export interface PersistenceOptions {
  source?: 'local' | 'workshop';
  immediate?: boolean;
}

/**
 * Filter options interface
 */
export interface FilterOptions {
  searchKeyword?: string;
  selectedTags?: string[];
  tagMatchMode?: 'all' | 'any';
  outdatedOnly?: boolean;
  hiddenOnly?: boolean;
  favoritedOnly?: boolean;
  hasRulesOnly?: boolean;
  presetFilterIds?: string[];
}

/**
 * Workshop API response interface
 */
export interface WorkshopApiResponse {
  fileid: number;
  error?: string;
  metadata: WorkshopMetadata;
}

/**
 * Scan result interface
 */
export interface ScanResult {
  summaries: ModSummary[];
  scanDuration: number;
  modCount: number;
}

/**
 * Folder selection result interface
 */
export interface FolderSelectionResult {
  path: string | null;
  isValid: boolean;
  error?: string;
}

/**
 * Preset filter cache interface
 */
export interface PresetFilterCache {
  presetIds: string[];
  modIds: Set<string>;
  lastUpdated: Date;
}

/**
 * Metadata merge result interface
 */
export interface MetadataMergeResult {
  mergedCount: number;
  newCount: number;
  updatedCount: number;
  errors: string[];
}

/**
 * Storage persistence result interface
 */
export interface PersistenceResult {
  success: boolean;
  storageKey: string;
  dataLength: number;
  duration: number;
  error?: string;
}

/**
 * Utility function options interface
 */
export interface UtilityOptions {
  locale?: string;
  debounceMs?: number;
  maxRetries?: number;
}

/**
 * Error handling interface
 */
export interface ErrorInfo {
  message: string;
  code?: string;
  context?: string;
  timestamp: Date;
  stack?: string;
}

/**
 * Loading state interface
 */
export interface LoadingState {
  source: 'local' | 'workshop' | null;
  isActive: boolean;
  progress?: number;
  message?: string;
}

/**
 * Tag count interface
 */
export interface TagCounts {
  [tag: string]: number;
}

/**
 * Workshop metadata aggregation interface
 */
export interface WorkshopMetadataAggregation {
  totalMetadata: number;
  validMetadata: number;
  errorMetadata: number;
  averageFileSize: number;
  oldestUpdate: Date | null;
  newestUpdate: Date | null;
}
