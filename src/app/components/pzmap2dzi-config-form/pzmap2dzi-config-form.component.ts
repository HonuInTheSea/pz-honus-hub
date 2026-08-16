import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, OnDestroy, Output, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DialogModule } from 'primeng/dialog';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { ProgressBarModule } from 'primeng/progressbar';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { StepperModule } from 'primeng/stepper';
import { TextareaModule } from 'primeng/textarea';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TauriStoreService } from '../../services/tauri-store.service';
import {
  MapBuildEstimate,
  MapBuildResumeCandidate,
  MapBuildStatus,
  Pzmap2DziJobService,
} from '../../services/pzmap2dzi-job.service';
import { Subscription } from 'rxjs';

type ConfigFieldType = 'text' | 'number' | 'textarea' | 'select' | 'toggle';

interface ConfigOption {
  label: string;
  value: string;
}

interface ConfigField {
  path: string;
  label: string;
  description: string;
  type: ConfigFieldType;
  options?: ConfigOption[];
  min?: number;
  max?: number;
  rows?: number;
}

interface ColorField {
  path: string;
  label: string;
  description: string;
}

interface AdditionalMapEntry {
  name: string;
  folder: string;
}

type DiskEstimate = MapBuildEstimate;
type BuildStatus = MapBuildStatus;

type MapPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';

interface MapPresetOption {
  label: string;
  value: MapPreset;
  description: string;
  detail: string;
  sizeFactor: number;
  durationFactor: number;
  settings: Record<string, unknown>;
}

interface PresetSummaryItem {
  label: string;
  value: string;
  description: string;
}

@Component({
  selector: 'app-pzmap2dzi-config-form',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    DialogModule,
    InputNumberModule,
    InputTextModule,
    MessageModule,
    ProgressBarModule,
    SelectModule,
    SelectButtonModule,
    StepperModule,
    TextareaModule,
    ToggleSwitchModule,
  ],
  templateUrl: './pzmap2dzi-config-form.component.html',
  styleUrl: './pzmap2dzi-config-form.component.css',
})
export class Pzmap2DziConfigFormComponent implements OnDestroy {
  @Output() refreshRequested = new EventEmitter<void>();
  @ViewChild('buildLogOutput') private buildLogOutput?: ElementRef<HTMLPreElement>;

  readonly colorChannels: Array<'r' | 'g' | 'b'> = ['r', 'g', 'b'];
  readonly additionalMaps: AdditionalMapEntry[] = [{ name: '', folder: '' }];
  readonly folderPathFields = new Set([
    'pz_root',
    'output_root',
    'mod_root',
    'custom_root',
    'save_game_root',
    'map_conf_root',
  ]);
  readonly isTauriRuntime: boolean;
  buildStatus: BuildStatus | null = null;
  buildEstimate: DiskEstimate | null = null;
  buildError = '';
  presetMode: MapPreset = 'medium';
  activeStep = 1;
  outputReplacementDialogVisible = false;
  outputReplacementPath = '';
  resumeCandidate: MapBuildResumeCandidate | null = null;
  flashingLogIndex: number | null = null;
  private outputReplacementResolver: ((decision: 'resume' | 'replace' | 'cancel') => void) | null = null;
  private readonly buildStatusSubscription: Subscription;
  private estimateTimer: number | null = null;
  private logFlashTimer: number | null = null;
  private logScrollTimer: number | null = null;
  private lastLogSignature = '';
  private estimateRequest = 0;

  /** The complete local Ultra output used as the size calibration point. */
  readonly ultraReferenceOutputBytes = 430_463_565_575;
  readonly ultraReferenceDurationMinutes = 1245;
  readonly availableCpuCores = typeof navigator !== 'undefined'
    ? Math.max(1, navigator.hardwareConcurrency || 1)
    : 1;
  readonly cpuWorkerOptions: ConfigOption[] = [
    { label: `All available CPU cores (${this.availableCpuCores})`, value: 'all' },
    { label: 'Automatic', value: 'auto' },
    ...Array.from(new Set([
      1, 2, 4, 8, 12, 16, 24, 32, 48, 64,
      this.availableCpuCores,
    ])).filter((value) => value <= this.availableCpuCores).sort((a, b) => a - b).map((value) => ({
      label: `${value} CPU core${value === 1 ? '' : 's'}`,
      value: String(value),
    })),
  ];

  readonly presetOptions: MapPresetOption[] = [
    {
      label: 'Low',
      value: 'low',
      description: 'Ground-only map with the smallest image files.',
      detail: 'Renders layer 0 only and uses JPG quality 25 for a fast, compact overview.',
      sizeFactor: 0.12,
      durationFactor: 0.55,
      settings: {
        'render_conf.tile_size': 1024,
        'render_conf.tile_align_levels': 2,
        'render_conf.layer_range': 'ground',
        'render_conf.omit_levels': 0,
        'render_conf.image_fmt': 'jpg',
        'render_conf.image_fmt_base_layer0': 'jpg',
        'render_conf.image_save_options': '{"jpg":{"quality":25}}',
        'render_conf.enable_cache': true,
        'render_conf.cache_limit_mb': 2048,
        'render_conf.tile_size(foraging)': 8192,
        'render_conf.tile_size(zombie)': 8192,
        'render_conf.top_view_square_size': 2,
        'render_conf.top_view_color_mode': 'base',
        'render_conf.worker_count': 'all',
        'render_conf.pyramid_backend': 'cpu',
      },
    },
    {
      label: 'Medium',
      value: 'medium',
      description: 'Good default for sharing and everyday use.',
      detail: 'Renders layer 0 and positive-numbered floors with JPG quality 50.',
      sizeFactor: 0.3,
      durationFactor: 0.7,
      settings: {
        'render_conf.tile_size': 1024,
        'render_conf.tile_align_levels': 3,
        'render_conf.layer_range': 'ground_and_positive',
        'render_conf.omit_levels': 0,
        'render_conf.image_fmt': 'jpg',
        'render_conf.image_fmt_base_layer0': 'jpg',
        'render_conf.image_save_options': '{"jpg":{"quality":50}}',
        'render_conf.top_view_square_size': 1,
        'render_conf.top_view_color_mode': 'avg',
        'render_conf.worker_count': 'all',
        'render_conf.pyramid_backend': 'cpu',
      },
    },
    {
      label: 'High',
      value: 'high',
      description: 'More zoom detail with a larger output.',
      detail: 'Renders every available floor and uses JPG quality 75 for higher visual fidelity.',
      sizeFactor: 0.55,
      durationFactor: 0.85,
      settings: {
        'render_conf.tile_size': 1024,
        'render_conf.tile_align_levels': 3,
        'render_conf.layer_range': 'all',
        'render_conf.omit_levels': 0,
        'render_conf.image_fmt': 'jpg',
        'render_conf.image_fmt_base_layer0': 'jpg',
        'render_conf.image_save_options': '{"jpg":{"quality":75}}',
        'render_conf.top_view_square_size': 1,
        'render_conf.top_view_color_mode': 'avg',
        'render_conf.worker_count': 'all',
        'render_conf.pyramid_backend': 'cpu',
      },
    },
    {
      label: 'Ultra',
      value: 'ultra',
      description: 'Full zoom detail and the largest files.',
      detail: 'Matches the complete WebP reference output: all pyramid levels, all floors, and full map coverage.',
      sizeFactor: 1,
      durationFactor: 1,
      settings: {
        'render_conf.tile_size': 1024,
        'render_conf.tile_align_levels': 3,
        'render_conf.omit_levels': 0,
        'render_conf.image_fmt': 'webp',
        'render_conf.image_fmt_base_layer0': 'webp',
        'render_conf.image_save_options': '{}',
        'render_conf.top_view_square_size': 1,
        'render_conf.top_view_color_mode': 'avg',
        'render_conf.worker_count': 'all',
        'render_conf.pyramid_backend': 'cpu',
      },
    },
    {
      label: 'Custom',
      value: 'custom',
      description: 'Edit every renderer setting yourself.',
      detail: 'Use the stepper to tune coverage, quality, visual styling, cache, and diagnostics.',
      sizeFactor: 1,
      durationFactor: 1,
      settings: {},
    },
  ];

