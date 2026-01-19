export interface ModFileInfo {
  path: string;
  file_name: string;
  modified?: string;
  size: number;
}

import type { WorkshopMetadata } from '../services/workshop-metadata.service';

export interface RequiredByInfo {
  modId: string;
  name: string;
}

export interface ModSummary {
  id: string;
  mod_id?: string | null;
  name: string;
  workshop_id?: string | null;
  file_size?: number | null;
  author?: string | null;
  hidden?: boolean | null;
  favorite?: boolean | null;
  version?: string | null;
  version_min?: string | null;
  version_max?: string | null;
  install_date?: string | null;
  url?: string | null;
  requires?: string[] | null;
  dependencies?: string[] | null;
  load_after?: string[] | null;
  load_before?: string[] | null;
  incompatible?: string[] | null;
  packs?: string[] | null;
  tiledefs?: string[] | null;
  soundbanks?: string[] | null;
  worldmap?: string | null;
  icon?: string | null;
  preview_image_path?: string | null;
  poster_image_paths?: string[] | null;
  description?: string | null;
  mod_info_path?: string | null;
  // Attached Workshop metadata (joined in-memory; persisted separately)
  workshop?: WorkshopMetadata | null;
  required_by?: RequiredByInfo[] | null;
}

export interface ModFolderScanResult {
  files: ModFileInfo[];
  summaries: ModSummary[];
}