  readonly requiredRootFieldPaths = new Set([
    'pz_root',
    'output_root',
    'mod_root',
    'custom_root',
    'save_game_root',
    'output_entry',
    'output_route',
    'map_conf_default',
    'map_conf',
    'base_map',
  ]);
  readonly coverageRootFieldPaths = new Set(['use_depend_texture_only', 'save_games']);

  get requiredRootFields(): ConfigField[] {
    return this.rootFields.filter((field) => this.requiredRootFieldPaths.has(field.path));
  }

  get coverageRootFields(): ConfigField[] {
    return this.rootFields.filter((field) => this.coverageRootFieldPaths.has(field.path));
  }

  get customBasicsRootFields(): ConfigField[] {
    return this.rootFields.filter((field) => !this.coverageRootFieldPaths.has(field.path));
  }

  get performanceFields(): ConfigField[] {
    return this.renderFields.filter((field) => [
      'render_conf.worker_count',
      'render_conf.pyramid_backend',
    ].includes(field.path));
  }

  get selectedPreset(): MapPresetOption {
    return this.presetOptions.find((option) => option.value === this.presetMode)
      ?? this.presetOptions[1];
  }

  get estimatedOutputBytes(): number {
    if (this.buildEstimate && !this.showBuildStatus) {
      return this.buildEstimate.output_bytes;
    }
    return Math.max(1, Math.round(this.ultraReferenceOutputBytes * this.estimateSizeFactor()));
  }

  get estimatedDurationMinutes(): number {
    if (this.buildEstimate && !this.showBuildStatus && this.buildEstimate.estimated_seconds > 0) {
      return this.buildEstimate.estimated_seconds / 60;
    }
    const presetFactor = this.presetMode === 'custom'
      ? this.estimateDurationFactor()
      : this.selectedPreset.durationFactor;
    return Math.max(1, Math.round(this.ultraReferenceDurationMinutes * presetFactor));
  }

  get estimatedPeakMemoryBytes(): number {
    if (this.buildEstimate && !this.showBuildStatus && this.buildEstimate.peak_memory_bytes > 0) {
      return this.buildEstimate.peak_memory_bytes;
    }
    const render = this.formValue['render_conf'] as Record<string, unknown>;
    const workerCount = String(render['worker_count'] ?? 'auto').toLowerCase() === 'auto'
      ? this.availableCpuCores
      : String(render['worker_count'] ?? '').toLowerCase() === 'all'
        ? this.availableCpuCores
        : Math.max(1, this.numberValue(render['worker_count'], this.availableCpuCores));
    return (4 * 1024 + workerCount * 500) * 1024 * 1024;
  }

  get presetSummaryItems(): PresetSummaryItem[] {
    const render = this.formValue['render_conf'] as Record<string, unknown>;
    return [
      {
        label: 'Map coverage',
        value: this.displayValue(this.getFieldValue('render_conf.dzi_cell_range')),
        description: 'Defines the cells used for the map boundary.',
      },
      {
        label: 'Floors',
        value: this.layerRangeLabel(this.getFieldValue('render_conf.layer_range')),
        description: 'Ground is layer 0; ground_and_positive includes layer 0 and all positive-numbered floors.',
      },
      {
        label: 'Zoom detail',
        value: `${this.displayValue(render['omit_levels'])} highest-resolution levels omitted`,
        description: 'Omitting levels saves storage but removes the closest zoom levels.',
      },
      {
        label: 'Image format',
        value: `${this.imageFormatLabel(render)} tiles`,
        description: 'JPG quality controls the balance between visual fidelity and output size.',
      },
      {
        label: 'Tile size',
        value: `${this.displayValue(render['tile_size'])} px`,
        description: 'Larger tiles reduce file-count overhead but use more memory per tile.',
      },
      {
        label: 'CPU workers',
        value: this.cpuWorkerLabel(render['worker_count']),
        description: 'Controls parallel CPU work. All uses every logical CPU core reported by the system.',
      },
      {
        label: 'Pyramid processing',
        value: this.pyramidBackendLabel(render['pyramid_backend']),
        description: 'GPU mode accelerates the resize stage with WGPU and keeps CPU/file work on the native renderer.',
      },
    ];
  }

  constructor(
    private readonly store: TauriStoreService,
    private readonly buildJob: Pzmap2DziJobService,
  ) {
    this.isTauriRuntime = this.store.isTauriRuntime();
    this.buildStatusSubscription = this.buildJob.status$.subscribe((status) => {
      this.buildStatus = status;
      this.updateBuildLogPresentation(status);
    });
    this.onPresetChanged(this.presetMode);
    this.scheduleEstimateRefresh();
  }

  get showBuildStatus(): boolean {
    return !!this.buildStatus && this.buildStatus.state !== 'idle';
  }

  get buildStatusAgeSeconds(): number {
    const lastActivity = this.buildStatus?.last_activity_unix_ms;
    return lastActivity
      ? Math.max(0, Math.floor((Date.now() - lastActivity) / 1000))
      : 0;
  }

  get buildStatusStale(): boolean {
    return !!this.buildStatus
      && ['starting', 'running', 'stopping'].includes(this.buildStatus.state)
      && this.buildStatusAgeSeconds >= 30;
  }

  ngOnDestroy(): void {
    this.buildStatusSubscription.unsubscribe();
    if (this.estimateTimer !== null) {
      window.clearTimeout(this.estimateTimer);
      this.estimateTimer = null;
    }
    if (this.logFlashTimer !== null) {
      window.clearTimeout(this.logFlashTimer);
      this.logFlashTimer = null;
    }
    if (this.logScrollTimer !== null) {
      window.clearTimeout(this.logScrollTimer);
      this.logScrollTimer = null;
    }
  }

  private updateBuildLogPresentation(status: BuildStatus | null): void {
    const logs = status?.logs ?? [];
    const newestLog = logs.length > 0 ? logs[logs.length - 1] : '';
    const signature = logs.length > 0 ? `${logs.length}:${newestLog}` : '';

    if (signature && signature !== this.lastLogSignature) {
      this.flashingLogIndex = logs.length - 1;
      if (this.logFlashTimer !== null) {
        window.clearTimeout(this.logFlashTimer);
      }
      this.logFlashTimer = window.setTimeout(() => {
        this.flashingLogIndex = null;
        this.logFlashTimer = null;
      }, 1_250);
      this.followBuildLog();
    }
    this.lastLogSignature = signature;
  }

  private followBuildLog(): void {
    if (this.logScrollTimer !== null) {
      window.clearTimeout(this.logScrollTimer);
    }
    this.logScrollTimer = window.setTimeout(() => {
      const output = this.buildLogOutput?.nativeElement;
      if (output) {
        output.scrollTop = output.scrollHeight;
      }
      this.logScrollTimer = null;
    }, 0);
  }

  readonly rootFields: ConfigField[] = [
    {
      path: 'pz_root',
      label: 'Project Zomboid root',
      description: 'Required: the installed game folder. The renderer reads map cells, textures, fonts, and definitions from here.',
      type: 'text',
    },
    {
      path: 'output_root',
      label: 'Output root',
      description: 'Required: where the generated html and map_data folders are written. Upstream pzmap2dzi calls this output_path. Use a drive with enough free space.',
      type: 'text',
    },
    {
      path: 'mod_root',
      label: 'Workshop root',
      description: 'Where workshop map and texture packs are found. This matters when your map configuration references mods.',
      type: 'text',
    },
    {
      path: 'custom_root',
      label: 'Custom root',
      description: 'Folder used to resolve map description files such as vanilla.txt and the mod folder. The default is the app working folder.',
      type: 'text',
    },
    {
      path: 'map_conf_root',
      label: 'Map configuration root',
      description: 'Optional preferred folder containing vanilla.txt and default_b42.txt/default_b41.txt. Leave empty to use Custom root.',
      type: 'text',
    },
    {
      path: 'save_game_root',
      label: 'Save-game root',
      description: 'Folder containing save games. Save overlays are generated from the folders selected below.',
      type: 'text',
    },
    {
      path: 'output_entry',
      label: 'Output entry',
      description: 'Name used by the generated viewer configuration. Keep “default” unless you need multiple map sets.',
      type: 'text',
    },
    {
      path: 'output_route',
      label: 'Output route',
      description: 'Relative route from the generated viewer to map_data. The default works with the bundled viewer.',
      type: 'text',
    },
    {
      path: 'map_conf_default',
      label: 'Default map description',
      description: 'Default description file that supplies map paths, texture paths, dependencies, and encoding.',
      type: 'text',
    },
    {
      path: 'map_conf',
      label: 'Map descriptions',
      description: 'Files or folders to scan for map descriptions. This is how the renderer learns where the base map lives.',
      type: 'textarea',
      rows: 3,
    },
    {
      path: 'use_depend_texture_only',
      label: 'Use dependency textures only',
      description: 'Only use textures declared as dependencies in each map description.',
      type: 'toggle',
    },
    {
      path: 'base_map',
      label: 'Base map',
      description: 'Required: the map definition to render. “default” is the vanilla Project Zomboid map in the standard configuration.',
      type: 'text',
    },
    {
      path: 'save_games',
      label: 'Save games',
      description: 'Optional save folders relative to Save-game root, or “all”. Save overlays increase build time and output size.',
      type: 'textarea',
      rows: 3,
    },
  ];

  readonly renderFields: ConfigField[] = [
    {
      path: 'render_conf.verbose',
      label: 'Verbose logging',
      description: 'Enable verbose renderer logging.',
      type: 'toggle',
    },
    {
      path: 'render_conf.profile',
      label: 'Profiling',
      description: 'Show profiling information.',
      type: 'toggle',
    },
    {
      path: 'render_conf.worker_count',
      label: 'CPU worker cores',
      description: 'Number of logical CPU cores used for native rendering and pyramid work. “All available” uses every logical core; lower values leave more CPU capacity for other applications.',
      type: 'select',
      options: this.cpuWorkerOptions,
    },
    {
      path: 'render_conf.pyramid_backend',
      label: 'Pyramid processing device',
      description: 'Select CPU for the parallel, Python-compatible pyramid path, GPU to require the experimental WGPU path, or Automatic to use the parallel CPU path. GPU mode has synchronous per-tile readback and may be slower on large maps; image codecs and disk writes remain CPU work.',
      type: 'select',
      options: [
        { label: 'CPU (all selected cores)', value: 'cpu' },
        { label: 'Automatic: parallel CPU (GPU opt-in)', value: 'auto' },
        { label: 'GPU required', value: 'gpu' },
      ],
    },
    {
      path: 'render_conf.break_key',
      label: 'Stop hotkey',
      description: 'Hotkey to stop a render; examples include <ctrl>+<alt>+a or <f8>.',
      type: 'text',
    },
    {
      path: 'render_conf.tile_size',
      label: 'Tile size',
      description: 'Pixels per output tile. Larger tiles reduce file-count overhead but use more memory while rendering.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.tile_align_levels',
      label: 'Tile alignment levels',
      description: 'Keeps the selected number of low-resolution levels aligned to cell boundaries. Higher values improve predictable navigation but add work.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.tile_size(foraging)',
      label: 'Foraging tile size',
      description: 'Upstream per-job override. The documented default is 4096 pixels for foraging overlays; larger tiles reduce file count.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.tile_size(zombie)',
      label: 'Zombie tile size',
      description: 'Upstream per-job override. The documented default is 4096 pixels for zombie overlays; larger tiles reduce file count.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.tile_align_levels(foraging)',
      label: 'Foraging alignment levels',
      description: 'Documented overlay default: 1. Overlay tasks do not need the base map’s deeper cell alignment.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.tile_align_levels(zombie)',
      label: 'Zombie alignment levels',
      description: 'Documented overlay default: 1. Increase only when you need a shared cell-aligned pyramid.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.layer_range',
      label: 'Layer range',
      description: 'Floors to render. Use “all”, “ground” for layer 0 only, “ground_and_positive” for layer 0 plus positive floors, or [minimum, maximum].',
      type: 'text',
    },
    {
      path: 'render_conf.hash_method',
      label: 'Hash method',
      description: 'Hash function for detecting source changes; empty uses last modified time.',
      type: 'select',
      options: [
        { label: 'None (last modified time)', value: '' },
        { label: 'MD5', value: 'md5' },
        { label: 'SHA-1', value: 'sha1' },
        { label: 'SHA-256', value: 'sha256' },
      ],
    },
    {
      path: 'render_conf.dzi_cell_range',
      label: 'DZI cell range',
      description: 'Map area used for the image boundary. “auto” detects the base map; “all_mod_maps” combines the base map and configured Additional maps (upstream mod_maps).',
      type: 'textarea',
      rows: 3,
    },
    {
      path: 'render_conf.dzi_cell_range[default]',
      label: 'Default-map DZI override',
      description: 'Documented per-map override. “all_mod_maps” lets the default map boundary include configured overlay maps for saves and combined map sets.',
      type: 'text',
    },
    {
      path: 'render_conf.render_cell_range',
      label: 'Render cell range',
      description: 'Cells that receive rendered tiles. “all” renders the selected map area; limiting this is the biggest way to reduce work.',
      type: 'textarea',
      rows: 3,
    },
    {
      path: 'render_conf.omit_levels',
      label: 'Omit levels',
      description: 'Removes the highest-resolution zoom levels after rendering. Each omitted level saves space but reduces closest-zoom detail.',
      type: 'number',
      min: 0,
    },
    {
      path: 'render_conf.image_fmt',
      label: 'Image format',
      description: 'Format for base and overlay tiles. JPG is smaller but lossy, WebP is compact, and PNG is lossless but larger.',
      type: 'select',
      options: [
        { label: 'JPG', value: 'jpg' },
        { label: 'WebP', value: 'webp' },
        { label: 'PNG', value: 'png' },
      ],
    },
    {
      path: 'render_conf.image_fmt_base_layer0',
      label: 'Base layer 0 format',
      description: 'Format for the ground layer. Use the same format as Image format when you want consistent output across all layers.',
      type: 'select',
      options: [
        { label: 'WebP', value: 'webp' },
        { label: 'PNG', value: 'png' },
        { label: 'JPG', value: 'jpg' },
      ],
    },
    {
      path: 'render_conf.image_save_options',
      label: 'Image save options',
      description: 'Advanced encoder options. Leave {} unless you know the options supported by the selected image format.',
      type: 'textarea',
      rows: 3,
    },
    {
      path: 'render_conf.enable_cache',
      label: 'Enable cache',
      description: 'Enable the render cache to accelerate pyramid building.',
      type: 'toggle',
    },
    {
      path: 'render_conf.cache_limit_mb',
      label: 'Cache limit (MB)',
      description: 'RAM budget for decoded texture pages. Raster overlays use all available logical CPU cores, so larger tiles require more RAM per worker. 0 uses a safe native default instead of unlimited memory.',
      type: 'number',
      min: 0,
    },
    {
      path: 'render_conf.top_view_square_size',
      label: 'Top-view square size',
      description: 'Width for a single tile in top-view mode.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.top_view_color_mode',
      label: 'Top-view color mode',
      description: 'Top-view square color method.',
      type: 'select',
      options: [
        { label: 'Base', value: 'base' },
        { label: 'Base + water', value: 'base+water' },
        { label: 'Average', value: 'avg' },
        { label: 'Carto-Zed', value: 'carto-zed' },
      ],
    },
    {
      path: 'render_conf.default_font',
      label: 'Default font',
      description: 'Font used for map labels.',
      type: 'text',
    },
    {
      path: 'render_conf.default_font_size',
      label: 'Default font size',
      description: 'Font size used for map labels.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.room_font',
      label: 'Room font',
      description: 'Optional room font; the default font is used when empty.',
      type: 'text',
    },
    {
      path: 'render_conf.room_font_size',
      label: 'Room font size',
      description: 'Optional room font size.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.zombie_count',
      label: 'Zombie count',
      description: 'Render zombie counts.',
      type: 'toggle',
    },
    {
      path: 'render_conf.zombie_count_font',
      label: 'Zombie-count font',
      description: 'Font used for zombie counts.',
      type: 'text',
    },
    {
      path: 'render_conf.zombie_count_font_size',
      label: 'Zombie-count font size',
      description: 'Font size used for zombie counts.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.objects_font',
      label: 'Objects font',
      description: 'Optional font used for objects; the default font is used when empty.',
      type: 'text',
    },
    {
      path: 'render_conf.objects_font_size',
      label: 'Objects font size',
      description: 'Optional object font size.',
      type: 'number',
      min: 1,
    },
    {
      path: 'render_conf.use_mark',
      label: 'Use marks',
      description: 'Use marks for rooms, objects, and zombie counts.',
      type: 'toggle',
    },
    {
      path: 'render_conf.save_game_parser_tag',
      label: 'Save parser tag',
      description: 'Use the latest parser or a local parser copy.',
      type: 'select',
      options: [
        { label: 'Latest', value: 'latest' },
        { label: 'Local', value: 'local' },
      ],
    },
    {
      path: 'render_conf.save_game_parser_path',
      label: 'Save parser path',
      description: 'Local parser path or the cache path used for the latest parser.',
      type: 'text',
    },
    {
      path: 'render_conf.save_game_dump_failed_chunks',
      label: 'Dump failed chunks',
      description: 'Dump save-game chunks that fail to parse.',
      type: 'toggle',
    },
  ];

  readonly plantFields: ConfigField[] = [
    {
      path: 'render_conf.plants_conf.snow',
      label: 'Snow',
      description: 'Enable snow on trees and bushes.',
      type: 'toggle',
    },
    {
      path: 'render_conf.plants_conf.large_bush',
      label: 'Large bushes',
      description: 'Use large bushes.',
      type: 'toggle',
    },
    {
      path: 'render_conf.plants_conf.flower',
      label: 'Flowers',
      description: 'Enable flowers on trees and bushes.',
      type: 'toggle',
    },
    {
      path: 'render_conf.plants_conf.season',
      label: 'Season',
      description: 'Season used for plants.',
      type: 'select',
      options: ['spring', 'summer', 'summer2', 'autumn', 'winter'].map((value) => ({
        label: value,
        value,
      })),
    },
    {
      path: 'render_conf.plants_conf.tree_size',
      label: 'Tree size',
      description: 'Normal tree size, from 0 to 3.',
      type: 'number',
      min: 0,
      max: 3,
    },
    {
      path: 'render_conf.plants_conf.jumbo_tree_size',
      label: 'Jumbo tree size',
      description: 'Large tree size, from 0 to 5.',
      type: 'number',
      min: 0,
      max: 5,
    },
    {
      path: 'render_conf.plants_conf.jumbo_tree_type',
      label: 'Jumbo tree type',
      description: 'Large tree type, from 1 to 11.',
      type: 'number',
      min: 1,
      max: 11,
    },
    {
      path: 'render_conf.plants_conf.no_ground_cover',
      label: 'No ground cover',
      description: 'Disable ground-cover grass.',
      type: 'toggle',
    },
    {
      path: 'render_conf.plants_conf.unify_tree_type',
      label: 'Unified tree type',
      description: '0 keeps trees varied; 1 to 11 uses one unified tree type.',
      type: 'number',
      min: 0,
      max: 11,
    },
  ];

  readonly generalColorFields: ColorField[] = [
    {
      path: 'render_conf.foraging_color_default',
      label: 'Default foraging color',
      description: 'Fallback color for foraging zones.',
    },
    {
      path: 'render_conf.objects_color_default',
      label: 'Default objects color',
      description: 'Fallback color for objects.',
    },
    {
      path: 'render_conf.streets_large',
      label: 'Large street color',
      description: 'Color for large streets.',
    },
    {
      path: 'render_conf.streets_medium',
      label: 'Medium street color',
      description: 'Color for medium streets.',
    },
    {
      path: 'render_conf.streets_small',
      label: 'Small street color',
      description: 'Color for small streets.',
    },
  ];

  readonly foragingColorFields: ColorField[] = [
    'Nav',
    'TownZone',
    'TrailerPark',
    'Vegitation',
    'Forest',
    'DeepForest',
    'FarmLand',
    'Farm',
    'ForagingNav',
    'Water',
    'WaterNoFish',
    'PHForest',
    'PHMixForest',
    'PRForest',
    'FarmMixForest',
    'FarmForest',
    'BirchForest',
    'BirchMixForest',
    'OrganicForest',
  ].map((name) => ({
    path: `render_conf.foraging_color.${name}`,
    label: name,
    description: 'Color used for this foraging zone type; enter “skip” to omit it.',
  }));

  readonly objectColorFields: ColorField[] = ['ZombiesType', 'ParkingStall', 'ZoneStory'].map((name) => ({
    path: `render_conf.objects_color.${name}`,
    label: name,
    description: 'Color used for this object type.',
  }));

  readonly formValue: Record<string, unknown> = {
    pz_root: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\ProjectZomboid',
    output_root: 'C:\\pzmap',
    mod_root: 'C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\108600',
    custom_root: '.',
    map_conf_root: '',
    save_game_root: '%UserProfile%\\Zomboid\\Saves',
    output_entry: 'default',
    output_route: 'map_data/',
    map_conf_default: 'default_b42.txt',
    map_conf: 'vanilla.txt\nmod',
    use_depend_texture_only: false,
    base_map: 'default',
    additional_maps: this.additionalMaps,
    save_games: 'all',
    render_conf: {
      verbose: true,
      profile: false,
      worker_count: 'all',
      pyramid_backend: 'cpu',
      break_key: '',
      tile_size: 1024,
      tile_align_levels: 3,
      layer_range: 'all',
      hash_method: '',
      dzi_cell_range: 'all_mod_maps',
      'dzi_cell_range[default]': 'all_mod_maps',
      render_cell_range: 'all',
      omit_levels: 0,
      image_fmt: 'webp',
      image_fmt_base_layer0: 'webp',
      image_save_options: '{}',
      enable_cache: false,
      cache_limit_mb: 0,
      'tile_size(foraging)': 4096,
      'tile_size(zombie)': 4096,
      'tile_align_levels(foraging)': 1,
      'tile_align_levels(zombie)': 1,
      top_view_square_size: 1,
      top_view_color_mode: 'avg',
      default_font: 'arial.ttf',
      default_font_size: 20,
      room_font: '',
      room_font_size: 20,
      zombie_count: true,
      zombie_count_font: 'arial.ttf',
      zombie_count_font_size: 40,
      objects_font: '',
      objects_font_size: 20,
      foraging_color_default: 'Gray',
      foraging_color: {
        Nav: 'White',
        TownZone: 'Blue',
        TrailerPark: 'Cyan',
        Vegitation: 'Yellow',
        Forest: 'Lime',
        DeepForest: 'Green',
        FarmLand: 'Magenta',
        Farm: 'Red',
        ForagingNav: 'White',
        Water: 'DeepSkyBlue',
        WaterNoFish: 'SlateGrey',
        PHForest: 'OrangeRed',
        PHMixForest: 'Orange',
        PRForest: 'ForestGreen',
        FarmMixForest: 'Olive',
        FarmForest: 'Orange',
        BirchForest: 'OliveDrab',
        BirchMixForest: 'DarkOliveGreen',
        OrganicForest: 'LawnGreen',
      },
      objects_color_default: 'White',
      objects_color: {
        ZombiesType: 'Red',
        ParkingStall: 'Blue',
        ZoneStory: 'Yellow',
      },
      use_mark: true,
      streets_large: 'White',
      streets_medium: 'Cyan',
      streets_small: 'Teal',
      save_game_parser_tag: 'latest',
      save_game_parser_path: '',
      save_game_dump_failed_chunks: true,
      plants_conf: {
        snow: false,
        large_bush: false,
        flower: false,
        season: 'summer2',
        tree_size: 2,
        jumbo_tree_size: 4,
        jumbo_tree_type: 1,
        no_ground_cover: false,
        unify_tree_type: 0,
      },
    },
  };

  getFieldValue(path: string): unknown {
    return path.split('.').reduce<unknown>((value, key) => {
      if (!value || typeof value !== 'object') {
        return undefined;
      }
      return (value as Record<string, unknown>)[key];
    }, this.formValue);
  }

  setFieldValue(path: string, value: unknown): void {
    const normalizedValue = this.folderPathFields.has(path) && typeof value === 'string'
      ? this.normalizeWindowsPath(value)
      : value;
    this.writeFieldValue(path, normalizedValue);
    this.buildEstimate = null;
    this.buildError = '';
    if (!this.requiredRootFieldPaths.has(path)) {
      this.markAsCustom(path);
    }
    this.scheduleEstimateRefresh();
  }

  private writeFieldValue(path: string, value: unknown): void {
    const parts = path.split('.');
    const finalKey = parts.pop();
    if (!finalKey) {
      return;
    }
    let target = this.formValue;
    for (const part of parts) {
      const next = target[part];
      if (!next || typeof next !== 'object') {
        target[part] = {};
      }
      target = target[part] as Record<string, unknown>;
    }
    target[finalKey] = value;
  }

  onPresetChanged(value: MapPreset | null): void {
    if (!value) {
      return;
    }
    if (value === 'custom') {
      this.presetMode = 'custom';
      this.activeStep = 1;
      this.buildError = '';
      this.scheduleEstimateRefresh();
      return;
    }

    const preset = this.presetOptions.find((option) => option.value === value);
    if (!preset) {
      return;
    }
    this.presetMode = value;
    for (const [path, setting] of Object.entries(preset.settings)) {
      this.writeFieldValue(path, setting);
    }
    this.buildEstimate = null;
    this.buildError = '';
    this.scheduleEstimateRefresh();
  }

  editPresetSettings(): void {
    this.presetMode = 'custom';
    this.activeStep = 3;
    this.scrollToStepperAnchor();
  }

  goToStep(activateCallback: (step: number) => void, step: number): void {
    activateCallback(step);
    this.scrollToStepperAnchor();
  }

  private scrollToStepperAnchor(): void {
    if (typeof document === 'undefined') {
      return;
    }
    const scroll = () => {
      document
        .getElementById('map-builder-stepper-anchor')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(scroll);
    } else {
      scroll();
    }
  }

  updateAdditionalMap(index: number, field: keyof AdditionalMapEntry, value: string): void {
    const map = this.additionalMaps[index];
    if (!map) {
      return;
    }
    map[field] = field === 'folder' ? this.normalizeWindowsPath(value) : value;
    this.markAsCustom('additional_maps');
    this.buildError = '';
    this.scheduleEstimateRefresh();
  }

  private markAsCustom(path?: string): void {
    this.buildEstimate = null;
    if (this.presetMode === 'custom') {
      return;
    }
    this.presetMode = 'custom';
    this.activeStep = this.stepForField(path);
  }

  private scheduleEstimateRefresh(): void {
    if (!this.isTauriRuntime) {
      return;
    }
    if (this.estimateTimer !== null) {
      window.clearTimeout(this.estimateTimer);
    }
    this.estimateTimer = window.setTimeout(() => {
      this.estimateTimer = null;
      void this.refreshEstimate();
    }, 250);
  }

  private async refreshEstimate(): Promise<void> {
    const request = ++this.estimateRequest;
    let config: Record<string, unknown>;
    try {
      config = this.buildConfig(false);
    } catch {
      return;
    }
    try {
      const estimate = await invoke<DiskEstimate>('estimate_pzmap2dzi_build', { config });
      if (request === this.estimateRequest && !this.showBuildStatus) {
        this.buildEstimate = estimate;
      }
    } catch {
      // The form still has a local fallback estimate when the native side is unavailable.
    }
  }

  private stepForField(path?: string): number {
    if (!path) {
      return 1;
    }
    if (path === 'additional_maps' || this.coverageRootFieldPaths.has(path)) {
      return 2;
    }
    if (path.startsWith('render_conf.')) {
      return 3;
    }
    return 1;
  }

  private estimateSizeFactor(): number {
    if (this.presetMode !== 'custom') {
      return this.selectedPreset.sizeFactor;
    }

    const render = this.formValue['render_conf'] as Record<string, unknown>;
    const omitLevels = this.numberValue(render['omit_levels'], 0);
    const tileSize = Math.max(128, this.numberValue(render['tile_size'], 1024));
    const topSquareSize = Math.max(1, this.numberValue(render['top_view_square_size'], 1));
    const format = String(render['image_fmt'] ?? 'webp').toLowerCase();
    const maps = Math.max(0, this.additionalMapNames(this.formValue['additional_maps']).length);
    const saves = Math.max(1, this.additionalMapNames(this.formValue['save_games']).length);
    const layerFactor = this.layerRangeFactor(String(render['layer_range'] ?? 'all'));
    const pyramidFactor = Math.pow(0.55, Math.min(8, omitLevels));
    const tileFactor = Math.sqrt(1024 / tileSize);
    const topFactor = Math.min(1, 1 / Math.sqrt(topSquareSize));
    const jpegQuality = this.jpegQuality(render);
    const formatFactor = format === 'png'
      ? 1.9
      : format === 'jpg' || format === 'jpeg'
        ? 0.25 + (jpegQuality / 100) * 0.75
        : 1;
    const targetFactor = 1 + maps * 0.18 + Math.max(0, saves - 1) * 0.08;
    return Math.max(0.02, pyramidFactor * tileFactor * topFactor * formatFactor * targetFactor * layerFactor);
  }

  private estimateDurationFactor(): number {
    const sizeFactor = this.estimateSizeFactor();
    const render = this.formValue['render_conf'] as Record<string, unknown>;
    const workerCount = String(render['worker_count'] ?? 'auto').toLowerCase();
    const resolvedWorkers = workerCount === 'all'
      ? this.availableCpuCores
      : workerCount === 'auto'
        ? 16
        : Math.max(1, this.numberValue(render['worker_count'], 16));
    const workerFactor = Math.max(0.5, Math.pow(16 / Math.max(1, resolvedWorkers), 0.72));
    return Math.max(0.15, (0.45 + sizeFactor * 0.55) * workerFactor);
  }

  private layerRangeFactor(value: string): number {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === 'all') {
      return 1;
    }
    if (normalized === 'ground' || normalized === 'layer0' || normalized === 'ground_only') {
      return Math.max(0.1, 1 / 64);
    }
    if (normalized === 'ground_and_positive' || normalized === 'nonnegative' || normalized === 'positive') {
      return 0.5;
    }
    const match = normalized.match(/-?\d+\s*,\s*-?\d+/);
    if (!match) {
      return 1;
    }
    const [start, end] = match[0].split(',').map((part) => Number(part.trim()));
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return 1;
    }
    return Math.max(0.1, Math.min(1, Math.abs(end - start) / 64));
  }

  layerRangeLabel(value: unknown): string {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'ground' || normalized === 'layer0' || normalized === 'ground_only') {
      return 'Ground only (layer 0)';
    }
    if (normalized === 'ground_and_positive' || normalized === 'nonnegative' || normalized === 'positive') {
      return 'Ground + positive floors';
    }
    return this.displayValue(value);
  }

  imageFormatLabelForReview(): string {
    return this.imageFormatLabel(this.formValue['render_conf'] as Record<string, unknown>);
  }

  private imageFormatLabel(render: Record<string, unknown>): string {
    const format = String(render['image_fmt'] ?? 'webp').trim().toLowerCase();
    if (format === 'jpg' || format === 'jpeg') {
      return `JPG (${this.jpegQuality(render)}%)`;
    }
    if (format === 'png') {
      return 'PNG';
    }
    return 'WebP';
  }

  cpuWorkerLabel(value: unknown): string {
    const normalized = String(value ?? 'all').trim().toLowerCase();
    if (normalized === 'all') {
      return `All available (${this.availableCpuCores})`;
    }
    if (normalized === 'auto') {
      return 'Automatic';
    }
    return `${this.numberValue(value, this.availableCpuCores)} core${this.numberValue(value, 1) === 1 ? '' : 's'}`;
  }

  pyramidBackendLabel(value: unknown): string {
    switch (String(value ?? 'cpu').trim().toLowerCase()) {
      case 'gpu':
        return 'GPU required';
      case 'auto':
        return 'CPU parallel (GPU opt-in)';
      default:
        return 'CPU';
    }
  }

  private jpegQuality(render: Record<string, unknown>): number {
    const rawOptions = render['image_save_options'];
    let options: unknown = rawOptions;
    if (typeof rawOptions === 'string') {
      try {
        options = JSON.parse(rawOptions);
      } catch {
        return 75;
      }
    }
    if (!this.isRecord(options)) {
      return 75;
    }
    const jpegOptions = this.isRecord(options['jpg'])
      ? options['jpg']
      : this.isRecord(options['jpeg'])
        ? options['jpeg']
        : null;
    if (!jpegOptions) {
      return 75;
    }
    return Math.max(1, Math.min(100, Math.round(this.numberValue(jpegOptions['quality'], 75))));
  }

  private numberValue(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  displayValue(value: unknown): string {
    if (value === null || value === undefined || value === '') {
      return 'Not set';
    }
    return Array.isArray(value) ? value.join(', ') : String(value);
  }

  private normalizeWindowsPath(value: string): string {
    return value.replace(/\//g, '\\');
  }

  colorPickerValue(field: ColorField): string {
    const value = String(this.getFieldValue(field.path) ?? '');
    const parsed = this.parseColor(value);
    return this.rgbToHex(parsed.r, parsed.g, parsed.b);
  }

  colorRgb(field: ColorField): { r: number; g: number; b: number } {
    return this.parseColor(String(this.getFieldValue(field.path) ?? ''));
  }

  setColorText(field: ColorField, value: unknown): void {
    this.setFieldValue(field.path, value);
  }

  setColorFromPicker(field: ColorField, event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (input?.value) {
      this.setFieldValue(field.path, input.value);
    }
  }

  setColorChannel(field: ColorField, channel: 'r' | 'g' | 'b', value: number | null): void {
    const rgb = this.colorRgb(field);
    rgb[channel] = Math.max(0, Math.min(255, Math.round(value ?? 0)));
    this.setFieldValue(field.path, this.rgbToHex(rgb.r, rgb.g, rgb.b));
  }

  colorInputId(field: ColorField): string {
    return `pzmap2dzi-color-${field.path.replace(/[^a-zA-Z0-9]+/g, '-')}`;
  }

  private parseColor(value: string): { r: number; g: number; b: number } {
    const normalized = value.trim().toLowerCase();
    const namedColor = Pzmap2DziConfigFormComponent.namedColors[normalized];
    const candidate = namedColor ?? normalized;
    const hexMatch = candidate.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hexMatch) {
      const hex = hexMatch[1].length === 3
        ? hexMatch[1].split('').map((part) => `${part}${part}`).join('')
        : hexMatch[1];
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
      };
    }
    const rgbMatch = candidate.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgbMatch) {
      return {
        r: Math.min(255, Number(rgbMatch[1])),
        g: Math.min(255, Number(rgbMatch[2])),
        b: Math.min(255, Number(rgbMatch[3])),
      };
    }
    return { r: 128, g: 128, b: 128 };
  }

  private rgbToHex(r: number, g: number, b: number): string {
    return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  private static readonly namedColors: Record<string, string> = {
    gray: '#808080',
    grey: '#808080',
    white: '#ffffff',
    blue: '#0000ff',
    cyan: '#00ffff',
    yellow: '#ffff00',
    lime: '#00ff00',
    green: '#008000',
    magenta: '#ff00ff',
    red: '#ff0000',
    deepskyblue: '#00bfff',
    slategray: '#708090',
    slategrey: '#708090',
    orangered: '#ff4500',
    orange: '#ffa500',
    forestgreen: '#228b22',
    olive: '#808000',
    olivedrab: '#6b8e23',
    darkolivegreen: '#556b2f',
    lawngreen: '#7cfc00',
    teal: '#008080',
  };

  inputId(field: ConfigField): string {
    return `pzmap2dzi-${field.path.replace(/[^a-zA-Z0-9]+/g, '-')}`;
  }

  isFolderField(field: ConfigField): boolean {
    return this.folderPathFields.has(field.path);
  }

  async browseForFolder(field: ConfigField): Promise<void> {
    if (!this.isTauriRuntime) {
      return;
    }

    const current = this.getFieldValue(field.path);
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: typeof current === 'string' && current.trim()
        ? this.normalizeWindowsPath(current)
        : undefined,
    });

    if (typeof selected === 'string' && selected.trim()) {
      this.setFieldValue(field.path, selected);
    }
  }

  addAdditionalMap(): void {
    this.additionalMaps.push({ name: '', folder: '' });
    this.markAsCustom('additional_maps');
    this.buildError = '';
    this.scheduleEstimateRefresh();
  }

  removeAdditionalMap(index: number): void {
    if (index < 0 || index >= this.additionalMaps.length) {
      return;
    }
    this.additionalMaps.splice(index, 1);
    this.markAsCustom('additional_maps');
    this.buildError = '';
    this.scheduleEstimateRefresh();
  }

  async browseForAdditionalMapFolder(index: number): Promise<void> {
    if (!this.isTauriRuntime) {
      return;
    }

    const map = this.additionalMaps[index];
    if (!map) {
      return;
    }

    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: map.folder.trim() ? map.folder : undefined,
    });

    if (typeof selected === 'string' && selected.trim()) {
      map.folder = this.normalizeWindowsPath(selected);
      this.markAsCustom('additional_maps');
      this.buildError = '';
      this.scheduleEstimateRefresh();
    }
  }

  async buildMap(sampleBuild = false): Promise<void> {
    this.buildError = '';
    if (!this.isTauriRuntime) {
      this.buildError = 'Map building is available in the Tauri desktop application.';
      return;
    }

    try {
      const config = this.buildConfig(sampleBuild);
      const output = await this.buildJob.inspectOutput(config);
      let outputWasPrepared = false;
      let resumeExistingOutput = false;
      let runConfig = config;
      if (output.exists) {
        if (!output.is_directory) {
          this.buildError = `The output path exists but is not a directory: ${output.path}. Choose a different output folder.`;
          return;
        }
        const resumeCandidate = sampleBuild
          ? null
          : await this.buildJob.inspectResume(config);
        const decision = await this.confirmOutputAction(output.path, resumeCandidate);
        if (decision === 'cancel') {
          this.buildError = 'Map build cancelled; the existing output was kept.';
          return;
        }
        if (decision === 'resume' && resumeCandidate) {
          runConfig = resumeCandidate.config;
          resumeExistingOutput = true;
        } else {
          await invoke('prepare_pzmap2dzi_output', {
            config,
            confirmed: true,
          });
          outputWasPrepared = true;
        }
      }
      this.buildEstimate = await invoke<DiskEstimate>('estimate_pzmap2dzi_build', {
        config: runConfig,
      });
      if (!this.buildEstimate.enough_space) {
        this.buildError = `Not enough free disk space. The build is estimated to use ${this.formatBytes(this.buildEstimate.output_bytes)}, but only ${this.formatBytes(this.buildEstimate.available_bytes)} is available on the output drive.`;
        return;
      }

      this.buildStatus = await this.buildJob.start(
        runConfig,
        outputWasPrepared,
        resumeExistingOutput,
      );
    } catch (error) {
      this.buildError = this.errorMessage(error);
    }
  }

  private confirmOutputAction(
    path: string,
    resumeCandidate: MapBuildResumeCandidate | null,
  ): Promise<'resume' | 'replace' | 'cancel'> {
    this.outputReplacementPath = path;
    this.resumeCandidate = resumeCandidate;
    this.outputReplacementDialogVisible = true;
    return new Promise<'resume' | 'replace' | 'cancel'>((resolve) => {
      this.outputReplacementResolver = resolve;
    });
  }

  resolveOutputReplacement(decision: 'resume' | 'replace' | 'cancel'): void {
    const resolver = this.outputReplacementResolver;
    this.outputReplacementResolver = null;
    this.outputReplacementDialogVisible = false;
    this.resumeCandidate = null;
    resolver?.(decision);
  }

  private buildConfig(sampleBuild: boolean): Record<string, unknown> {
    const config = JSON.parse(JSON.stringify(this.formValue)) as Record<string, unknown>;
    const additionalMaps: AdditionalMapEntry[] = [];
    const names = new Set<string>();
    for (const map of this.additionalMaps) {
      const name = map.name.trim();
      const folder = this.normalizeWindowsPath(map.folder.trim());
      if (!name && !folder) {
        continue;
      }
      if (!name) {
        throw new Error('Every additional map needs a name. The folder override is optional.');
      }
      if (names.has(name)) {
        throw new Error(`The additional map name “${name}” is duplicated.`);
      }
      names.add(name);
      additionalMaps.push({ name, folder });
    }
    config['additional_maps'] = additionalMaps;
    delete config['mod_maps'];
    delete config['custom_maps'];
    delete config['custom_map_paths'];
    if (sampleBuild) {
      config['sample_build'] = true;
      config['sample_cells'] = 1;
    }
    return config;
  }

  private additionalMapNames(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value
        .map((entry) => {
          if (typeof entry === 'string') {
            return entry.trim();
          }
          return this.isRecord(entry) ? String(entry['name'] ?? '').trim() : '';
        })
        .filter(Boolean);
    }
    if (typeof value === 'string') {
      return value
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    return [];
  }

  async importSettings(): Promise<void> {
    this.buildError = '';
    if (!this.isTauriRuntime) {
      this.buildError = 'YAML settings import is available in the Tauri desktop application.';
      return;
    }

    const selected = await openDialog({
      directory: false,
      multiple: false,
      filters: [{ name: 'Map builder settings', extensions: ['yaml', 'yml'] }],
    });
    if (typeof selected !== 'string' || !selected.trim()) {
      return;
    }

    try {
      const yaml = await invoke<string>('read_text_file', { path: selected });
      const imported = await invoke<Record<string, unknown>>('parse_pzmap2dzi_yaml', {
        content: yaml,
      });
      this.applyImportedSettings(imported);
      this.presetMode = 'custom';
      this.activeStep = 1;
      this.buildEstimate = null;
      this.scheduleEstimateRefresh();
    } catch (error) {
      this.buildError = `The YAML settings could not be imported: ${this.errorMessage(error)}`;
    }
  }

  async exportSettings(): Promise<void> {
    this.buildError = '';
    if (!this.isTauriRuntime) {
      this.buildError = 'YAML settings export is available in the Tauri desktop application.';
      return;
    }

    const selected = await this.openSaveDialog({
      defaultPath: 'pzmap-settings.yaml',
      filters: [{ name: 'Map builder settings', extensions: ['yaml', 'yml'] }],
    });
    if (typeof selected !== 'string' || !selected.trim()) {
      return;
    }

    try {
      const yaml = await invoke<string>('serialize_pzmap2dzi_yaml', {
        config: this.exportSettingsValue(),
      });
      const path = /\.(yaml|yml)$/i.test(selected) ? selected : `${selected}.yaml`;
      await invoke<void>('write_text_file', { path, content: yaml });
    } catch (error) {
      this.buildError = `The YAML settings could not be exported: ${this.errorMessage(error)}`;
    }
  }

  private exportSettingsValue(): Record<string, unknown> {
    const config = JSON.parse(JSON.stringify(this.formValue)) as Record<string, unknown>;
    config['additional_maps'] = JSON.parse(JSON.stringify(this.additionalMaps));
    for (const key of ['map_conf', 'save_games']) {
      const value = config[key];
      const isAllSaves = key === 'save_games'
        && typeof value === 'string'
        && value.trim().toLowerCase() === 'all';
      if (typeof value === 'string' && !isAllSaves) {
        config[key] = value
          .split(/\r?\n/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
    }
    delete config['mod_maps'];
    delete config['custom_maps'];
    delete config['custom_map_paths'];
    return config;
  }

  private async openSaveDialog(options: Record<string, unknown>): Promise<string | null> {
    return invoke<string | null>('plugin:dialog|save', { options });
  }

  private applyImportedSettings(imported: Record<string, unknown>): void {
    let source = this.isRecord(imported['settings'])
      ? imported['settings']
      : this.isRecord(imported['config'])
        ? imported['config']
        : imported;
    if (!('output_root' in source) && 'output_path' in source) {
      source = { ...source, output_root: source['output_path'] };
    }

    for (const key of Object.keys(this.formValue)) {
      if (!(key in source) || ['additional_maps', 'custom_maps', 'mod_maps', 'custom_map_paths'].includes(key)) {
        continue;
      }
      this.formValue[key] = this.mergeConfigValue(this.formValue[key], source[key]);
    }
    for (const key of this.folderPathFields) {
      const value = this.formValue[key];
      if (typeof value === 'string') {
        this.formValue[key] = this.normalizeWindowsPath(value);
      }
    }

    for (const key of ['map_conf', 'save_games']) {
      if (Array.isArray(this.formValue[key])) {
        this.formValue[key] = this.formValue[key]
          .map((entry) => String(entry).trim())
          .filter(Boolean)
          .join('\n');
      }
    }

    const importedMaps = this.importedAdditionalMaps(source);
    this.additionalMaps.splice(0, this.additionalMaps.length, ...importedMaps);
    if (this.additionalMaps.length === 0) {
      this.additionalMaps.push({ name: '', folder: '' });
    }
    this.formValue['additional_maps'] = this.additionalMaps;
  }

  private importedAdditionalMaps(source: Record<string, unknown>): AdditionalMapEntry[] {
    const entries: AdditionalMapEntry[] = [];
    const add = (rawName: unknown, rawFolder?: unknown): void => {
      const name = String(rawName ?? '').trim();
      const folder = this.normalizeWindowsPath(String(rawFolder ?? '').trim());
      if (!name) {
        return;
      }
      const existing = entries.find((entry) => entry.name === name);
      if (existing) {
        if (!existing.folder && folder) {
          existing.folder = folder;
        }
        return;
      }
      entries.push({ name, folder });
    };
    const addValue = (value: unknown): void => {
      if (typeof value === 'string') {
        for (const name of this.additionalMapNames(value)) {
          add(name);
        }
        return;
      }
      if (!Array.isArray(value)) {
        return;
      }
      for (const entry of value) {
        if (typeof entry === 'string') {
          add(entry);
        } else if (this.isRecord(entry)) {
          add(entry['name'] ?? entry['map_name'], entry['folder'] ?? entry['path']);
        }
      }
    };

    addValue(source['additional_maps']);
    addValue(source['custom_maps']);
    addValue(source['mod_maps']);
    if (this.isRecord(source['custom_map_paths'])) {
      for (const [name, folder] of Object.entries(source['custom_map_paths'])) {
        add(name, folder);
      }
    }
    return entries;
  }

  private mergeConfigValue(current: unknown, incoming: unknown): unknown {
    if (this.isRecord(current) && this.isRecord(incoming)) {
      const merged: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(incoming)) {
        merged[key] = key in merged ? this.mergeConfigValue(merged[key], value) : value;
      }
      return merged;
    }
    return incoming;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  async stopBuild(): Promise<void> {
    try {
      this.buildStatus = await this.buildJob.stop();
    } catch (error) {
      this.buildError = this.errorMessage(error);
    }
  }

  returnToMap(): void {
    this.refreshRequested.emit();
  }

  formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
  }

  formatDuration(minutes: number): string {
    if (minutes < 60) {
      return `about ${Math.round(minutes)} min`;
    }
    const hours = Math.floor(minutes / 60);
    const remainder = Math.round(minutes % 60);
    return remainder ? `about ${hours} hr ${remainder} min` : `about ${hours} hr`;
  }

  formatElapsed(seconds: number | null | undefined): string {
    const total = Math.max(0, Math.floor(seconds ?? 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remaining = total % 60;
    return hours > 0
      ? `${hours}h ${minutes.toString().padStart(2, '0')}m ${remaining.toString().padStart(2, '0')}s`
      : `${minutes}m ${remaining.toString().padStart(2, '0')}s`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
