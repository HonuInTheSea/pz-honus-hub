import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import OpenSeadragon from 'openseadragon';
import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TauriStoreService } from '../../services/tauri-store.service';
import { CharacterEditorService } from '../../services/character-editor.service';
import { Pzmap2DziJobService, type MapBuildStatus } from '../../services/pzmap2dzi-job.service';
import type { SaveMapMarker } from '../../models/character.models';
import {
  MapEditorToolsetComponent,
  type MapEditorMode,
  type MapEditorTool,
  type MapEditorToolsetOptions,
} from '../map-editor-toolset/map-editor-toolset.component';
import {
  MapEditorInlineSettingsComponent,
  type MapEditorLinePattern,
  type MapEditorPoiShape,
  type MapEditorPoiSize,
  type MapEditorSelectOption,
  type MapEditorStyleDraft,
} from '../map-editor-inline-settings/map-editor-inline-settings.component';
import { Pzmap2DziConfigFormComponent } from '../pzmap2dzi-config-form/pzmap2dzi-config-form.component';

type MapSourceType = 'local' | 'url';
type MapViewType = 'iso' | 'top';

interface WebMapSourceOption {
  label: string;
  value: string;
  url: string;
}

interface MapSourceSettings {
  sourceType: MapSourceType;
  sourceLocation: string;
  viewType?: MapViewType;
  selectedLayer?: number;
  navigation?: MapNavigationSettings;
  customPois?: CustomMapPoi[];
}

interface MapNavigationSettings {
  collapsed: boolean;
  sections: Partial<Record<ToolSection, boolean>>;
  selectedOverlay: string;
  activeOverlayLayers: string[];
  visibleMarkerGroups: string[];
  visibleAreaGroups: string[];
  viewport?: MapViewportState;
  showAnnotations?: boolean;
  showSaves?: boolean;
  markerDefaultsApplied?: boolean;
  navigationDefaultsApplied?: boolean;
}

type ToolSection = 'overlay' | 'layers' | 'markers' | 'editor' | 'legend' | 'coordinates';

interface MapRenderStatus {
  state: 'rendering' | 'ready' | 'error';
  message: string;
  expected_layers: number;
  layers_with_dzi: number;
  layers_with_tiles: number;
  available_layers: number[];
  render_process_active: boolean;
}

interface PzMapInfo {
  w: number;
  h: number;
  x0?: number;
  y0?: number;
  sqr?: number;
  cell_size?: number;
  block_size?: number;
  minlayer?: number;
  maxlayer?: number;
  pz_version?: string;
  pzmap2dzi_version?: string;
}

interface LayerOption {
  label: string;
  value: number;
}

interface MapPoi {
  id: string;
  name: string;
  x: number;
  y: number;
  layer?: number;
  color?: string;
  category?: string;
  description?: string;
  icon?: string;
  shape?: PoiShape;
  size?: PoiSize;
  isCustom?: boolean;
  isSave?: boolean;
  savedAt?: string | null;
  savePath?: string;
}

type PoiShape = MapEditorPoiShape;
type PoiSize = MapEditorPoiSize;
type LinePattern = MapEditorLinePattern;
type CustomGeometry = 'point' | 'line' | 'polygon' | 'text';
type EditorMode = MapEditorMode;

interface MapCoordinate {
  x: number;
  y: number;
}

interface CustomMapPoi {
  id: string;
  tool?: MapEditorTool;
  label: string;
  description: string;
  category?: 'my-poi';
  x: number;
  y: number;
  layer: number;
  icon: string;
  shape: PoiShape;
  color: string;
  size: PoiSize;
  strokeWidth?: number;
  linePattern?: LinePattern;
  geometry?: CustomGeometry;
  vertices?: MapCoordinate[];
}

interface PoiRenderCluster {
  x: number;
  y: number;
  items: MapPoi[];
  key: string;
}

interface MapContextMenu {
  x: number;
  y: number;
  squareX: number;
  squareY: number;
  clusterCount: number;
  vertexIndex: number | null;
  customPois: Array<{ id: string; label: string; geometry: CustomGeometry }>;
}

interface MapViewportState {
  squareX: number;
  squareY: number;
  zoom: number;
}

interface MapArea {
  id: string;
  name: string;
  layer?: number;
  rects: Array<{ x: number; y: number; width: number; height: number }>;
  color?: string;
  category?: string;
}

interface MapStreet {
  id: string;
  name: string;
  points: Array<{ x: number; y: number }>;
  layer?: number;
  color?: string;
  width?: number;
  textColor?: string;
  visibleZoomLevel?: number;
}

interface ZombieHeatmapData {
  cellSize: number;
  cellSizeInBlock: number;
  cells: Array<{ x: number; y: number; index: number }>;
  values: Uint8Array;
}

interface MapHoverCard {
  title: string;
  category: string;
  detail?: string;
  x: number;
  y: number;
}

interface MapLegendEntry {
  label: string;
  color: string;
}

interface MapLegendGroup {
  title: string;
  entries: MapLegendEntry[];
}

@Component({
  selector: 'app-project-zomboid-map',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    InputTextModule,
    MessageModule,
    SelectModule,
    TagModule,
    MapEditorToolsetComponent,
    MapEditorInlineSettingsComponent,
    Pzmap2DziConfigFormComponent,
  ],
  templateUrl: './project-zomboid-map.component.html',
  styleUrl: './project-zomboid-map.component.css',
})
export class ProjectZomboidMapComponent implements AfterViewInit, OnDestroy {
  @ViewChild('mapHost')
  private readonly mapHost!: ElementRef<HTMLElement>;
  @ViewChild('zoomInButton')
  private readonly zoomInButton!: ElementRef<HTMLButtonElement>;
  @ViewChild('zoomOutButton')
  private readonly zoomOutButton!: ElementRef<HTMLButtonElement>;
  @ViewChild('homeButton')
  private readonly homeButton!: ElementRef<HTMLButtonElement>;
  @ViewChild('fullPageButton')
  private readonly fullPageButton!: ElementRef<HTMLButtonElement>;
  @ViewChild('webSiteHost')
  private readonly webSiteHost?: ElementRef<HTMLElement>;

  readonly webMapSourceOptions: WebMapSourceOption[] = [
    {
      label: 'Official Project Zomboid Map',
      value: 'official-project-zomboid-map',
      url: 'https://map.projectzomboid.com/',
    },
    {
      label: 'Sunday Drivers',
      value: 'sunday-drivers',
      url: 'https://sundaydrivers.pro/',
    },
    {
      label: 'FanMap42',
      value: 'fanmap42',
      url: 'https://fanmap42.com/',
    },
    {
      label: 'PZ Map',
      value: 'pzmap-vercel',
      url: 'https://pzmap.vercel.app/',
    },
    {
      label: 'Project Zomboid Map',
      value: 'project-zomboid-map',
      url: 'https://zomboidmap.com/',
    },
  ];
  readonly mapWebSourceOverlayOptions = {
    autoZIndex: true,
    baseZIndex: 10000,
  };
  readonly mapViewOptions = [
    { label: 'Isometric', value: 'iso' as const },
    { label: 'Top-down', value: 'top' as const },
  ];
  readonly overlayOptions = [
    { label: 'None', value: '' },
    { label: 'Foraging', value: 'foraging' },
    { label: 'Zombie Heatmap', value: 'zombie' },
  ];
  readonly overlayLayerOptions = [
    { label: 'Rooms', value: 'rooms' },
    { label: 'Objects', value: 'objects' },
    { label: 'Streets', value: 'streets' },
  ];
  readonly markerGroupOptions = [
    { label: 'Abandoned towns', value: 'abandoned-towns', icon: 'pi pi-home' },
    { label: 'ATMs', value: 'atms', icon: 'pi pi-credit-card' },
    { label: 'Bodies of water', value: 'water', icon: 'pi pi-wave-pulse' },
    { label: 'Gas stations', value: 'gas', icon: 'pi pi-car' },
    { label: 'Main areas', value: 'main-areas', icon: 'pi pi-star' },
    { label: 'Points of interest', value: 'pois', icon: 'pi pi-map-marker' },
    { label: 'Shops', value: 'shops', icon: 'pi pi-shopping-bag' },
    { label: 'Towns', value: 'towns', icon: 'pi pi-building' },
    { label: 'Wells', value: 'wells', icon: 'pi pi-filter' },
  ];
  readonly poiIconOptions = [
    { label: 'Dot', value: '●' },
    { label: 'Star', value: '★' },
    { label: 'Diamond', value: '◆' },
    { label: 'Flag', value: '⚑' },
    { label: 'Home', value: '⌂' },
    { label: 'Alert', value: '!' },
  ];
  readonly poiShapeOptions: Array<{ label: string; value: PoiShape }> = [
    { label: 'Circle', value: 'circle' },
    { label: 'Square', value: 'square' },
    { label: 'Diamond', value: 'diamond' },
    { label: 'Triangle', value: 'triangle' },
    { label: 'Star', value: 'star' },
    { label: 'Pin', value: 'pin' },
    { label: 'Arrow', value: 'arrow' },
  ];
  readonly poiSizeOptions: Array<{ label: string; value: PoiSize }> = [
    { label: 'Small', value: 'small' },
    { label: 'Medium', value: 'medium' },
    { label: 'Large', value: 'large' },
  ];
  readonly poiStrokeWidthOptions = [
    { label: 'Thin (2 px)', value: 2 },
    { label: 'Medium (4 px)', value: 4 },
    { label: 'Thick (7 px)', value: 7 },
    { label: 'Heavy (10 px)', value: 10 },
  ];
  readonly linePatternOptions: Array<{ label: string; value: LinePattern }> = [
    { label: 'Solid', value: 'solid' },
    { label: 'Dashed', value: 'dashed' },
    { label: 'Dotted', value: 'dotted' },
    { label: 'Dash / dot', value: 'dash-dot' },
  ];
  readonly areaNameGroupOptions = [
    { label: 'Landmarks', value: 'landmarks', icon: 'pi pi-flag' },
    { label: 'Natural features', value: 'natural', icon: 'pi pi-sparkles' },
    { label: 'Settlements', value: 'settlements', icon: 'pi pi-building' },
  ];
  readonly legendSections: MapLegendGroup[] = [
    {
      title: 'Zombie density',
      entries: [
        { label: 'Sparse', color: '#1d4ed8' },
        { label: 'Moderate', color: '#facc15' },
        { label: 'Dense', color: '#dc2626' },
      ],
    },
    {
      title: 'Foraging zones',
      entries: [
        { label: 'Town zone', color: 'blue' },
        { label: 'Trailer park', color: 'cyan' },
        { label: 'Forest', color: 'lime' },
        { label: 'Deep forest', color: 'green' },
        { label: 'Farm land', color: 'magenta' },
        { label: 'Farm', color: 'red' },
        { label: 'Foraging navigation', color: 'white' },
        { label: 'Water', color: 'deepskyblue' },
        { label: 'PH forest', color: 'orangered' },
        { label: 'PR forest', color: 'forestgreen' },
        { label: 'Farm mix forest', color: 'olive' },
        { label: 'Farm forest', color: 'orange' },
        { label: 'Birch forest', color: 'olivedrab' },
        { label: 'Birch mix forest', color: 'darkolivegreen' },
        { label: 'Organic forest', color: 'lawngreen' },
      ],
    },
    {
      title: 'Objects',
      entries: [
        { label: 'Zombie type', color: 'red' },
        { label: 'Parking stall', color: 'blue' },
        { label: 'Zone story', color: 'yellow' },
      ],
    },
    {
      title: 'Rooms',
      entries: [
        { label: 'Cyan rooms', color: 'cyan' },
        { label: 'Orange rooms', color: 'orange' },
        { label: 'Silver / empty', color: 'silver' },
        { label: 'Blue rooms', color: 'blue' },
        { label: 'Lime rooms', color: 'lime' },
        { label: 'Magenta rooms', color: 'magenta' },
      ],
    },
    {
      title: 'Streets',
      entries: [
        { label: 'Street line', color: 'rgb(255, 255, 255)' },
        { label: 'Street line', color: 'rgb(0, 128, 128)' },
        { label: 'Street line', color: 'rgb(0, 255, 255)' },
      ],
    },
  ];
  private readonly defaultLocalSourceLocation = 'D:\\pzmap\\html\\map_data';
  private readonly defaultWebMapSource = 'official-project-zomboid-map';
  private localSourceLocation = this.defaultLocalSourceLocation;
  readonly isTauriRuntime: boolean;
  sourceType: MapSourceType = 'url';
  webMapSource = this.defaultWebMapSource;
  mapView: MapViewType = 'iso';
  sourceLocation = this.getWebMapSource(this.webMapSource).url;
  webMapSiteUrl = this.sourceLocation;
  openingMapInBrowser = false;
  layerOptions: LayerOption[] = [];
  selectedLayer = 0;
  mapInfo: PzMapInfo | null = null;
  loading = false;
  error = '';
  localMapMetadataMissing = false;
  tileError = '';
  hasLoadedMap = false;
  renderStatus: MapRenderStatus | null = null;
  navigationCollapsed = false;
  toolSections: Record<ToolSection, boolean> = {
    overlay: false,
    layers: false,
    markers: false,
    editor: false,
    legend: false,
    coordinates: false,
  };
  selectedOverlay = '';
  activeOverlayLayers = new Set<string>();
  visibleMarkerGroups = new Set<string>(['main-areas']);
  visibleAreaGroups = new Set<string>();
  showAnnotations = true;
  showSaves = false;
  showPoi = true;
  showStreets = false;
  mapCoordinates = '';
  manualCoordinateX: number | null = null;
  manualCoordinateY: number | null = null;
  coordinateEntryError = '';
  manualMarker: { x: number; y: number } | null = null;
  poiLoading = false;
  poiError = '';
  saveLoading = false;
  saveError = '';
  areaError = '';
  streetLoading = false;
  streetError = '';
  overlayError = '';
  hoverCard: MapHoverCard | null = null;
  contextMenu: MapContextMenu | null = null;
  pendingPoiCoordinate: { squareX: number; squareY: number } | null = null;
  pendingTool: MapEditorTool = 'point';
  editingPoiId: string | null = null;
  pendingGeometry: CustomGeometry = 'point';
  private pendingVertices: MapCoordinate[] | null = null;
  editorMode: EditorMode | null = null;
  editorGeometry: Exclude<CustomGeometry, 'point' | 'text'> | null = null;
  editorVertices: MapCoordinate[] = [];
  editorMessage = '';
  readonly editorToolsetOptions: MapEditorToolsetOptions = {
    tools: ['point', 'shape', 'text', 'line', 'polygon'],
    allowVertexEditing: true,
    allowDelete: true,
    readOnly: false,
    showStatus: true,
    showHelp: true,
    showFinish: true,
    showCancel: true,
  };
  poiDraft: MapEditorStyleDraft = {
    label: '',
    description: '',
    icon: '●',
    shape: 'circle',
    color: '#f59e0b',
    size: 'medium',
    strokeWidth: 4,
    linePattern: 'solid',
  };

  private readonly storeKey = 'map.viewer.source';
  @ViewChild('mapOverlayCanvas')
  private readonly mapOverlayCanvas!: ElementRef<HTMLCanvasElement>;
  private viewer: OpenSeadragon.Viewer | null = null;
  private loadedMapView: MapViewType | null = null;
  private pendingViewportRestore: MapViewportState | null = null;
  private viewReady = false;
  private renderStatusTimer: number | null = null;
  private tileErrorTimer: number | null = null;
  private viewportSaveTimer: number | null = null;
  private mapResizeObserver: ResizeObserver | null = null;
  private webSiteResizeObserver: ResizeObserver | null = null;
  private webSiteSyncFrame: number | null = null;
  private webSiteEmbeddingOperation: Promise<void> | null = null;
  private mapSourceDropdownVisibilityTask = Promise.resolve();
  private mapSiteHiddenForDropdown = false;
  private overlayFrame: number | null = null;
  private poiData: MapPoi[] = [];
  private saveData: SaveMapMarker[] = [];
  private customPois: CustomMapPoi[] = [];
  private areaData: MapArea[] = [];
  private streetData: MapStreet[] = [];
  private readonly overlayAreaData = new Map<string, MapArea[]>();
  private readonly overlayAreaLoading = new Set<string>();
  private readonly overlayAreaIndex = new Map<
    string,
    Array<{ area: MapArea; rect: MapArea['rects'][number] }>
  >();
  private readonly overlayAreaBucketSize = 64;
  private zombieHeatmapData: ZombieHeatmapData | null = null;
  private zombieHeatmapLoading = false;
  private poiLoaded = false;
  private areaLoaded = false;
  private streetLoaded = false;
  private readonly overlayTileItems = new Map<string, OpenSeadragon.TiledImage>();
  private loadedTileCount = 0;
  private hoveredStreetId: string | null = null;
  private hoveredPoiId: string | null = null;
  private hoveredPoiClusterKey: string | null = null;
  private hoveredAreaKey: string | null = null;
  private hoveredCustomGraphicId: string | null = null;
  private hoveredManualMarker = false;
  private hoverPulseFrame: number | null = null;
  private hoverPulsePhase = 0;
  private draggingEditorVertexIndex: number | null = null;
  private readonly fanMapMainAreas = [
    { name: 'Muldraugh', x: 10782, y: 9950 },
    { name: 'March Ridge', x: 10121, y: 12720 },
    { name: 'Rosewood', x: 8107, y: 11576 },
    { name: 'Ekron', x: 545, y: 9754 },
    { name: 'Irvington', x: 2498, y: 14253 },
    { name: 'Echo Creek', x: 3518, y: 10926 },
    { name: 'Brandenburg', x: 2101, y: 6076 },
    { name: 'Riverside', x: 6443, y: 5281 },
    { name: 'West Point', x: 11697, y: 6834 },
    { name: 'Louisville', x: 12936, y: 2238 },
    { name: 'Louisville Airport', x: 15436, y: 2940 },
    { name: 'Fallas Lake', x: 7276, y: 8345 },
    { name: 'Valley Station', x: 13515, y: 5082 },
  ] as const;

  constructor(
    private readonly store: TauriStoreService,
    private readonly ngZone: NgZone,
    private readonly characterEditor: CharacterEditorService,
    private readonly mapJob: Pzmap2DziJobService,
  ) {
    this.isTauriRuntime = this.store.isTauriRuntime();
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.startRenderStatusPolling();
    void this.restoreSettingsAndLoad();
    this.scheduleWebSiteEmbedding();
  }

  ngOnDestroy(): void {
    if (this.renderStatusTimer !== null) {
      window.clearInterval(this.renderStatusTimer);
      this.renderStatusTimer = null;
    }
    this.clearTileErrorTimer();
    if (this.overlayFrame !== null) {
      window.cancelAnimationFrame(this.overlayFrame);
      this.overlayFrame = null;
    }
    this.clearViewportSaveTimer();
    this.stopHoverPulseAnimation();
    if (this.webSiteSyncFrame !== null) {
      window.cancelAnimationFrame(this.webSiteSyncFrame);
      this.webSiteSyncFrame = null;
    }
    this.disconnectWebSiteResizeObserver();
    if (this.isTauriRuntime) {
      void this.closeEmbeddedWebSite();
    }
    this.destroyViewer();
  }

  async applySource(): Promise<void> {
    if (this.sourceType === 'url') {
      this.sourceLocation = this.getWebMapSource(this.webMapSource).url;
      this.updateWebMapSiteUrl();
      await this.writeSettings();
      this.scheduleWebSiteEmbedding();
      return;
    }

    if (this.sourceType === 'local') {
      this.localSourceLocation = this.sourceLocation.trim();
    }
    await this.loadMap(true);
  }

  refreshLocalMap(): void {
    void this.loadMap(true);
  }

  async browseForSource(): Promise<void> {
    if (!this.store.isTauriRuntime()) {
      this.error = 'Folder browsing is available in the Tauri desktop application.';
      return;
    }

    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: this.sourceLocation,
    });

    if (typeof selected === 'string' && selected.trim()) {
      this.sourceLocation = selected;
      this.localSourceLocation = selected;
      // Loading the render status alone does not create the OpenSeadragon
      // viewer. Start the normal map load so a valid selected package
      // immediately replaces the configurator with the map canvas.
      await this.loadMap(true);
    }
  }

  async webMapSourceChanged(): Promise<void> {
    if (this.sourceType !== 'url') {
      return;
    }

    this.sourceLocation = this.getWebMapSource(this.webMapSource).url;
    this.updateWebMapSiteUrl();
    await this.writeSettings();
    this.scheduleWebSiteEmbedding();
  }

  async openSelectedMapInBrowser(): Promise<void> {
    const url = this.getWebMapSource(this.webMapSource).url;
    this.openingMapInBrowser = true;
    this.error = '';

    try {
      if (this.isTauriRuntime) {
        await openUrl(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch (error) {
      this.error = `The map site could not be opened in the default browser: ${this.toErrorMessage(error)}`;
    } finally {
      this.openingMapInBrowser = false;
    }
  }

  onMapSourceDropdownShown(): void {
    if (!this.isTauriRuntime || this.mapSiteHiddenForDropdown) {
      return;
    }

    this.mapSourceDropdownVisibilityTask = this.mapSourceDropdownVisibilityTask.then(
      async () => {
        if (this.mapSiteHiddenForDropdown) {
          return;
        }

        try {
          await invoke('set_project_zomboid_map_visibility', { visible: false });
          this.mapSiteHiddenForDropdown = true;
        } catch (error) {
          this.error = this.toErrorMessage(error);
        }
      },
    );
  }

  onMapSourceDropdownHidden(): void {
    if (!this.isTauriRuntime) {
      return;
    }

    this.mapSourceDropdownVisibilityTask = this.mapSourceDropdownVisibilityTask.then(
      async () => {
        if (!this.mapSiteHiddenForDropdown) {
          return;
        }

        try {
          await invoke('set_project_zomboid_map_visibility', { visible: true });
        } catch (error) {
          this.error = this.toErrorMessage(error);
        } finally {
          this.mapSiteHiddenForDropdown = false;
        }
      },
    );
  }

  async mapViewChanged(): Promise<void> {
    if (this.sourceType === 'url') {
      return;
    }
    this.pendingViewportRestore = this.captureViewportState(this.loadedMapView);
    await this.loadMap(true);
  }

  async selectLayer(layer: number): Promise<void> {
    this.selectedLayer = Number(layer);
    if (!this.viewer || !this.mapInfo) {
      void this.writeSettings();
      return;
    }

    await this.openLayer(this.selectedLayer);
    this.reloadActiveOverlays();
    await this.writeSettings();
  }

  private async restoreSettingsAndLoad(): Promise<void> {
    const saved = await this.readSettings();
    if (saved) {
      this.sourceType = saved.sourceType;
      this.sourceLocation = saved.sourceLocation;
      if (saved.sourceType === 'local') {
        this.localSourceLocation = saved.sourceLocation;
      } else {
        this.webMapSource = this.findWebMapSource(this.sourceLocation)?.value
          ?? this.defaultWebMapSource;
        this.sourceLocation = this.getWebMapSource(this.webMapSource).url;
      }
      this.mapView = saved.viewType ?? 'iso';
      this.selectedLayer = typeof saved.selectedLayer === 'number' ? saved.selectedLayer : 0;
      this.customPois = this.normalizeCustomPois(saved.customPois);
      this.restoreNavigationSettings(saved.navigation);
    }
    const activeBuild = await this.mapJob.refresh();
    if (this.mapJob.isActive(activeBuild)) {
      await this.showBuilderForActiveJob(activeBuild);
      return;
    }
    if (this.sourceType === 'url') {
      this.updateWebMapSiteUrl();
      this.scheduleWebSiteEmbedding();
      return;
    }

    this.disconnectWebSiteResizeObserver();
    await this.closeEmbeddedWebSite();
    await this.waitForViewUpdate();
    await this.loadMap(false);
  }

  private async showBuilderForActiveJob(status: MapBuildStatus | null): Promise<void> {
    this.sourceType = 'local';
    const outputRoot = status?.estimate?.output_path?.trim();
    if (outputRoot) {
      const normalizedRoot = outputRoot.replace(/[\\/]+$/, '');
      this.localSourceLocation = `${normalizedRoot}\\html\\map_data`;
    }
    this.sourceLocation = this.localSourceLocation || this.defaultLocalSourceLocation;
    this.localMapMetadataMissing = true;
    this.loading = false;
    this.error = '';
    this.renderStatus = null;
    this.disconnectWebSiteResizeObserver();
    await this.closeEmbeddedWebSite();
    this.destroyViewer();
  }

  private async loadMap(saveSettings: boolean): Promise<void> {
    if (this.sourceType === 'url') {
      this.updateWebMapSiteUrl();
      this.scheduleWebSiteEmbedding();
      if (saveSettings) {
        await this.writeSettings();
      }
      return;
    }

    const showingConfigForm = this.localMapMetadataMissing;
    if (showingConfigForm) {
      this.localMapMetadataMissing = false;
      await this.waitForViewUpdate();
    }

    if (!this.viewReady || !this.sourceLocation.trim()) {
      this.error = 'Enter a local pzmap folder or a web address before loading the map.';
      return;
    }

    if (
      !this.mapHost ||
      !this.zoomInButton ||
      !this.zoomOutButton ||
      !this.homeButton ||
      !this.fullPageButton ||
      !this.mapOverlayCanvas
    ) {
      this.error = 'The local map viewer is still initializing. Try loading the map again.';
      return;
    }

    this.loading = true;
    this.error = '';
    this.tileError = '';
    this.clearTileErrorTimer();
    this.loadedTileCount = 0;
    this.hasLoadedMap = false;
    this.mapInfo = null;
    this.layerOptions = [];
    this.poiData = [];
    this.saveData = [];
    this.areaData = [];
    this.streetData = [];
    this.poiLoaded = false;
    this.areaLoaded = false;
    this.streetLoaded = false;
    this.poiError = '';
    this.areaError = '';
    this.streetError = '';
    this.saveError = '';
    this.overlayError = '';
    this.overlayAreaData.clear();
    this.overlayAreaLoading.clear();
    this.overlayAreaIndex.clear();
    this.zombieHeatmapData = null;
    this.zombieHeatmapLoading = false;
    this.showPoi = this.visibleMarkerGroups.size > 0;
    this.showStreets = this.activeOverlayLayers.has('streets');
    this.manualMarker = null;
    this.mapCoordinates = '';
    this.coordinateEntryError = '';
    this.hoverCard = null;
    this.hoveredStreetId = null;
    this.hoveredPoiId = null;
    this.hoveredPoiClusterKey = null;
    this.hoveredAreaKey = null;
    this.hoveredCustomGraphicId = null;
    this.hoveredManualMarker = false;
    this.hoverCard = null;
    this.destroyViewer();

    try {
      if (this.sourceType === 'local' && this.store.isTauriRuntime()) {
        await invoke('allow_map_asset_directory', {
          root: this.sourceLocation.trim(),
        });
      }

      const mapRoot = this.getMapRoot();
      const response = await this.fetchMapResource(
        this.buildResourceUrl(`${mapRoot}/map_info.json`),
        {
        cache: 'no-store',
        },
      );
      if (!response.ok) {
        this.localMapMetadataMissing = true;
        throw new Error(
            `Map metadata was not found (HTTP ${response.status}). Select a folder that contains ${mapRoot}/map_info.json.`,
        );
      }

      const info = (await response.json()) as PzMapInfo;
      this.validateMapInfo(info);
      this.mapInfo = info;
      this.layerOptions = this.createLayerOptions(info);
      if (this.sourceType === 'local' && this.store.isTauriRuntime()) {
        await this.refreshRenderStatus();
      }

      const preferredLayer = this.layerOptions.some(
        (option) => option.value === this.selectedLayer,
      )
        ? this.selectedLayer
        : undefined;
      const initialLayer =
        this.layerOptions.find((option) => option.value === preferredLayer)?.value ??
        this.layerOptions.find((option) => option.value === 0)?.value ??
        this.layerOptions[0]?.value;
      if (initialLayer === undefined) {
        this.loading = false;
        this.error =
          'No map layers currently contain tiles. The renderer may still be working.';
        return;
      }

      this.selectedLayer = initialLayer;
      const tileSources = await Promise.all(
        this.getLayerStack(initialLayer).map((layer) =>
          this.buildTileSource(`${mapRoot}/layer${layer}.dzi`),
        ),
      );

      this.viewer = this.ngZone.runOutsideAngular(() => {
        const viewer = OpenSeadragon({
          element: this.mapHost.nativeElement,
          tileSources: tileSources,
          // Canvas is the primary drawer because it produces cleaner edges for
          // this map. Chromium/Tauri may hardware-accelerate 2D canvas
          // compositing; WebGL remains a fallback when Canvas is unavailable.
          drawer: ['canvas', 'webgl'],
          drawerOptions: {
            canvas: {
              // Keep image conversion asynchronous where the browser supports
              // ImageBitmap workers, without opting into frequent readbacks.
              usePrivateCache: false,
              preloadCache: true,
            },
          },
          // Local tiles are served by Tauri from asset.localhost, which is a
          // different origin than the Angular document. Tauri supplies the
          // matching Access-Control-Allow-Origin header, so opt into CORS for
          // canvas rendering instead of allowing the canvas to be tainted.
          crossOriginPolicy: this.sourceType === 'local' ? 'Anonymous' : false,
          imageLoaderLimit: this.getTileLoaderLimit(),
          maxImageCacheCount: this.getTileCacheCount(),
          maxTilesPerFrame: this.getTileFrameLimit(),
          preload: true,
          immediateRender: true,
          tileRetryMax: 2,
          tileRetryDelay: 1500,
          mouseNavEnabled: true,
          keyboardNavEnabled: true,
          gestureSettingsMouse: {
            dragToPan: true,
            scrollToZoom: true,
            clickToZoom: false,
            dblClickToZoom: false,
          },
          // Keep one mouse-wheel step aligned with one dedicated zoom button
          // step. OpenSeadragon's buttons use zoomPerClick internally.
          zoomPerClick: 2,
          zoomPerScroll: 2,
          gestureSettingsTouch: {
            dragToPan: true,
            pinchToZoom: true,
          },
          homeFillsViewer: true,
          // Layer changes replace the stacked tile sources. Keep the current
          // center and zoom instead of returning to the home viewport.
          preserveViewport: true,
          // OpenSeadragon only binds supplied custom controls when the
          // navigation controls are enabled. The round buttons live inside
          // the map container and are supplied below.
          showNavigationControl: true,
          showNavigator: true,
          navigatorPosition: 'BOTTOM_RIGHT',
          navigatorBackground: 'var(--surface-ground)',
          navigatorOpacity: 0.85,
          constrainDuringPan: true,
          visibilityRatio: 0.5,
          minZoomImageRatio: 0.5,
          // The exact cap is tightened to the highest DZI level after the
          // sources open. Keep the initial cap conservative while they load.
          maxZoomPixelRatio: 1,
          imageSmoothingEnabled: false,
          zoomInButton: this.zoomInButton.nativeElement,
          zoomOutButton: this.zoomOutButton.nativeElement,
          homeButton: this.homeButton.nativeElement,
          fullPageButton: this.fullPageButton.nativeElement,
        });
        // Keep the custom canvas in the same coordinate space as
        // viewport.pixelFromPoint(). Doodle uses this arrangement so its
        // overlay remains aligned with OpenSeadragon through pan, zoom, and
        // resize operations.
        const overlayCanvas = this.mapOverlayCanvas.nativeElement;
        if (overlayCanvas.parentElement !== viewer.canvas) {
          viewer.canvas.appendChild(overlayCanvas);
        }
        overlayCanvas.style.position = 'absolute';
        overlayCanvas.style.inset = '0';
        overlayCanvas.style.pointerEvents = 'none';
        viewer.addHandler('canvas-click', (event) => {
          if (!event.quick) {
            return;
          }
          if (this.editorMode) {
            event.preventDefaultAction = true;
            const originalEvent = event.originalEvent;
            const clickCount = originalEvent instanceof MouseEvent ? originalEvent.detail : 1;
            this.ngZone.run(() => this.onEditorCanvasClick(event.position, clickCount));
            return;
          }
          const graphic = this.findEditableCustomPoiAtScreen(event.position.x, event.position.y);
          if (!graphic) {
            return;
          }
          event.preventDefaultAction = true;
          this.ngZone.run(() => this.beginEditCustomPoi(graphic.id));
        });
        viewer.addHandler('canvas-double-click', (event) => {
          if (!this.editorMode || this.editorMode === 'point' || this.editorMode === 'shape') {
            return;
          }
          event.preventDefaultAction = true;
          this.ngZone.run(() => this.finishEditorGeometry());
        });
        viewer.addHandler('open', () => {
          this.resizeViewer(viewer);
          this.constrainZoomToAvailableTiles(viewer);
          const pendingViewportRestore = this.pendingViewportRestore;
          this.pendingViewportRestore = null;
          if (pendingViewportRestore) {
            this.restoreViewportState(viewer, pendingViewportRestore);
          }
          this.loadedMapView = this.mapView;
          this.scheduleOverlayRender();
          this.ngZone.run(() => {
            this.loading = false;
            this.hasLoadedMap = true;
          });
          if (
            (this.showPoi || this.visibleAreaGroups.size > 0) &&
            !this.poiLoaded &&
            !this.poiLoading
          ) {
            void this.loadPoiData();
          }
          if (this.showSaves && !this.saveData.length) {
            void this.loadSaveMarkers();
          }
          this.reloadActiveOverlays();
        });
        viewer.addHandler('open-failed', (event) => {
          this.pendingViewportRestore = null;
          this.ngZone.run(() => {
            this.loading = false;
            this.error = `The selected map layer could not be loaded: ${event.message}`;
          });
        });
        viewer.addHandler('tile-load-failed', (event) => {
          this.ngZone.run(() => {
            // A pzmap2dzi render is intentionally sparse while it is running.
            // OpenSeadragon reports every missing coordinate as a tile error,
            // even when neighboring tiles are valid. Let successful requests
            // settle before surfacing a real failure to the user.
            if (this.renderStatus?.state === 'rendering') {
              return;
            }

            this.clearTileErrorTimer();
            this.tileErrorTimer = window.setTimeout(() => {
              this.tileErrorTimer = null;
              if (!this.tileError && this.loadedTileCount === 0) {
                const tileUrl = event.tile?.url ? ` (${event.tile.url})` : '';
                this.tileError = `A map tile could not be loaded: ${event.message}${tileUrl}`;
              }
            }, 1500);
          });
        });
        viewer.addHandler('tile-loaded', () => {
          this.ngZone.run(() => {
            this.clearTileErrorTimer();
            this.loadedTileCount += 1;
            this.tileError = '';
          });
        });
        viewer.addHandler('animation', () => {
          this.scheduleOverlayRender();
          this.scheduleViewportPersistence();
        });
        viewer.addHandler('pan', () => {
          this.scheduleOverlayRender();
          this.scheduleViewportPersistence();
        });
        viewer.addHandler('zoom', () => {
          this.scheduleOverlayRender();
          this.scheduleViewportPersistence();
        });
        viewer.addHandler('resize', () => this.scheduleOverlayRender());
        this.mapResizeObserver = new ResizeObserver(() => {
          this.resizeViewer(viewer);
          this.scheduleOverlayRender();
        });
        this.mapResizeObserver.observe(this.mapHost.nativeElement);
        requestAnimationFrame(() => this.resizeViewer(viewer));
        return viewer;
      });

      if (saveSettings) {
        await this.writeSettings();
      }
    } catch (error) {
      this.pendingViewportRestore = null;
      this.loading = false;
      const message = this.toErrorMessage(error);
      // Directory authorization happens before map_info.json is requested in
      // the Tauri runtime. Treat an unresolved package path like the existing
      // missing-metadata case so the builder replaces the map element and can
      // provide the user with a valid output path.
      if (this.isMapPackageResolutionError(message)) {
        this.localMapMetadataMissing = true;
      }
      this.error = message;
    }
  }

  private async openLayer(layer: number): Promise<void> {
    this.loading = true;
    this.error = '';
    this.tileError = '';
    this.clearTileErrorTimer();
    this.loadedTileCount = 0;

    try {
      const tileSources = await Promise.all(
        this.getLayerStack(layer).map((stackLayer) =>
          this.buildTileSource(
            `${this.getMapRoot()}/layer${stackLayer}.dzi`,
          ),
        ),
      );
      this.ngZone.runOutsideAngular(() => {
        this.viewer?.open(tileSources.map((tileSource) => ({ tileSource })));
      });
    } catch (error) {
      this.loading = false;
      this.error = this.toErrorMessage(error);
    }
  }

  private validateMapInfo(info: PzMapInfo): void {
    if (!Number.isFinite(info.w) || !Number.isFinite(info.h)) {
      throw new Error(
        'The selected folder is not a pzmap package. It contains no valid map dimensions.',
      );
    }

    if (
      typeof info.minlayer !== 'number' ||
      typeof info.maxlayer !== 'number' ||
      info.minlayer > 0 ||
      info.maxlayer < 1
    ) {
      throw new Error(
        'The selected folder does not expose the layered map metadata required by the Angular viewer.',
      );
    }
  }

  private createLayerOptions(
    info: PzMapInfo,
    availableLayers?: readonly number[],
  ): LayerOption[] {
    const minLayer = info.minlayer ?? 0;
    const maxLayer = info.maxlayer ?? 1;
    const available = availableLayers ? new Set(availableLayers) : null;
    // pzmap2dzi treats maxlayer as an exclusive upper bound. Display the
    // highest positive floor first, then ground level, then the lower floors.
    return Array.from(
      { length: Math.max(0, maxLayer - minLayer) },
      (_, index) => {
        const value = maxLayer - 1 - index;
        if (available && !available.has(value)) {
          return null;
        }
        return {
          value,
          label: value === 0
            ? 'Ground'
            : value > 0
              ? `Floor ${value}`
              : `Basement ${Math.abs(value)}`,
        };
      },
    ).filter((option): option is LayerOption => option !== null);
  }

  private getMapRoot(): string {
    return this.mapView === 'top' ? 'base_top' : 'base';
  }

  private getWebMapSource(value: string): WebMapSourceOption {
    return this.webMapSourceOptions.find((option) => option.value === value)
      ?? this.webMapSourceOptions.find((option) => option.value === this.defaultWebMapSource)
      ?? this.webMapSourceOptions[0];
  }

  private findWebMapSource(location: string): WebMapSourceOption | undefined {
    const normalizedLocation = location.trim().replace(/[\\/]+$/, '');
    return this.webMapSourceOptions.find(
      (option) => option.url.replace(/[\\/]+$/, '') === normalizedLocation,
    );
  }

  private getLayerStack(selectedLayer: number): number[] {
    const availableLayers = this.layerOptions
      .map((option) => option.value)
      .filter((layer) => layer !== undefined);

    if (selectedLayer >= 0) {
      return availableLayers
        .filter((layer) => layer >= 0 && layer <= selectedLayer)
        .sort((a, b) => a - b);
    }

    // A negative floor is an independent underground view. Do not stack it
    // with lower negative floors or with the ground/positive floors.
    return availableLayers
      .filter((layer) => layer === selectedLayer);
  }

  private isOverlayLayerVisible(layer?: number): boolean {
    if (layer === undefined) {
      return true;
    }
    if (this.selectedLayer < 0) {
      return layer === this.selectedLayer;
    }
    return layer >= 0 && layer <= this.selectedLayer;
  }

  toggleNavigation(): void {
    this.navigationCollapsed = !this.navigationCollapsed;
    void this.writeSettings();
  }

  toggleToolSection(section: ToolSection): void {
    this.toolSections[section] = !this.toolSections[section];
    if (section === 'coordinates' && !this.toolSections.coordinates) {
      this.mapCoordinates = '';
      this.coordinateEntryError = '';
    }
    void this.writeSettings();
  }

  isToolSectionExpanded(section: ToolSection): boolean {
    return this.toolSections[section];
  }

  selectOverlay(overlay: string): void {
    const previous = this.selectedOverlay;
    this.selectedOverlay = overlay;
    if (previous) {
      this.removeOverlayTile(previous);
    }
    if (overlay) {
      void this.loadOverlayTile(overlay);
    }
    this.scheduleOverlayRender();
    void this.writeSettings();
  }

  toggleOverlayLayer(layer: string): void {
    if (this.activeOverlayLayers.has(layer)) {
      this.activeOverlayLayers.delete(layer);
      this.removeOverlayTile(layer);
      this.hoverCard = null;
      if (layer === 'streets') {
        this.showStreets = false;
      }
    } else {
      this.activeOverlayLayers.add(layer);
      if (layer === 'streets') {
        this.showStreets = true;
        if (!this.streetLoaded && !this.streetLoading) {
          void this.loadStreetData();
        }
      } else if (layer === 'rooms' || layer === 'objects') {
        void this.loadAreaOverlayData(layer);
      } else {
        void this.loadOverlayTile(layer);
      }
    }
    this.scheduleOverlayRender();
    void this.writeSettings();
  }

  isOverlayLayerActive(layer: string): boolean {
    return this.activeOverlayLayers.has(layer);
  }

  private isOverlayActive(overlay: string): boolean {
    return this.selectedOverlay === overlay || this.activeOverlayLayers.has(overlay);
  }

  toggleMarkerGroup(group: string): void {
    if (group === 'place-names') {
      this.visibleAreaGroups = this.visibleAreaGroups.size > 0
        ? new Set<string>()
        : new Set(this.areaNameGroupOptions.map((option) => option.value));
      if (this.visibleAreaGroups.size > 0 && !this.areaLoaded && !this.poiLoading) {
        void this.loadPoiData();
      }
      this.scheduleOverlayRender();
      void this.writeSettings();
      return;
    }
    if (this.visibleMarkerGroups.has(group)) {
      this.visibleMarkerGroups.delete(group);
    } else {
      this.visibleMarkerGroups.add(group);
    }
    this.showPoi = this.visibleMarkerGroups.size > 0;
    if (this.showPoi && !this.poiLoaded && !this.poiLoading) {
      void this.loadPoiData();
    }
    this.scheduleOverlayRender();
    void this.writeSettings();
  }

  isMarkerGroupVisible(group: string): boolean {
    if (group === 'place-names') {
      return this.visibleAreaGroups.size > 0;
    }
    return this.visibleMarkerGroups.has(group);
  }

  toggleAnnotations(): void {
    this.showAnnotations = !this.showAnnotations;
    this.clearPoiHover();
    this.clearMapGraphicHover();
    this.scheduleOverlayRender();
    void this.writeSettings();
  }

  toggleSaves(): void {
    this.showSaves = !this.showSaves;
    this.clearPoiHover();
    if (this.showSaves && this.isTauriRuntime) {
      void this.loadSaveMarkers();
    }
    this.scheduleOverlayRender();
    void this.writeSettings();
  }

  startEditor(mode: MapEditorTool): void {
    if (this.editorToolsetOptions.readOnly) {
      this.editorMessage = 'The map editor is read-only.';
      return;
    }
    if (!this.editorToolsetOptions.tools?.includes(mode)) {
      return;
    }
    if (this.editorMode === mode) {
      this.cancelEditor();
      void this.writeSettings();
      return;
    }
    if (!this.viewer || !this.mapInfo) {
      this.editorMessage = 'Load a local map before adding map graphics.';
      return;
    }
    this.cancelEditor();
    this.editorMode = mode;
    this.editorGeometry = mode === 'line' || mode === 'polygon' ? mode : null;
    this.editorVertices = [];
    this.editorMessage = this.editorToolMessage(mode);
    this.setEditorMouseNavigation(false);
    this.scheduleOverlayRender();
  }

  get editorFinishLabel(): string {
    return this.editorMode === 'line' || this.editorMode === 'polygon'
      ? 'Save shape'
      : 'Save graphic';
  }

  get editorToolMode(): MapEditorTool | null {
    return this.editorMode === 'edit' ? null : this.editorMode;
  }

  get editorFinishDisabled(): boolean {
    if (!this.editorMode) {
      return true;
    }
    if (this.editorMode === 'polygon') {
      return this.editorVertices.length < 3;
    }
    if (this.editorMode === 'line') {
      return this.editorVertices.length < 2;
    }
    return !this.pendingPoiCoordinate;
  }

  finishEditor(): void {
    if (this.editorMode === 'line' || this.editorMode === 'polygon') {
      this.finishEditorGeometry();
      return;
    }
    this.saveCustomPoi();
  }

  finishEditorGeometry(): void {
    if (!this.editorGeometry || (this.editorMode !== 'line' && this.editorMode !== 'polygon')) {
      return;
    }
    const minimumVertices = this.editorGeometry === 'polygon' ? 3 : 2;
    if (this.editorVertices.length < minimumVertices) {
      this.editorMessage = `${this.editorGeometry === 'polygon' ? 'A polygon' : 'A line'} needs at least ${minimumVertices} vertices.`;
      return;
    }
    const tool: MapEditorTool = this.editorMode === 'line' || this.editorMode === 'polygon'
      ? this.editorMode
      : this.pendingTool;
    this.pendingTool = tool;
    this.pendingPoiCoordinate = this.getGeometryAnchor(this.editorVertices);
    this.pendingGeometry = this.editorGeometry;
    this.pendingVertices = this.editorVertices.map((vertex) => ({ ...vertex }));
    this.saveCustomPoi();
  }

  onEditorStyleChange(): void {
    this.scheduleOverlayRender();
  }

  cancelEditor(keepEditorPanelOpen = true): void {
    this.editorMode = null;
    this.editorGeometry = null;
    this.editorVertices = [];
    this.draggingEditorVertexIndex = null;
    this.editorMessage = '';
    this.editingPoiId = null;
    this.pendingPoiCoordinate = null;
    this.pendingTool = 'point';
    this.pendingGeometry = 'point';
    this.pendingVertices = null;
    this.setEditorMouseNavigation(true);
    this.contextMenu = null;
    if (keepEditorPanelOpen) {
      this.toolSections.editor = true;
    }
    this.scheduleOverlayRender();
  }

  cancelDrawing(): void {
    const selectedTool = this.editorMode !== null && this.editorMode !== 'edit'
      ? this.editorMode
      : null;
    this.cancelEditor();
    if (!selectedTool) {
      return;
    }
    this.editorMode = selectedTool;
    this.editorGeometry = selectedTool === 'line' || selectedTool === 'polygon'
      ? selectedTool
      : null;
    this.pendingTool = selectedTool;
    this.pendingGeometry = selectedTool === 'text'
      ? 'text'
      : this.editorGeometry ?? 'point';
    this.editorMessage = this.editorToolMessage(selectedTool);
    this.setEditorMouseNavigation(false);
    this.toolSections.editor = true;
    this.scheduleOverlayRender();
  }

  private editorToolMessage(mode: MapEditorTool): string {
    if (mode === 'shape') {
      return 'Click the map to place a shape, then choose its style.';
    }
    if (mode === 'text') {
      return 'Click the map to place a text label.';
    }
    if (mode === 'point') {
      return 'Click the map to place a point.';
    }
    return 'Click to add vertices. Double-click or use Save shape when complete.';
  }

  private onEditorCanvasClick(screenPoint: OpenSeadragon.Point, clickCount: number): void {
    if (!this.editorMode) {
      return;
    }
    const coordinate = this.screenToSquare(screenPoint);
    if (!coordinate) {
      return;
    }
    if (this.editorMode === 'point' || this.editorMode === 'shape' || this.editorMode === 'text') {
      if (this.editingPoiId !== null) {
        return;
      }
      const shapeMode = this.editorMode === 'shape';
      const textMode = this.editorMode === 'text';
      this.cancelEditor();
      this.beginAddCustomPoiAtCoordinate(coordinate, shapeMode, textMode);
      return;
    }
    if (this.editingPoiId !== null || !this.editorGeometry) {
      return;
    }
    this.editorVertices = [...this.editorVertices, coordinate];
    this.scheduleOverlayRender();
    if (clickCount >= 2) {
      this.finishEditorGeometry();
    }
  }

  private findEditorVertexAtScreen(screenX: number, screenY: number): number {
    if (
      !this.editorMode ||
      (this.editorMode !== 'edit' && this.editorMode !== 'line' && this.editorMode !== 'polygon')
    ) {
      return -1;
    }
    return this.editorVertices.findIndex((vertex) => {
      const point = this.squareToScreen(vertex.x, vertex.y);
      return !!point && Math.hypot(point.x - screenX, point.y - screenY) <= 14;
    });
  }

  onMapPointerDown(event: MouseEvent): void {
    if (
      event.button !== 0 ||
      this.editingPoiId === null ||
      !this.editorGeometry ||
      this.isMapControlTarget(event.target)
    ) {
      return;
    }
    const screenPoint = this.getMapScreenPoint(event);
    if (!screenPoint) {
      return;
    }
    const vertexIndex = this.editorVertices.findIndex((vertex) => {
      const point = this.squareToScreen(vertex.x, vertex.y);
      return !!point && Math.hypot(point.x - screenPoint.x, point.y - screenPoint.y) <= 14;
    });
    if (vertexIndex < 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.draggingEditorVertexIndex = vertexIndex;
  }

  onMapPointerUp(): void {
    this.draggingEditorVertexIndex = null;
  }

  get editorModeLabel(): string {
    if (this.editorMode) {
      if (this.editingPoiId !== null) {
        return this.editorMode === 'point' || this.editorMode === 'shape' || this.editorMode === 'text'
          ? 'Editing graphic'
          : `Editing ${this.editorMode}`;
      }
      return this.editorMode === 'point' ? 'Adding point' : `Drawing ${this.editorMode}`;
    }
    return '';
  }

  geometryLabel(geometry: CustomGeometry): string {
    return geometry === 'point' ? 'point' : geometry === 'text' ? 'text label' : geometry;
  }

  private beginAddCustomPoiAtCoordinate(
    coordinate: MapCoordinate,
    shapeMode = false,
    textMode = false,
  ): void {
    const tool: MapEditorTool = textMode ? 'text' : shapeMode ? 'shape' : 'point';
    this.pendingPoiCoordinate = { squareX: coordinate.x, squareY: coordinate.y };
    this.pendingTool = tool;
    this.pendingGeometry = textMode ? 'text' : 'point';
    this.pendingVertices = null;
    this.editingPoiId = null;
    this.editorMode = tool;
    this.editorGeometry = null;
    this.editorVertices = [];
    this.poiDraft = {
      label: '',
      description: '',
      icon: '●',
      shape: 'circle',
      color: '#f59e0b',
      size: 'medium',
      strokeWidth: 4,
      linePattern: 'solid',
    };
    this.editorMessage = 'Set the graphic properties, then save it.';
    this.setEditorMouseNavigation(false);
    this.contextMenu = null;
    this.navigationCollapsed = false;
    this.toolSections.editor = true;
    this.scheduleOverlayRender();
  }

  private getGeometryAnchor(vertices: MapCoordinate[]): { squareX: number; squareY: number } {
    return {
      squareX: vertices.reduce((sum, vertex) => sum + vertex.x, 0) / vertices.length,
      squareY: vertices.reduce((sum, vertex) => sum + vertex.y, 0) / vertices.length,
    };
  }

  private setEditorMouseNavigation(enabled: boolean): void {
    const viewer = this.viewer;
    if (!viewer) {
      return;
    }
    // Keep OpenSeadragon's MouseTracker alive so canvas-click and canvas-drag
    // events still reach the editor. Only pan is disabled while drawing,
    // matching Doodle's setPan behavior.
    viewer.setMouseNavEnabled(true);
    const navigationViewer = viewer as OpenSeadragon.Viewer & {
      panHorizontal: boolean;
      panVertical: boolean;
    };
    navigationViewer.panHorizontal = enabled;
    navigationViewer.panVertical = enabled;
  }

  private isMapControlTarget(target: EventTarget | null): boolean {
    return !!(target as HTMLElement | null)?.closest(
      '.map-tool-rail, .map-container-controls, .map-context-menu, .map-hover-card',
    );
  }

  private getMapScreenPoint(event: MouseEvent): OpenSeadragon.Point | null {
    const canvasRect = (this.viewer?.canvas ?? this.mapHost.nativeElement).getBoundingClientRect();
    return new OpenSeadragon.Point(event.clientX - canvasRect.left, event.clientY - canvasRect.top);
  }

  private screenToSquare(screenPoint: OpenSeadragon.Point): MapCoordinate | null {
    const viewer = this.viewer;
    if (!viewer) {
      return null;
    }
    const imagePoint = viewer.world
      .getItemAt(0)
      ?.viewportToImageCoordinates(
        viewer.viewport.pointFromPixel(screenPoint, true),
        true,
      );
    if (!imagePoint) {
      return null;
    }
    const [x, y] = this.imageToSquare(imagePoint.x, imagePoint.y);
    return { x, y };
  }

  onMapContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenu = null;

    const target = event.target as HTMLElement | null;
    if (
      !this.viewer ||
      !this.mapInfo ||
      target?.closest('.map-tool-rail, .map-container-controls, .map-context-menu')
    ) {
      return;
    }

    const hostRect = this.mapHost.nativeElement.getBoundingClientRect();
    const canvasRect = (this.viewer.canvas ?? this.mapHost.nativeElement).getBoundingClientRect();
    const screenPoint = new OpenSeadragon.Point(
      event.clientX - canvasRect.left,
      event.clientY - canvasRect.top,
    );
    const editorVertexIndex = this.findEditorVertexAtScreen(screenPoint.x, screenPoint.y);
    if (editorVertexIndex >= 0) {
      this.contextMenu = {
        x: Math.min(
          Math.max(8, screenPoint.x + canvasRect.left - hostRect.left),
          Math.max(8, hostRect.width - 190),
        ),
        y: Math.min(
          Math.max(8, screenPoint.y + canvasRect.top - hostRect.top),
          Math.max(8, hostRect.height - 58),
        ),
        squareX: 0,
        squareY: 0,
        clusterCount: 0,
        vertexIndex: editorVertexIndex,
        customPois: [],
      };
      return;
    }

    // A drawing session owns map clicks. Avoid opening a second workflow from
    // a right-click while a shape is being placed or reshaped.
    if (this.editorMode || this.editorToolsetOptions.readOnly) {
      return;
    }

    const imagePoint = this.viewer.world
      .getItemAt(0)
      ?.viewportToImageCoordinates(
        this.viewer.viewport.pointFromPixel(screenPoint, true),
        true,
      );
    if (!imagePoint) {
      return;
    }

    const [squareX, squareY] = this.imageToSquare(imagePoint.x, imagePoint.y);
    const poiHit = this.findPoiAtScreen(screenPoint.x, screenPoint.y);
    const customGraphicHit = this.findCustomGraphicAtScreen(screenPoint.x, screenPoint.y);
    const customPois = [
      ...(poiHit?.cluster.items
        .filter((poi) => poi.isCustom)
        .map((poi) => ({
          id: poi.id,
          label: poi.name,
          geometry: 'point' as const,
        })) ?? []),
      ...(customGraphicHit
        ? [{ id: customGraphicHit.id, label: customGraphicHit.label, geometry: customGraphicHit.geometry ?? 'point' }]
        : []),
    ].filter((item, index, items) => items.findIndex((candidate) => candidate.id === item.id) === index);
    this.contextMenu = {
      x: Math.min(
        Math.max(8, screenPoint.x + canvasRect.left - hostRect.left),
        Math.max(8, hostRect.width - 190),
      ),
      y: Math.min(
        Math.max(8, screenPoint.y + canvasRect.top - hostRect.top),
        Math.max(8, hostRect.height - 58),
      ),
      squareX,
      squareY,
      clusterCount: poiHit?.cluster.items.length ?? 0,
      vertexIndex: null,
      customPois,
    };
  }

  deleteEditorVertex(index: number | null): void {
    if (
      this.editorToolsetOptions.readOnly ||
      this.editorToolsetOptions.allowDelete === false ||
      !this.editorMode ||
      index === null ||
      index < 0 ||
      index >= this.editorVertices.length
    ) {
      return;
    }
    this.editorVertices = this.editorVertices.filter((_, vertexIndex) => vertexIndex !== index);
    this.contextMenu = null;
    this.editorMessage = this.editorVertices.length
      ? 'Vertex deleted. Continue drawing or save the shape.'
      : 'All vertices cleared. Click the map to start again.';
    this.scheduleOverlayRender();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target?.closest('.map-context-menu')) {
      this.contextMenu = null;
    }
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.contextMenu = null;
    if (this.editorMode) {
      this.cancelDrawing();
    }
  }

  beginAddCustomPoi(): void {
    if (!this.contextMenu) {
      return;
    }
    this.beginAddCustomPoiAtCoordinate({ x: this.contextMenu.squareX, y: this.contextMenu.squareY });
  }

  beginEditCustomPoi(id: string): void {
    if (this.editorToolsetOptions.readOnly) {
      return;
    }
    const poi = this.customPois.find((item) => item.id === id);
    if (!poi) {
      return;
    }
    const geometry = poi.geometry ?? 'point';
    const tool = poi.tool ?? (geometry === 'text' ? 'text' : geometry === 'line' || geometry === 'polygon' ? geometry : 'point');
    this.cancelEditor();
    this.navigationCollapsed = false;
    this.toolSections.editor = true;
    this.editingPoiId = poi.id;
    this.pendingTool = tool;
    this.pendingGeometry = geometry;
    this.poiDraft = {
      label: poi.label,
      description: poi.description,
      icon: poi.icon,
      shape: poi.shape,
      color: poi.color,
      size: poi.size,
      strokeWidth: poi.strokeWidth ?? 4,
      linePattern: poi.linePattern ?? 'solid',
    };
    if (geometry !== 'point' && geometry !== 'text') {
      if (this.editorToolsetOptions.allowVertexEditing === false) {
        this.cancelEditor();
        return;
      }
      const vertices = poi.vertices?.map((vertex) => ({ ...vertex })) ?? [];
      if (vertices.length < (geometry === 'polygon' ? 3 : 2)) {
        this.cancelEditor();
        return;
      }
      this.pendingPoiCoordinate = this.getGeometryAnchor(vertices);
      this.pendingVertices = vertices;
      this.editorMode = tool;
      this.editorGeometry = geometry;
      this.editorVertices = vertices;
      this.editorMessage = `Editing ${geometry} vertices. Update its properties, then save.`;
      this.contextMenu = null;
      this.setEditorMouseNavigation(false);
      this.scheduleOverlayRender();
      return;
    }
    this.pendingPoiCoordinate = { squareX: poi.x, squareY: poi.y };
    this.pendingVertices = null;
    this.editorMode = tool;
    this.editorGeometry = null;
    this.editorVertices = [];
    this.editorMessage = 'Update the graphic properties, then save it.';
    this.setEditorMouseNavigation(false);
    this.contextMenu = null;
    this.scheduleOverlayRender();
  }

  deleteCustomPoi(id: string): void {
    if (this.editorToolsetOptions.readOnly || this.editorToolsetOptions.allowDelete === false) {
      return;
    }
    if (!this.customPois.some((poi) => poi.id === id)) {
      return;
    }
    this.customPois = this.customPois.filter((poi) => poi.id !== id);
    if (this.editingPoiId === id) {
      this.cancelEditor();
    }
    this.clearPoiHover();
    this.contextMenu = null;
    this.scheduleOverlayRender();
    void this.writeSettings();
  }

  saveCustomPoi(): void {
    const label = this.poiDraft.label.trim();
    if (!label) {
      this.editorMessage = 'Enter a label for this map graphic.';
      return;
    }

    const coordinate = this.pendingPoiCoordinate;
    if (!coordinate) {
      this.editorMessage = 'Click the map to place this graphic first.';
      return;
    }

    const nextPoi: CustomMapPoi = {
      id: this.editingPoiId ?? this.createPoiId(),
      tool: this.pendingTool,
      label,
      description: this.poiDraft.description.trim(),
      category: 'my-poi',
      x: coordinate.squareX,
      y: coordinate.squareY,
      layer: this.editingPoiId
        ? this.customPois.find((poi) => poi.id === this.editingPoiId)?.layer ?? this.selectedLayer
        : this.selectedLayer,
      icon: this.poiDraft.icon,
      shape: this.poiDraft.shape,
      color: this.poiDraft.color,
      size: this.poiDraft.size,
      strokeWidth: this.normalizeStrokeWidth(this.poiDraft.strokeWidth),
      linePattern: this.normalizeLinePattern(this.poiDraft.linePattern),
      geometry: this.pendingGeometry,
      vertices: this.pendingGeometry === 'point' || this.pendingGeometry === 'text'
        ? undefined
        : this.pendingVertices ?? undefined,
    };
    this.customPois = this.editingPoiId
      ? this.customPois.map((poi) => poi.id === this.editingPoiId ? nextPoi : poi)
      : [...this.customPois, nextPoi];
    this.showAnnotations = true;
    this.editorMode = null;
    this.editorGeometry = null;
    this.editorVertices = [];
    this.draggingEditorVertexIndex = null;
    this.editorMessage = '';
    this.setEditorMouseNavigation(true);
    this.pendingPoiCoordinate = null;
    this.editingPoiId = null;
    this.pendingTool = 'point';
    this.pendingGeometry = 'point';
    this.pendingVertices = null;
    this.clearPoiHover();
    this.scheduleOverlayRender();
    void this.writeSettings();
  }

  toggleAreaGroup(group: string): void {
    if (this.visibleAreaGroups.has(group)) {
      this.visibleAreaGroups.delete(group);
    } else {
      this.visibleAreaGroups.add(group);
    }
    if (this.visibleAreaGroups.size > 0 && !this.areaLoaded && !this.poiLoading) {
      void this.loadPoiData();
    }
    this.scheduleOverlayRender();
    void this.writeSettings();
  }

  isAreaGroupVisible(group: string): boolean {
    return this.visibleAreaGroups.has(group);
  }

  goToManualCoordinate(): void {
    const x = Number(this.manualCoordinateX);
    const y = Number(this.manualCoordinateY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.coordinateEntryError = 'Enter valid numeric X and Y coordinates.';
      return;
    }
    if (!this.viewer || !this.mapInfo) {
      this.coordinateEntryError = 'Load a map before navigating to a coordinate.';
      return;
    }

    const item = this.viewer.world.getItemAt(0);
    const imagePoint = this.squareToImage(x, y);
    if (!item || !imagePoint) {
      this.coordinateEntryError = 'The coordinate could not be projected onto this map.';
      return;
    }

    const viewportPoint = item.imageToViewportCoordinates(imagePoint.x, imagePoint.y);
    const homeZoom = this.viewer.viewport.getHomeZoom();
    const targetZoom = Math.max(this.viewer.viewport.getZoom(true), homeZoom * 2);
    this.manualCoordinateX = x;
    this.manualCoordinateY = y;
    this.manualMarker = { x, y };
    const cellSize = this.mapInfo.cell_size ?? 256;
    this.mapCoordinates = [
      `x: ${Math.floor(x)}, y: ${Math.floor(y)}`,
      `cell: ${Math.floor(x / cellSize)}, ${Math.floor(y / cellSize)}`,
      `layer: ${this.selectedLayer}`,
    ].join('\n');
    this.coordinateEntryError = '';
    this.viewer.viewport.panTo(viewportPoint, true);
    this.viewer.viewport.zoomTo(targetZoom, viewportPoint, true);
    this.scheduleOverlayRender();
  }

  async resetMapView(): Promise<void> {
    this.navigationCollapsed = false;
    this.toolSections = {
      overlay: false,
      layers: false,
      markers: false,
      editor: false,
      legend: false,
      coordinates: false,
    };
    this.selectedOverlay = '';
    this.activeOverlayLayers.clear();
    this.visibleMarkerGroups = new Set<string>(['main-areas']);
    this.visibleAreaGroups.clear();
    this.showAnnotations = true;
    this.showSaves = false;
    this.showPoi = true;
    this.showStreets = false;
    this.manualCoordinateX = null;
    this.manualCoordinateY = null;
    this.manualMarker = null;
    this.cancelEditor(false);
    this.pendingViewportRestore = null;
    this.mapCoordinates = '';
    this.coordinateEntryError = '';
    this.localMapMetadataMissing = false;
    this.contextMenu = null;
    this.sourceType = 'url';
    this.webMapSource = this.defaultWebMapSource;
    this.sourceLocation = this.getWebMapSource(this.webMapSource).url;
    this.updateWebMapSiteUrl();
    this.localSourceLocation = this.defaultLocalSourceLocation;
    this.mapView = 'iso';
    this.selectedLayer = 0;
    this.destroyViewer();
    await this.writeSettings();
    this.scheduleWebSiteEmbedding();
  }

  onMapPointerMove(event: MouseEvent): void {
    if (!this.viewer || !this.mapInfo) {
      return;
    }

    const canvasRect = (this.viewer.canvas ?? this.mapHost.nativeElement).getBoundingClientRect();
    const screenPoint = new OpenSeadragon.Point(
      event.clientX - canvasRect.left,
      event.clientY - canvasRect.top,
    );
    if (
      this.draggingEditorVertexIndex !== null &&
      this.editingPoiId !== null &&
      (this.editorMode === 'line' || this.editorMode === 'polygon')
    ) {
      const coordinate = this.screenToSquare(screenPoint);
      if (coordinate) {
        this.editorVertices = this.editorVertices.map((vertex, index) =>
          index === this.draggingEditorVertexIndex ? coordinate : vertex,
        );
        this.scheduleOverlayRender();
      }
      return;
    }
    this.updateHoveredStreet(screenPoint.x, screenPoint.y);
    const imagePoint = this.viewer.world
      .getItemAt(0)
      ?.viewportToImageCoordinates(
        this.viewer.viewport.pointFromPixel(screenPoint, true),
        true,
      );
    if (!imagePoint) {
      this.clearPoiHover();
      this.clearMapGraphicHover();
      this.hoverCard = null;
      return;
    }

    const [squareX, squareY] = this.imageToSquare(imagePoint.x, imagePoint.y);
    this.updatePoiHover(screenPoint.x, screenPoint.y);
    this.updateCustomGraphicHover(screenPoint.x, screenPoint.y);
    this.updateManualMarkerHover(screenPoint.x, screenPoint.y);
    this.updateHoveredArea(squareX, squareY);
    this.updateHoverCard(screenPoint.x, screenPoint.y, squareX, squareY);
    if (!this.toolSections.coordinates) {
      return;
    }

    const cellSize = this.mapInfo.cell_size ?? 256;
    this.mapCoordinates = [
      `x: ${Math.floor(squareX)}, y: ${Math.floor(squareY)}`,
      `cell: ${Math.floor(squareX / cellSize)}, ${Math.floor(squareY / cellSize)}`,
      `layer: ${this.selectedLayer}`,
    ].join('\n');
  }

  clearMapCoordinates(): void {
    this.mapCoordinates = '';
  }

  onMapPointerLeave(): void {
    this.draggingEditorVertexIndex = null;
    this.clearMapCoordinates();
    this.clearPoiHover();
    this.clearMapGraphicHover();
    this.hoverCard = null;
    if (this.hoveredStreetId !== null) {
      this.hoveredStreetId = null;
      this.scheduleOverlayRender();
    }
  }

  private updateHoverCard(
    screenX: number,
    screenY: number,
    squareX: number,
    squareY: number,
  ): void {
    const width = this.mapHost.nativeElement.clientWidth;
    const height = this.mapHost.nativeElement.clientHeight;
    const cardX = Math.min(Math.max(8, screenX + 12), Math.max(8, width - 280));
    const cardY = Math.min(Math.max(8, screenY + 12), Math.max(8, height - 96));
    const poiHit = this.findPoiAtScreen(screenX, screenY);
    if (poiHit) {
      if (poiHit.cluster.items.length > 1) {
        const names = poiHit.cluster.items.map((item) => item.name).join(' · ');
        this.hoverCard = {
          title: `${poiHit.cluster.items.length} points in this cluster`,
          category: 'Map marker cluster',
          detail: names,
          x: cardX,
          y: cardY,
        };
        return;
      }
      const poi = poiHit.cluster.items[0];
      if (poi) {
        this.hoverCard = {
          title: poi.name,
          category: poi.isSave
            ? 'Save'
            : poi.isCustom
              ? 'My POI'
              : (poi.category ?? 'Point of interest'),
          detail: poi.isSave
            ? [
              this.formatSaveDate(poi.savedAt),
              poi.savePath ? `Save: ${poi.savePath}` : '',
              `x: ${Math.floor(poi.x)}, y: ${Math.floor(poi.y)}`,
            ].filter(Boolean).join('\n')
            : poi.isCustom
            ? [poi.description, `x: ${Math.floor(poi.x)}, y: ${Math.floor(poi.y)}`]
              .filter(Boolean)
              .join('\n')
            : `Layer ${poi.layer ?? this.selectedLayer}`,
          x: cardX,
          y: cardY,
        };
        return;
      }
    }
    const customGraphic = this.hoveredCustomGraphicId
      ? this.customPois.find((graphic) => graphic.id === this.hoveredCustomGraphicId)
      : undefined;
    if (customGraphic) {
      const geometry = customGraphic.geometry ?? 'point';
      this.hoverCard = {
        title: customGraphic.label,
        category: geometry === 'line'
          ? 'My POI · Custom line'
          : geometry === 'polygon'
            ? 'My POI · Custom polygon'
            : 'My POI · Text label',
        detail: [customGraphic.description, `Layer ${customGraphic.layer}`]
          .filter(Boolean)
          .join('\n'),
        x: cardX,
        y: cardY,
      };
      return;
    }
    const street = this.hoveredStreetId
      ? this.streetData.find((item) => item.id === this.hoveredStreetId)
      : undefined;
    if (street) {
      this.hoverCard = {
        title: street.name || 'Unnamed street',
        category: 'Street',
        detail: `Layer ${street.layer ?? this.selectedLayer}`,
        x: cardX,
        y: cardY,
      };
      return;
    }

    for (const overlay of ['objects', 'rooms']) {
      if (!this.activeOverlayLayers.has(overlay)) {
        continue;
      }
      const hit = this.findOverlayAreaAtPoint(overlay, squareX, squareY);
      if (hit) {
        const area = hit.area;
        this.hoverCard = {
          title: area.name || (overlay === 'rooms' ? 'Unnamed room' : 'Unnamed object'),
          category: overlay === 'rooms' ? 'Room' : 'Object',
          detail: `${area.color ?? 'Unclassified'} · layer ${area.layer ?? this.selectedLayer}`,
          x: cardX,
          y: cardY,
        };
        return;
      }
    }
    const hoveredArea = this.getHoveredArea();
    if (hoveredArea) {
      this.hoverCard = {
        title: hoveredArea.area.name || 'Unnamed area',
        category: hoveredArea.overlay === 'rooms'
          ? 'Room'
          : hoveredArea.overlay === 'objects'
            ? 'Object'
            : 'Map area',
        detail: `${hoveredArea.area.color ?? 'Unclassified'} · layer ${hoveredArea.area.layer ?? this.selectedLayer}`,
        x: cardX,
        y: cardY,
      };
      return;
    }
    if (this.hoveredManualMarker && this.manualMarker) {
      this.hoverCard = {
        title: 'Selected coordinate',
        category: 'Map marker',
        detail: `x: ${Math.floor(this.manualMarker.x)}, y: ${Math.floor(this.manualMarker.y)}`,
        x: cardX,
        y: cardY,
      };
      return;
    }
    this.hoverCard = null;
  }

  private formatSaveDate(savedAt?: string | null): string {
    if (!savedAt) {
      return 'Save date unavailable';
    }
    const date = new Date(savedAt);
    if (!Number.isFinite(date.getTime())) {
      return 'Save date unavailable';
    }
    return `Saved ${new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)}`;
  }

  private updatePoiHover(screenX: number, screenY: number): void {
    const hit = this.findPoiAtScreen(screenX, screenY);
    const nextPoiId = hit?.cluster.items.length === 1 ? hit.cluster.items[0]?.id ?? null : null;
    const nextClusterKey = hit?.cluster.items.length && hit.cluster.items.length > 1
      ? hit.cluster.key
      : null;
    if (nextPoiId === this.hoveredPoiId && nextClusterKey === this.hoveredPoiClusterKey) {
      return;
    }
    this.hoveredPoiId = nextPoiId;
    this.hoveredPoiClusterKey = nextClusterKey;
    this.scheduleOverlayRender();
  }

  private clearPoiHover(): void {
    if (this.hoveredPoiId === null && this.hoveredPoiClusterKey === null) {
      return;
    }
    this.hoveredPoiId = null;
    this.hoveredPoiClusterKey = null;
    this.scheduleOverlayRender();
  }

  private clearMapGraphicHover(): void {
    let changed = false;
    if (this.hoveredAreaKey !== null) {
      this.hoveredAreaKey = null;
      changed = true;
    }
    if (this.hoveredManualMarker) {
      this.hoveredManualMarker = false;
      changed = true;
    }
    if (this.hoveredCustomGraphicId !== null) {
      this.hoveredCustomGraphicId = null;
      changed = true;
    }
    if (changed) {
      this.scheduleOverlayRender();
    }
  }

  private updateManualMarkerHover(screenX: number, screenY: number): void {
    const markerPoint = this.manualMarker
      ? this.squareToScreen(this.manualMarker.x, this.manualMarker.y)
      : null;
    const next = !!markerPoint && Math.hypot(markerPoint.x - screenX, markerPoint.y - screenY) <= 18;
    if (next !== this.hoveredManualMarker) {
      this.hoveredManualMarker = next;
      this.scheduleOverlayRender();
    }
  }

  private updateHoveredArea(squareX: number, squareY: number): void {
    let nextKey: string | null = null;
    if (
      this.hoveredPoiId === null &&
      this.hoveredPoiClusterKey === null &&
      this.hoveredStreetId === null &&
      this.hoveredCustomGraphicId === null
    ) {
      for (const overlay of ['objects', 'rooms']) {
        if (!this.activeOverlayLayers.has(overlay)) {
          continue;
        }
        const hit = this.findOverlayAreaAtPoint(overlay, squareX, squareY);
        if (hit) {
          nextKey = this.overlayAreaHoverKey(overlay, hit.area);
          break;
        }
      }
      if (!nextKey) {
        const area = this.findAreaNameAtPoint(squareX, squareY);
        if (area) {
          nextKey = this.areaNameHoverKey(area);
        }
      }
    }
    if (nextKey !== this.hoveredAreaKey) {
      this.hoveredAreaKey = nextKey;
      this.scheduleOverlayRender();
    }
  }

  private findAreaNameAtPoint(squareX: number, squareY: number): MapArea | null {
    for (const area of this.areaData) {
      if (
        !this.visibleAreaGroups.has(area.category ?? 'landmarks') ||
        !this.isOverlayLayerVisible(area.layer)
      ) {
        continue;
      }
      if (area.rects.some((rect) =>
        squareX >= rect.x &&
        squareX <= rect.x + rect.width &&
        squareY >= rect.y &&
        squareY <= rect.y + rect.height
      )) {
        return area;
      }
    }
    return null;
  }

  private overlayAreaHoverKey(overlay: string, area: MapArea): string {
    return `overlay:${overlay}:${area.id}`;
  }

  private areaNameHoverKey(area: MapArea): string {
    return `area:${area.id}`;
  }

  private getHoveredArea(): { overlay: string | null; area: MapArea } | null {
    if (!this.hoveredAreaKey) {
      return null;
    }
    if (this.hoveredAreaKey.startsWith('area:')) {
      const areaId = this.hoveredAreaKey.slice('area:'.length);
      const area = this.areaData.find((candidate) => candidate.id === areaId);
      return area ? { overlay: null, area } : null;
    }
    const [, overlay, areaId] = this.hoveredAreaKey.split(':');
    const area = overlay ? this.overlayAreaData.get(overlay)?.find((candidate) => candidate.id === areaId) : null;
    return area ? { overlay, area } : null;
  }

  private updateCustomGraphicHover(screenX: number, screenY: number): void {
    const hit = this.showAnnotations ? this.findCustomGraphicAtScreen(screenX, screenY) : null;
    const nextId = hit?.id ?? null;
    if (nextId !== this.hoveredCustomGraphicId) {
      this.hoveredCustomGraphicId = nextId;
      this.scheduleOverlayRender();
    }
  }

  private findCustomGraphicAtScreen(screenX: number, screenY: number): CustomMapPoi | null {
    if (!this.showAnnotations) {
      return null;
    }
    for (const graphic of this.customPois) {
      const geometry = graphic.geometry ?? 'point';
      if (geometry === 'point' || !this.isOverlayLayerVisible(graphic.layer)) {
        continue;
      }
      if (geometry === 'text') {
        const point = this.squareToScreen(graphic.x, graphic.y);
        if (!point) {
          continue;
        }
        const textSize = graphic.size === 'large' ? 22 : graphic.size === 'small' ? 12 : 16;
        const width = Math.max(24, graphic.label.length * textSize * 0.55);
        const height = textSize * 1.35;
        if (
          screenX >= point.x - width / 2 - 8 &&
          screenX <= point.x + width / 2 + 8 &&
          screenY >= point.y - height / 2 - 8 &&
          screenY <= point.y + height / 2 + 8
        ) {
          return graphic;
        }
        continue;
      }
      if (!graphic.vertices?.length) {
        continue;
      }
      const points = graphic.vertices
        .map((vertex) => this.squareToScreen(vertex.x, vertex.y))
        .filter((point): point is OpenSeadragon.Point => point !== null);
      if (geometry === 'polygon' && this.isPointInPolygon(screenX, screenY, points)) {
        return graphic;
      }
      for (let index = 1; index < points.length; index += 1) {
        if (this.distanceToSegment(screenX, screenY, points[index - 1], points[index]) <= 12) {
          return graphic;
        }
      }
      if (geometry === 'polygon' && points.length > 2 && this.distanceToSegment(
        screenX,
        screenY,
        points[points.length - 1],
        points[0],
      ) <= 12) {
        return graphic;
      }
    }
    return null;
  }

  private findEditableCustomPoiAtScreen(screenX: number, screenY: number): CustomMapPoi | null {
    const graphic = this.findCustomGraphicAtScreen(screenX, screenY);
    if (graphic) {
      return graphic;
    }
    const poiHit = this.findPoiAtScreen(screenX, screenY);
    if (!poiHit || poiHit.cluster.items.length !== 1) {
      return null;
    }
    const poi = poiHit.cluster.items[0];
    return poi?.isCustom
      ? this.customPois.find((candidate) => candidate.id === poi.id) ?? null
      : null;
  }

  private isPointInPolygon(x: number, y: number, points: OpenSeadragon.Point[]): boolean {
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      const current = points[index];
      const prior = points[previous];
      if (!current || !prior) {
        continue;
      }
      const intersects =
        (current.y > y) !== (prior.y > y) &&
        x < ((prior.x - current.x) * (y - current.y)) / (prior.y - current.y) + current.x;
      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }

  private findPoiAtScreen(screenX: number, screenY: number): { cluster: PoiRenderCluster } | null {
    for (const cluster of this.getPoiRenderClusters()) {
      const radius = cluster.items.length > 1
        ? Math.min(18, 7 + Math.log2(cluster.items.length) * 3) + 5
        : Math.max(...cluster.items.map((poi) => this.poiSizeInPixels(poi))) + 7;
      if (Math.hypot(cluster.x - screenX, cluster.y - screenY) <= radius) {
        return { cluster };
      }
    }
    return null;
  }

  private findOverlayAreaAtPoint(
    overlay: string,
    squareX: number,
    squareY: number,
  ): { area: MapArea; rect: MapArea['rects'][number] } | null {
    const bucketX = Math.floor(squareX / this.overlayAreaBucketSize);
    const bucketY = Math.floor(squareY / this.overlayAreaBucketSize);
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const candidates = this.overlayAreaIndex.get(
          this.overlayAreaBucketKey(overlay, bucketX + offsetX, bucketY + offsetY),
        );
        for (const candidate of candidates ?? []) {
          if (
            this.isOverlayLayerVisible(candidate.area.layer) &&
            squareX >= candidate.rect.x &&
            squareX <= candidate.rect.x + candidate.rect.width &&
            squareY >= candidate.rect.y &&
            squareY <= candidate.rect.y + candidate.rect.height
          ) {
            return candidate;
          }
        }
      }
    }
    return null;
  }

  private overlayAreaBucketKey(overlay: string, bucketX: number, bucketY: number): string {
    return `${overlay}:${bucketX}:${bucketY}`;
  }

  private updateHoveredStreet(screenX: number, screenY: number): void {
    if (!this.showStreets || !this.streetData.length) {
      if (this.hoveredStreetId !== null) {
        this.hoveredStreetId = null;
        this.scheduleOverlayRender();
      }
      return;
    }

    const zoom = this.viewer?.viewport.getZoom(true) ?? 0;
    let closestStreet: MapStreet | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const street of this.streetData) {
      if (
        street.layer !== undefined &&
        street.layer !== 0 &&
        street.layer !== this.selectedLayer
      ) {
        continue;
      }
      const visibleZoomLevel = street.visibleZoomLevel ?? 0;
      if (zoom < 0.25 + visibleZoomLevel * 0.3 || street.points.length < 2) {
        continue;
      }
      const screenPoints = street.points
        .map((point) => this.squareToScreen(point.x, point.y))
        .filter((point): point is OpenSeadragon.Point => point !== null);
      for (let index = 1; index < screenPoints.length; index += 1) {
        const start = screenPoints[index - 1];
        const end = screenPoints[index];
        if (!start || !end) {
          continue;
        }
        const distance = this.distanceToSegment(screenX, screenY, start, end);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestStreet = street;
        }
      }
    }

    const nextId = closestStreet && closestDistance <= 12
      ? closestStreet.id
      : null;
    if (nextId !== this.hoveredStreetId) {
      this.hoveredStreetId = nextId;
      this.scheduleOverlayRender();
    }
  }

  private distanceToSegment(
    x: number,
    y: number,
    start: OpenSeadragon.Point,
    end: OpenSeadragon.Point,
  ): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (dx === 0 && dy === 0) {
      return Math.hypot(x - start.x, y - start.y);
    }
    const t = Math.max(
      0,
      Math.min(1, ((x - start.x) * dx + (y - start.y) * dy) / (dx * dx + dy * dy)),
    );
    return Math.hypot(x - (start.x + t * dx), y - (start.y + t * dy));
  }

  private imageToSquare(imageX: number, imageY: number): [number, number] {
    return this.imageToSquareForView(imageX, imageY, this.mapView);
  }

  private imageToSquareForView(
    imageX: number,
    imageY: number,
    view: MapViewType,
  ): [number, number] {
    const x0 = this.mapInfo?.x0 ?? 0;
    const y0 = this.mapInfo?.y0 ?? 0;
    const squareSize = this.mapInfo?.sqr ?? 1;
    const x = (imageX - x0) / squareSize;
    const y = (imageY - y0) / squareSize;

    if (view === 'top') {
      return [x, y];
    }

    const layerOffset = 1.5 * this.selectedLayer;
    const sum = 4 * (y + layerOffset);
    const difference = 2 * x;
    return [(sum + difference) / 2, (sum - difference) / 2];
  }

  private captureViewportState(view: MapViewType | null): MapViewportState | null {
    const viewer = this.viewer;
    const item = viewer?.world.getItemAt(0);
    if (!viewer || !item || !this.mapInfo || !view) {
      return null;
    }
    const center = viewer.viewport.getCenter(true);
    const imagePoint = item.viewportToImageCoordinates(center, true);
    const [squareX, squareY] = this.imageToSquareForView(imagePoint.x, imagePoint.y, view);
    return {
      squareX,
      squareY,
      zoom: viewer.viewport.getZoom(true),
    };
  }

  private restoreViewportState(viewer: OpenSeadragon.Viewer, state: MapViewportState): void {
    const item = viewer.world.getItemAt(0);
    const imagePoint = this.squareToImageForView(state.squareX, state.squareY, this.mapView);
    if (!item || !imagePoint) {
      return;
    }
    const viewportPoint = item.imageToViewportCoordinates(imagePoint.x, imagePoint.y);
    const zoom = Math.min(
      viewer.viewport.getMaxZoom(),
      Math.max(viewer.viewport.getMinZoom(), state.zoom),
    );
    viewer.viewport.panTo(viewportPoint, true);
    viewer.viewport.zoomTo(zoom, viewportPoint, true);
  }

  private constrainZoomToAvailableTiles(viewer: OpenSeadragon.Viewer): void {
    const ratios: number[] = [];
    for (let index = 0; index < viewer.world.getItemCount(); index += 1) {
      const source = viewer.world.getItemAt(index)?.source;
      if (!source || !Number.isFinite(source.maxLevel)) {
        continue;
      }
      const levelScale = source.getLevelScale(source.maxLevel);
      if (Number.isFinite(levelScale) && levelScale > 0) {
        ratios.push(levelScale);
      }
    }
    if (!ratios.length) {
      return;
    }

    // A DZI's max level is the highest resolution for which tiles exist.
    // Limiting the viewport to that level prevents OpenSeadragon from
    // magnifying the last available tile into a blurry image.
    viewer.viewport.setMaxZoomPixelRatio(Math.min(...ratios), true, true);
  }

  private scheduleOverlayRender(): void {
    if (this.overlayFrame !== null) {
      return;
    }
    this.overlayFrame = window.requestAnimationFrame(() => {
      this.overlayFrame = null;
      this.renderMapOverlays();
    });
  }

  private renderMapOverlays(): void {
    const canvas = this.mapOverlayCanvas.nativeElement;
    const host = this.mapHost.nativeElement;
    const renderSurface = this.viewer?.canvas ?? host;
    const width = renderSurface.clientWidth || host.clientWidth;
    const height = renderSurface.clientHeight || host.clientHeight;
    if (!width || !height) {
      return;
    }

    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);

    if (!this.viewer || !this.mapInfo) {
      return;
    }

    if (this.zombieHeatmapData && this.isOverlayActive('zombie')) {
      this.drawZombieHeatmap(context);
    }

    if (this.visibleAreaGroups.size > 0 && this.areaData.length > 0) {
      this.drawAreaNames(context);
    }

    for (const overlay of ['rooms', 'objects']) {
      if (this.activeOverlayLayers.has(overlay)) {
        this.drawAreaOverlay(context, overlay);
      }
    }

    if (this.showStreets && this.streetData.length > 0) {
      this.drawStreets(context);
    }

    if (this.showAnnotations || this.editorMode) {
      this.drawCustomGraphics(context);
    }

    if (
      (this.showPoi && this.poiData.length > 0) ||
      (this.showAnnotations && this.customPois.length > 0) ||
      (this.showSaves && this.saveData.length > 0)
    ) {
      this.drawPoi(context);
    }

    if (this.manualMarker) {
      this.drawCoordinateMarker(context, this.manualMarker.x, this.manualMarker.y);
    }
    if (this.isHoverPulseActive()) {
      this.ensureHoverPulseAnimation();
    } else {
      this.stopHoverPulseAnimation();
    }
  }

  private isHoverPulseActive(): boolean {
    return (
      this.hoveredPoiId !== null ||
      this.hoveredPoiClusterKey !== null ||
      this.hoveredStreetId !== null ||
      this.hoveredAreaKey !== null ||
      this.hoveredCustomGraphicId !== null ||
      this.hoveredManualMarker
    );
  }

  private ensureHoverPulseAnimation(): void {
    if (this.hoverPulseFrame !== null) {
      return;
    }
    const tick = (timestamp: number): void => {
      this.hoverPulsePhase = (timestamp % 1000) / 1000;
      this.renderMapOverlays();
      if (this.isHoverPulseActive()) {
        this.hoverPulseFrame = window.requestAnimationFrame(tick);
      } else {
        this.hoverPulseFrame = null;
        this.hoverPulsePhase = 0;
      }
    };
    this.hoverPulseFrame = window.requestAnimationFrame(tick);
  }

  private stopHoverPulseAnimation(): void {
    if (this.hoverPulseFrame !== null) {
      window.cancelAnimationFrame(this.hoverPulseFrame);
      this.hoverPulseFrame = null;
    }
    this.hoverPulsePhase = 0;
  }

  private drawGridLines(
    context: CanvasRenderingContext2D,
    spacing: number,
    color: string,
    lineWidth: number,
  ): void {
    const item = this.viewer?.world.getItemAt(0);
    if (!item || !this.mapInfo || spacing <= 0) {
      return;
    }

    const bounds = this.viewer?.viewport.getBounds(true);
    if (!bounds) {
      return;
    }
    // An isometric viewport's image bounds are a diamond. Using only its
    // top-left and bottom-right corners produces the top-down grid extents;
    // project all four corners back into square space instead.
    const viewportCorners = [
      new OpenSeadragon.Point(bounds.x, bounds.y),
      new OpenSeadragon.Point(bounds.x + bounds.width, bounds.y),
      new OpenSeadragon.Point(bounds.x + bounds.width, bounds.y + bounds.height),
      new OpenSeadragon.Point(bounds.x, bounds.y + bounds.height),
    ];
    const squareCorners = viewportCorners.map((corner) => {
      const imagePoint = item.viewportToImageCoordinates(corner, true);
      return this.imageToSquare(imagePoint.x, imagePoint.y);
    });
    const minSquareX = Math.min(...squareCorners.map(([x]) => x));
    const maxSquareX = Math.max(...squareCorners.map(([x]) => x));
    const minSquareY = Math.min(...squareCorners.map(([, y]) => y));
    const maxSquareY = Math.max(...squareCorners.map(([, y]) => y));
    const minX = Math.floor(minSquareX / spacing) * spacing;
    const maxX = Math.ceil(maxSquareX / spacing) * spacing;
    const minY = Math.floor(minSquareY / spacing) * spacing;
    const maxY = Math.ceil(maxSquareY / spacing) * spacing;
    const lineCount = (maxX - minX) / spacing + (maxY - minY) / spacing;
    if (lineCount > 600) {
      return;
    }

    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.beginPath();
    for (let x = minX; x <= maxX; x += spacing) {
      this.drawMappedLine(context, x, minY, x, maxY);
    }
    for (let y = minY; y <= maxY; y += spacing) {
      this.drawMappedLine(context, minX, y, maxX, y);
    }
    context.stroke();
  }

  private drawMappedLine(
    context: CanvasRenderingContext2D,
    squareX1: number,
    squareY1: number,
    squareX2: number,
    squareY2: number,
  ): void {
    const first = this.squareToScreen(squareX1, squareY1);
    const second = this.squareToScreen(squareX2, squareY2);
    if (!first || !second) {
      return;
    }
    context.moveTo(first.x, first.y);
    context.lineTo(second.x, second.y);
  }

  private squareToImage(squareX: number, squareY: number): OpenSeadragon.Point | null {
    return this.squareToImageForView(squareX, squareY, this.mapView);
  }

  private squareToImageForView(
    squareX: number,
    squareY: number,
    view: MapViewType,
  ): OpenSeadragon.Point | null {
    if (!this.mapInfo) {
      return null;
    }
    const squareSize = this.mapInfo.sqr ?? 1;
    const x0 = this.mapInfo.x0 ?? 0;
    const y0 = this.mapInfo.y0 ?? 0;
    return view === 'top'
      ? new OpenSeadragon.Point(x0 + squareX * squareSize, y0 + squareY * squareSize)
      : new OpenSeadragon.Point(
        x0 + (squareX - squareY) * squareSize / 2,
        y0 + (squareX + squareY) * squareSize / 4 - 1.5 * this.selectedLayer * squareSize,
      );
  }

  private squareToScreen(squareX: number, squareY: number): OpenSeadragon.Point | null {
    const item = this.viewer?.world.getItemAt(0);
    const imagePoint = this.squareToImage(squareX, squareY);
    if (!item || !imagePoint) {
      return null;
    }
    const viewportPoint = item.imageToViewportCoordinates(imagePoint.x, imagePoint.y);
    return this.viewer?.viewport.pixelFromPoint(viewportPoint, true) ?? null;
  }

  private drawPoi(context: CanvasRenderingContext2D): void {
    context.font = '12px Noto Sans, sans-serif';
    context.textBaseline = 'bottom';
    const zoom = this.viewer?.viewport.getZoom(true) ?? 0;
    for (const cluster of this.getPoiRenderClusters()) {
      const point = { x: cluster.x, y: cluster.y };
      if (cluster.items.length > 1) {
        const radius = Math.min(18, 7 + Math.log2(cluster.items.length) * 3);
        context.fillStyle = 'rgba(56, 189, 248, 0.86)';
        context.strokeStyle = '#082f49';
        context.lineWidth = 2;
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        if (this.hoveredPoiClusterKey === cluster.key) {
          this.drawHoverPulse(context, point.x, point.y, radius);
        }
        context.fillStyle = '#ffffff';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(String(cluster.items.length), point.x, point.y);
        continue;
      }

      const poi = cluster.items[0];
      if (!poi) {
        continue;
      }
      const radius = this.poiSizeInPixels(poi);
      this.drawPoiShape(context, point.x, point.y, radius, poi);
      if (this.hoveredPoiId === poi.id) {
        this.drawHoverPulse(context, point.x, point.y, radius);
      }
      if ((poi.isCustom || poi.isSave) && poi.icon) {
        context.fillStyle = '#ffffff';
        context.font = `700 ${Math.max(9, radius + 2)}px Noto Sans, sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(poi.icon, point.x, point.y - (poi.shape === 'pin' ? radius * 0.35 : 0));
      }
      if (zoom > 0.3 || poi.isCustom || poi.isSave) {
        context.font = '12px Noto Sans, sans-serif';
        context.textBaseline = 'bottom';
        context.textAlign = 'start';
        context.fillStyle = '#ffffff';
        context.lineWidth = 3;
        context.strokeStyle = 'rgba(0, 0, 0, 0.85)';
        context.strokeText(poi.name, point.x + radius + 5, point.y - radius - 2);
        context.fillText(poi.name, point.x + radius + 5, point.y - radius - 2);
      }
    }
    context.textAlign = 'start';
  }

  private drawCustomGraphics(context: CanvasRenderingContext2D): void {
    if (this.showAnnotations) {
      for (const graphic of this.customPois) {
        const geometry = graphic.geometry ?? 'point';
        if (
          geometry === 'point' ||
          graphic.id === this.editingPoiId ||
          !this.isOverlayLayerVisible(graphic.layer) ||
          (geometry !== 'text' && !graphic.vertices?.length)
        ) {
          continue;
        }
        if (geometry === 'text') {
          this.drawCustomText(context, graphic, false);
          continue;
        }
        if (!graphic.vertices?.length) {
          continue;
        }
        this.drawCustomGeometry(context, geometry, graphic.vertices, graphic, false);
      }
    }

    if (this.editorGeometry && this.editorVertices.length > 0) {
      this.drawCustomGeometry(
        context,
        this.editorGeometry,
        this.editorVertices,
        {
          id: this.editingPoiId ?? 'editor-preview',
          label: this.poiDraft.label.trim() || (this.editorGeometry === 'line' ? 'New line' : 'New polygon'),
          description: this.poiDraft.description,
          x: this.editorVertices[0]?.x ?? 0,
          y: this.editorVertices[0]?.y ?? 0,
          layer: this.selectedLayer,
          icon: '●',
          shape: 'circle',
          color: this.poiDraft.color,
          size: this.poiDraft.size,
          strokeWidth: this.normalizeStrokeWidth(this.poiDraft.strokeWidth),
          linePattern: this.normalizeLinePattern(this.poiDraft.linePattern),
          geometry: this.editorGeometry,
          vertices: this.editorVertices,
        },
        true,
      );
      context.save();
      context.fillStyle = '#fef08a';
      context.strokeStyle = '#111827';
      context.lineWidth = 2;
      for (const vertex of this.editorVertices) {
        const point = this.squareToScreen(vertex.x, vertex.y);
        if (!point) {
          continue;
        }
        context.beginPath();
        context.arc(point.x, point.y, 5, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      }
      context.restore();
    }

    if (
      this.pendingPoiCoordinate &&
      (this.editorMode === 'point' || this.editorMode === 'shape' || this.editorMode === 'text')
    ) {
      const isText = this.editorMode === 'text';
      const preview: CustomMapPoi = {
        id: 'editor-preview',
        tool: this.editorMode,
        label: this.poiDraft.label.trim() || (isText ? 'New text' : this.editorMode === 'shape' ? 'New shape' : 'New point'),
        description: this.poiDraft.description,
        x: this.pendingPoiCoordinate.squareX,
        y: this.pendingPoiCoordinate.squareY,
        layer: this.selectedLayer,
        icon: this.poiDraft.icon,
        shape: this.poiDraft.shape,
        color: this.poiDraft.color,
        size: this.poiDraft.size,
        strokeWidth: this.normalizeStrokeWidth(this.poiDraft.strokeWidth),
        linePattern: this.normalizeLinePattern(this.poiDraft.linePattern),
        geometry: isText ? 'text' : 'point',
      };
      if (isText) {
        this.drawCustomText(context, preview, true);
      } else {
        const point = this.squareToScreen(preview.x, preview.y);
        if (point) {
          const mapPoi: MapPoi = {
            id: preview.id,
            name: preview.label,
            x: preview.x,
            y: preview.y,
            layer: preview.layer,
            color: preview.color,
            icon: preview.icon,
            shape: preview.shape,
            size: preview.size,
            isCustom: true,
          };
          const radius = this.poiSizeInPixels(mapPoi);
          this.drawPoiShape(context, point.x, point.y, radius, mapPoi);
          context.fillStyle = '#ffffff';
          context.font = `700 ${Math.max(9, radius + 2)}px Noto Sans, sans-serif`;
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.fillText(preview.icon, point.x, point.y - (preview.shape === 'pin' ? radius * 0.35 : 0));
          context.font = '12px Noto Sans, sans-serif';
          context.textBaseline = 'bottom';
          context.textAlign = 'start';
          context.fillStyle = '#ffffff';
          context.lineWidth = 3;
          context.strokeStyle = 'rgba(0, 0, 0, 0.85)';
          context.strokeText(preview.label, point.x + radius + 5, point.y - radius - 2);
          context.fillText(preview.label, point.x + radius + 5, point.y - radius - 2);
        }
      }
    }
  }

  private drawCustomGeometry(
    context: CanvasRenderingContext2D,
    geometry: Exclude<CustomGeometry, 'point' | 'text'>,
    vertices: MapCoordinate[],
    graphic: CustomMapPoi,
    preview: boolean,
  ): void {
    const screenVertices = vertices
      .map((vertex) => this.squareToScreen(vertex.x, vertex.y))
      .filter((point): point is OpenSeadragon.Point => point !== null);
    if (screenVertices.length < (geometry === 'polygon' ? 3 : 2)) {
      return;
    }
    const isHovered = !preview && this.hoveredCustomGraphicId === graphic.id;
    const lineWidth = graphic.strokeWidth ?? (graphic.size === 'large' ? 5 : graphic.size === 'small' ? 2 : 3);
    context.save();
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.setLineDash(this.lineDashForPattern(graphic.linePattern));
    context.beginPath();
    context.moveTo(screenVertices[0].x, screenVertices[0].y);
    for (const point of screenVertices.slice(1)) {
      context.lineTo(point.x, point.y);
    }
    if (geometry === 'polygon') {
      context.closePath();
      context.globalAlpha = preview ? 0.14 : 0.2;
      context.fillStyle = graphic.color;
      context.fill();
      context.globalAlpha = 1;
    }
    context.strokeStyle = graphic.color;
    context.lineWidth = lineWidth;
    context.stroke();
    if (isHovered) {
      context.setLineDash([]);
      context.strokeStyle = `rgba(254, 240, 138, ${Math.max(0.12, 0.72 * (1 - this.hoverPulsePhase))})`;
      context.lineWidth = lineWidth + 6 + this.hoverPulsePhase * 8;
      context.stroke();
    }

    const center = screenVertices.reduce(
      (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
      { x: 0, y: 0 },
    );
    center.x /= screenVertices.length;
    center.y /= screenVertices.length;
    context.setLineDash([]);
    context.font = '600 12px Noto Sans, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineWidth = 3;
    context.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    context.strokeText(graphic.label, center.x, center.y);
    context.fillStyle = '#ffffff';
    context.fillText(graphic.label, center.x, center.y);
    context.restore();
  }

  private drawCustomText(
    context: CanvasRenderingContext2D,
    graphic: CustomMapPoi,
    preview: boolean,
  ): void {
    const point = this.squareToScreen(graphic.x, graphic.y);
    if (!point || !graphic.label) {
      return;
    }
    const fontSize = graphic.size === 'large' ? 22 : graphic.size === 'small' ? 12 : 16;
    context.save();
    context.font = `700 ${fontSize}px Noto Sans, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const textWidth = context.measureText(graphic.label).width;
    const paddingX = 7;
    const paddingY = 4;
    context.lineWidth = 4;
    context.strokeStyle = 'rgba(0, 0, 0, 0.86)';
    context.strokeText(graphic.label, point.x, point.y);
    context.fillStyle = graphic.color;
    context.fillText(graphic.label, point.x, point.y);
    if (!preview && this.hoveredCustomGraphicId === graphic.id) {
      const pulse = this.hoverPulsePhase;
      context.strokeStyle = `rgba(254, 240, 138, ${Math.max(0.12, 0.72 * (1 - pulse))})`;
      context.lineWidth = 2 + pulse * 4;
      context.strokeRect(
        point.x - textWidth / 2 - paddingX - pulse * 5,
        point.y - fontSize / 2 - paddingY - pulse * 5,
        textWidth + paddingX * 2 + pulse * 10,
        fontSize + paddingY * 2 + pulse * 10,
      );
    }
    context.restore();
  }

  private drawHoverPulse(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
  ): void {
    const progress = this.hoverPulsePhase;
    context.save();
    context.strokeStyle = `rgba(254, 240, 138, ${Math.max(0.12, 0.78 * (1 - progress))})`;
    context.lineWidth = 2.5;
    context.beginPath();
    context.arc(x, y, radius + 4 + progress * 12, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  private getVisiblePoiPoints(): MapPoi[] {
    const points = this.showPoi
      ? this.poiData.filter(
        (poi) => this.visibleMarkerGroups.has(poi.category ?? 'pois') && this.isOverlayLayerVisible(poi.layer),
      )
      : [];
    if (this.showAnnotations) {
      points.push(
        ...this.customPois
          .filter((poi) => (poi.geometry ?? 'point') === 'point')
          .filter((poi) => this.isOverlayLayerVisible(poi.layer))
          .map((poi) => ({
            id: poi.id,
            name: poi.label,
            x: poi.x,
            y: poi.y,
            layer: poi.layer,
            color: poi.color,
            category: 'my-poi',
            description: poi.description,
            icon: poi.icon,
            shape: poi.shape,
            size: poi.size,
            isCustom: true,
          })),
      );
    }
    if (this.showSaves) {
      points.push(
        ...this.saveData
          .filter((marker) => Number.isFinite(marker.x) && Number.isFinite(marker.y))
          .map((marker) => ({
            id: marker.id,
            name: marker.name,
            x: marker.x,
            y: marker.y,
            color: '#fb7185',
            category: 'saves',
            icon: '●',
            shape: 'circle' as const,
            size: 'medium' as const,
            isSave: true,
            savedAt: marker.savedAt,
            savePath: marker.relativePath,
          })),
      );
    }
    return points;
  }

  private getPoiRenderClusters(): PoiRenderCluster[] {
    const zoom = this.viewer?.viewport.getZoom(true) ?? 0;
    const broadClusterRadius = zoom < 0.7 ? 36 : zoom < 1.5 ? 24 : 0;
    const clusters: PoiRenderCluster[] = [];
    const width = this.mapHost.nativeElement.clientWidth;
    const height = this.mapHost.nativeElement.clientHeight;

    for (const poi of this.getVisiblePoiPoints()) {
      const point = this.squareToScreen(poi.x, poi.y);
      if (
        !point ||
        point.x < -24 ||
        point.y < -24 ||
        point.x > width + 24 ||
        point.y > height + 24
      ) {
        continue;
      }
      const poiRadius = this.poiSizeInPixels(poi);
      const cluster = clusters.find((candidate) => {
        const candidateRadius = Math.max(
          ...candidate.items.map((item) => this.poiSizeInPixels(item)),
        );
        const overlapRadius = candidateRadius + poiRadius + 4;
        return Math.hypot(candidate.x - point.x, candidate.y - point.y)
          <= Math.max(broadClusterRadius, overlapRadius);
      });
      if (cluster) {
        cluster.items.push(poi);
        cluster.x = (cluster.x * (cluster.items.length - 1) + point.x) / cluster.items.length;
        cluster.y = (cluster.y * (cluster.items.length - 1) + point.y) / cluster.items.length;
        cluster.key = cluster.items.map((item) => item.id).sort().join('|');
      } else {
        clusters.push({ x: point.x, y: point.y, items: [poi], key: poi.id });
      }
    }
    return clusters;
  }

  private poiSizeInPixels(poi: MapPoi): number {
    if (!poi.isCustom && !poi.isSave) {
      return 5;
    }
    return poi.size === 'large' ? 13 : poi.size === 'small' ? 7 : 10;
  }

  private drawPoiShape(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    poi: MapPoi,
  ): void {
    context.fillStyle = poi.color ?? '#ffd166';
    context.strokeStyle = '#141414';
    context.lineWidth = 2;
    context.beginPath();
    switch (poi.shape ?? 'circle') {
      case 'square':
        context.rect(x - radius, y - radius, radius * 2, radius * 2);
        break;
      case 'diamond':
        context.moveTo(x, y - radius);
        context.lineTo(x + radius, y);
        context.lineTo(x, y + radius);
        context.lineTo(x - radius, y);
        context.closePath();
        break;
      case 'triangle':
        context.moveTo(x, y - radius);
        context.lineTo(x + radius, y + radius);
        context.lineTo(x - radius, y + radius);
        context.closePath();
        break;
      case 'star':
        for (let index = 0; index < 10; index += 1) {
          const angle = -Math.PI / 2 + index * Math.PI / 5;
          const pointRadius = index % 2 === 0 ? radius : radius * 0.45;
          const pointX = x + Math.cos(angle) * pointRadius;
          const pointY = y + Math.sin(angle) * pointRadius;
          if (index === 0) {
            context.moveTo(pointX, pointY);
          } else {
            context.lineTo(pointX, pointY);
          }
        }
        context.closePath();
        break;
      case 'pin':
        context.moveTo(x, y + radius * 1.35);
        context.bezierCurveTo(x - radius * 1.45, y - radius * 0.25, x - radius, y - radius, x, y - radius);
        context.bezierCurveTo(x + radius, y - radius, x + radius * 1.45, y - radius * 0.25, x, y + radius * 1.35);
        break;
      case 'arrow':
        context.moveTo(x, y - radius * 1.45);
        context.lineTo(x + radius * 0.85, y - radius * 0.35);
        context.lineTo(x + radius * 0.3, y - radius * 0.35);
        context.lineTo(x + radius * 0.3, y + radius * 1.25);
        context.lineTo(x - radius * 0.3, y + radius * 1.25);
        context.lineTo(x - radius * 0.3, y - radius * 0.35);
        context.lineTo(x - radius * 0.85, y - radius * 0.35);
        context.closePath();
        break;
      default:
        context.arc(x, y, radius, 0, Math.PI * 2);
        break;
    }
    context.fill();
    context.stroke();
  }

  private drawZombieHeatmap(context: CanvasRenderingContext2D): void {
    const data = this.zombieHeatmapData;
    if (!data) {
      return;
    }

    const width = this.mapHost.nativeElement.clientWidth;
    const height = this.mapHost.nativeElement.clientHeight;
    const valuesPerCell = data.cellSizeInBlock * data.cellSizeInBlock;
    const squareStep = data.cellSize / data.cellSizeInBlock;
    context.save();
    context.globalCompositeOperation = 'lighter';
    for (const cell of data.cells) {
      const cellOffset = cell.index * valuesPerCell;
      for (let row = 0; row < data.cellSizeInBlock; row += 1) {
        for (let column = 0; column < data.cellSizeInBlock; column += 1) {
          const value = data.values[cellOffset + row * data.cellSizeInBlock + column] ?? 0;
          if (value === 0) {
            continue;
          }
          const squareX = cell.x * data.cellSize + (column + 0.5) * squareStep;
          const squareY = cell.y * data.cellSize + (row + 0.5) * squareStep;
          const point = this.squareToScreen(squareX, squareY);
          if (!point || point.x < -32 || point.y < -32 || point.x > width + 32 || point.y > height + 32) {
            continue;
          }
          const edge = this.squareToScreen(squareX + squareStep, squareY);
          const radius = edge
            ? Math.max(2, Math.abs(edge.x - point.x) * 1.8)
            : 4;
          const intensity = Math.pow(value / 255, 0.4);
          context.globalAlpha = Math.min(0.72, intensity * 0.5);
          context.fillStyle = this.zombieHeatmapColor(value);
          context.beginPath();
          context.arc(point.x, point.y, radius, 0, Math.PI * 2);
          context.fill();
        }
      }
    }
    context.restore();
  }

  private zombieHeatmapColor(value: number): string {
    const stops: Array<[number, [number, number, number]]> = [
      [0, [0, 0, 255]],
      [0.5, [255, 255, 0]],
      [1, [255, 0, 0]],
    ];
    const normalized = value / 255;
    const upper = stops.find(([threshold]) => normalized <= threshold) ?? stops[stops.length - 1];
    const upperIndex = stops.indexOf(upper);
    const lower = stops[Math.max(0, upperIndex - 1)] ?? upper;
    const range = upper[0] - lower[0] || 1;
    const ratio = Math.max(0, Math.min(1, (normalized - lower[0]) / range));
    const channels = upper[1].map(
      (channel, index) => Math.round(lower[1][index] + (channel - lower[1][index]) * ratio),
    );
    return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
  }

  private drawAreaOverlay(
    context: CanvasRenderingContext2D,
    overlay: string,
  ): void {
    const areas = this.overlayAreaData.get(overlay);
    if (!areas?.length) {
      return;
    }

    const width = this.mapHost.nativeElement.clientWidth;
    const height = this.mapHost.nativeElement.clientHeight;
    const zoom = this.viewer?.viewport.getZoom(true) ?? 0;
    const fillOpacity = overlay === 'rooms' ? 0.2 : 0.3;
    context.save();
    context.globalAlpha = fillOpacity;
    context.lineJoin = 'round';
    for (const area of areas) {
      if (!this.isOverlayLayerVisible(area.layer)) {
        continue;
      }
      for (const rect of area.rects) {
        const points = [
          this.squareToScreen(rect.x, rect.y),
          this.squareToScreen(rect.x + rect.width, rect.y),
          this.squareToScreen(rect.x + rect.width, rect.y + rect.height),
          this.squareToScreen(rect.x, rect.y + rect.height),
        ];
        if (points.some((point) => !point)) {
          continue;
        }
        const screenPoints = points as OpenSeadragon.Point[];
        const minX = Math.min(...screenPoints.map((point) => point.x));
        const maxX = Math.max(...screenPoints.map((point) => point.x));
        const minY = Math.min(...screenPoints.map((point) => point.y));
        const maxY = Math.max(...screenPoints.map((point) => point.y));
        if (maxX < 0 || minX > width || maxY < 0 || minY > height) {
          continue;
        }
        context.fillStyle = area.color ?? (overlay === 'rooms' ? 'orange' : '#38bdf8');
        context.beginPath();
        context.moveTo(screenPoints[0].x, screenPoints[0].y);
        for (const point of screenPoints.slice(1)) {
          context.lineTo(point.x, point.y);
        }
        context.closePath();
        context.fill();
        const isHovered = this.hoveredAreaKey === this.overlayAreaHoverKey(overlay, area);
        if (zoom >= 0.8) {
          context.globalAlpha = Math.min(0.8, fillOpacity + 0.25);
          context.strokeStyle = overlay === 'rooms'
            ? 'rgba(251, 146, 60, 0.95)'
            : 'rgba(96, 165, 250, 0.95)';
          context.lineWidth = overlay === 'rooms' ? 1 : 1.5;
          context.stroke();
          context.globalAlpha = fillOpacity;
        }
        if (isHovered) {
          context.save();
          context.globalAlpha = Math.max(0.12, 0.78 * (1 - this.hoverPulsePhase));
          context.strokeStyle = '#fef08a';
          context.lineWidth = 2 + this.hoverPulsePhase * 5;
          context.stroke();
          context.restore();
        }
      }
    }
    context.restore();
  }

  private drawAreaNames(context: CanvasRenderingContext2D): void {
    context.font = '600 14px Noto Sans, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const area of this.areaData) {
      if (!this.visibleAreaGroups.has(area.category ?? 'landmarks')) {
        continue;
      }
      if (!this.isOverlayLayerVisible(area.layer)) {
        continue;
      }
      const first = area.rects[0];
      if (!first) {
        continue;
      }
      const center = area.rects.reduce(
        (sum, rect) => ({
          x: sum.x + rect.x + rect.width / 2,
          y: sum.y + rect.y + rect.height / 2,
        }),
        { x: 0, y: 0 },
      );
      const point = this.squareToScreen(
        center.x / area.rects.length,
        center.y / area.rects.length,
      );
      if (!point) {
        continue;
      }
      const width = Math.max(4, Math.min(24, first.width / 100));
      const height = Math.max(4, Math.min(24, first.height / 100));
      const isHovered = this.hoveredAreaKey === this.areaNameHoverKey(area);
      context.fillStyle = area.color ?? 'rgba(255, 255, 255, 0.9)';
      context.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      context.lineWidth = 3;
      context.strokeText(area.name, point.x, point.y);
      context.fillText(area.name, point.x, point.y);
      // Give small areas a subtle boundary so a town/region remains findable
      // when its label is above a detailed tile.
      if (width > 8 && height > 8) {
        context.strokeStyle = area.color ?? 'rgba(255, 255, 255, 0.3)';
        context.lineWidth = 1;
        context.strokeRect(point.x - width / 2, point.y - height / 2, width, height);
      }
      if (isHovered) {
        context.save();
        context.globalAlpha = Math.max(0.12, 0.78 * (1 - this.hoverPulsePhase));
        context.strokeStyle = '#fef08a';
        context.lineWidth = 2 + this.hoverPulsePhase * 5;
        context.strokeRect(point.x - width / 2, point.y - height / 2, width, height);
        context.restore();
      }
    }
    context.textAlign = 'start';
  }

  private drawCoordinateMarker(
    context: CanvasRenderingContext2D,
    squareX: number,
    squareY: number,
  ): void {
    const point = this.squareToScreen(squareX, squareY);
    if (!point) {
      return;
    }
    context.save();
    context.fillStyle = '#38bdf8';
    context.strokeStyle = '#082f49';
    context.lineWidth = 3;
    context.beginPath();
    context.arc(point.x, point.y, 8, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    if (this.hoveredManualMarker) {
      this.drawHoverPulse(context, point.x, point.y, 8);
    }
    context.beginPath();
    context.moveTo(point.x - 14, point.y);
    context.lineTo(point.x + 14, point.y);
    context.moveTo(point.x, point.y - 14);
    context.lineTo(point.x, point.y + 14);
    context.stroke();
    context.restore();
  }

  private drawStreets(context: CanvasRenderingContext2D): void {
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const zoom = this.viewer?.viewport.getZoom(true) ?? 0;
    for (const street of this.streetData) {
      if (
        street.layer !== undefined &&
        street.layer !== 0 &&
        street.layer !== this.selectedLayer
      ) {
        continue;
      }
      const visibleZoomLevel = street.visibleZoomLevel ?? 0;
      if (zoom < 0.25 + visibleZoomLevel * 0.3) {
        continue;
      }
      if (street.points.length < 2) {
        continue;
      }
      const isHovered = street.id === this.hoveredStreetId;
      context.beginPath();
      let visible = false;
      for (const [index, point] of street.points.entries()) {
        const screenPoint = this.squareToScreen(point.x, point.y);
        if (!screenPoint) {
          continue;
        }
        visible = true;
        if (index === 0) {
          context.moveTo(screenPoint.x, screenPoint.y);
        } else {
          context.lineTo(screenPoint.x, screenPoint.y);
        }
      }
      if (!visible) {
        continue;
      }
      const isGroundLayer = this.selectedLayer === 0;
      const streetWidth = Math.max(2, Math.min(8, street.width ?? 3));
      if (isHovered) {
        context.save();
        context.strokeStyle = `rgba(254, 240, 138, ${Math.max(0.12, 0.62 * (1 - this.hoverPulsePhase))})`;
        context.lineWidth = streetWidth + 8 + this.hoverPulsePhase * 12;
        context.stroke();
        context.restore();
      }
      // Streets use a dark casing plus a bright inner stroke. This keeps the
      // network readable over the ground imagery and avoids the low-alpha
      // source colors disappearing into dark WebP tiles.
      context.strokeStyle = 'rgba(15, 23, 42, 0.96)';
      context.lineWidth = streetWidth + (isHovered ? 9 : isGroundLayer ? 4 : 3);
      context.stroke();
      context.strokeStyle = isHovered
        ? '#f8fafc'
        : isGroundLayer
        ? '#facc15'
        : street.color ?? '#38bdf8';
      context.lineWidth = streetWidth + (isHovered ? 4 : isGroundLayer ? 1 : 0);
      context.stroke();
      if ((zoom >= 0.9 + visibleZoomLevel * 0.25 || isHovered) && street.name) {
        const midpoint = street.points[Math.floor(street.points.length / 2)];
        const labelPoint = midpoint ? this.squareToScreen(midpoint.x, midpoint.y) : null;
        if (labelPoint) {
          context.font = '600 11px Noto Sans, sans-serif';
          context.textAlign = 'center';
          context.textBaseline = 'middle';
          context.lineWidth = 3;
          context.strokeStyle = 'rgba(0, 0, 0, 0.82)';
          context.strokeText(street.name, labelPoint.x, labelPoint.y);
          context.fillStyle = street.textColor ?? (isGroundLayer ? '#fff7ed' : '#ffffff');
          context.fillText(street.name, labelPoint.x, labelPoint.y);
        }
      }
    }
    context.textAlign = 'start';
  }

  private async loadPoiData(): Promise<void> {
    this.poiLoading = true;
    this.poiError = '';
    try {
      const candidates = [
        `${this.getMapRoot()}/marks.json`,
        'marks.json',
        '../pzmap/i18n/marks_en.json',
        '../poi.json',
      ];
      let data: unknown = null;
      for (const candidate of candidates) {
        try {
          const resourceUrl = candidate === '../pzmap/i18n/marks_en.json'
            ? this.buildPoiResourceUrl()
            : candidate.startsWith('../') && this.sourceType === 'local'
              ? this.buildSiblingResourceUrl(candidate.slice(3))
              : this.buildResourceUrl(candidate);
          const response = await this.fetchMapResource(resourceUrl, {
            cache: 'force-cache',
          });
          if (response.ok) {
            data = await response.json();
            break;
          }
        } catch {
          // Try the next supported pzmap POI location.
        }
      }
      if (!Array.isArray(data)) {
        throw new Error('No POI data was found in the selected map package.');
      }
      const records = data.filter(
        (item): item is Record<string, unknown> => !!item && typeof item === 'object',
      );
      this.poiData = records
        .filter((item) => typeof item['x'] === 'number' && typeof item['y'] === 'number')
        .map((item, index) => ({
          id: String(item['id'] ?? item['ID'] ?? index),
          name: String(item['name'] ?? item['id'] ?? `POI ${index + 1}`),
          x: Number(item['x']),
          y: Number(item['y']),
          layer: typeof item['layer'] === 'number' ? item['layer'] : undefined,
          color: typeof item['color'] === 'string'
            ? item['color']
            : this.poiColor(this.classifyPoi(item)),
          category: this.classifyPoi(item),
        }));
      const knownMainAreaNames = new Set(
        this.poiData
          .filter((poi) => poi.category === 'main-areas')
          .map((poi) => poi.name.toLowerCase()),
      );
      for (const area of this.fanMapMainAreas) {
        if (knownMainAreaNames.has(area.name.toLowerCase())) {
          continue;
        }
        this.poiData.push({
          id: `fanmap-main-${area.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          name: area.name,
          x: area.x,
          y: area.y,
          color: this.poiColor('main-areas'),
          category: 'main-areas',
        });
      }
      this.areaData = records
        .filter((item) => item['type'] === 'area' && Array.isArray(item['rects']))
        .map((item, index) => ({
          id: String(item['id'] ?? `area-${index}`),
          name: String(item['name'] ?? item['id'] ?? `Area ${index + 1}`),
          layer: typeof item['layer'] === 'number' ? item['layer'] : undefined,
          color: typeof item['color'] === 'string' ? item['color'] : undefined,
          category: this.classifyArea(item),
          rects: (item['rects'] as unknown[])
            .filter((rect): rect is Record<string, unknown> => !!rect && typeof rect === 'object')
            .filter(
              (rect) =>
                typeof rect['x'] === 'number' &&
                typeof rect['y'] === 'number' &&
                typeof rect['width'] === 'number' &&
                typeof rect['height'] === 'number',
            )
            .map((rect) => ({
              x: Number(rect['x']),
              y: Number(rect['y']),
              width: Number(rect['width']),
              height: Number(rect['height']),
            })),
        }))
        .filter((area) => area.rects.length > 0);
      this.poiLoaded = true;
      this.areaLoaded = true;
      this.scheduleOverlayRender();
    } catch (error) {
      this.poiError = this.toErrorMessage(error);
    } finally {
      this.poiLoading = false;
    }
  }

  private async loadSaveMarkers(): Promise<void> {
    if (!this.isTauriRuntime) {
      this.saveData = [];
      this.saveError = 'Save markers are available in the desktop application.';
      return;
    }
    if (this.saveLoading) {
      return;
    }

    this.saveLoading = true;
    this.saveError = '';
    try {
      let userDir = (await this.store.getItem<string>('pz_user_dir'))?.trim() ?? '';
      if (!userDir) {
        userDir = (await invoke<string | null>('get_default_zomboid_user_dir'))?.trim() ?? '';
      }
      if (!userDir) {
        throw new Error('Project Zomboid save directory was not found. Set it in the app folders first.');
      }
      this.saveData = await this.characterEditor.listSaveMapMarkers(userDir);
      this.scheduleOverlayRender();
    } catch (error) {
      this.saveData = [];
      this.saveError = this.toErrorMessage(error);
    } finally {
      this.saveLoading = false;
    }
  }

  private classifyArea(item: Record<string, unknown>): string {
    const name = String(item['name'] ?? '').toLowerCase();
    if (/forest|lake|river|pond|water|creek|marsh|swamp|woods/.test(name)) {
      return 'natural';
    }
    if (/airport|facility|military|research|mall|hospital|prison|base/.test(name)) {
      return 'landmarks';
    }
    return 'settlements';
  }

  private classifyPoi(item: Record<string, unknown>): string {
    if (
      Number(item['Importance']) === 1 ||
      this.fanMapMainAreas.some(
        (area) => area.name.toLowerCase() === String(item['name'] ?? '').trim().toLowerCase(),
      )
    ) {
      return 'main-areas';
    }
    const explicit = typeof item['category'] === 'string'
      ? item['category'].trim().toLowerCase()
      : '';
    const knownCategories = new Set([
      'towns',
      'abandoned-towns',
      'water',
      'pois',
      'shops',
      'wells',
      'atms',
      'gas',
      'main-areas',
    ]);
    if (knownCategories.has(explicit)) {
      return explicit;
    }

    const name = String(item['name'] ?? '').toLowerCase();
    if (/abandoned|ruin|ruined|ghost town/.test(name)) {
      return 'abandoned-towns';
    }
    if (/lake|river|pond|water|sea|ocean|reservoir|creek|marsh|swamp/.test(name)) {
      return 'water';
    }
    if (/shop|store|market|diner|restaurant|clothing|bakery|bar|cafe|pub/.test(name)) {
      return 'shops';
    }
    if (/well\b/.test(name)) {
      return 'wells';
    }
    if (/atm\b/.test(name)) {
      return 'atms';
    }
    if (/gas station|fuel|petrol/.test(name)) {
      return 'gas';
    }
    if (
      item['type'] === 'area' ||
      /\b(town|city|village|borough|district|station|ridge|valley|muldraugh|rosewood|riverside|west point|louisville|march ridge|ekron|brandenburg|irvington|dixie)\b/.test(name)
    ) {
      return 'towns';
    }
    return 'pois';
  }

  private poiColor(category: string): string {
    return {
      towns: '#f59e0b',
      'abandoned-towns': '#ef4444',
      water: '#38bdf8',
      shops: '#c084fc',
      wells: '#22c55e',
      atms: '#14b8a6',
      gas: '#fb7185',
      'main-areas': '#fbbf24',
      pois: '#ffd166',
    }[category] ?? '#ffd166';
  }

  private async loadStreetData(): Promise<void> {
    this.streetLoading = true;
    this.streetError = '';
    try {
      const candidates = [
        `${this.getMapRoot()}/streets/marks.json`,
        'streets/marks.json',
        '../streets/marks.json',
        `${this.getMapRoot()}/roads/marks.json`,
        'roads/marks.json',
        '../roads/marks.json',
      ];
      let data: unknown = null;
      for (const candidate of candidates) {
        try {
          const resourceUrl = candidate.startsWith('../') && this.sourceType === 'local'
            ? this.buildSiblingResourceUrl(candidate.slice(3))
            : this.buildResourceUrl(candidate);
          const response = await this.fetchMapResource(resourceUrl, { cache: 'force-cache' });
          if (response.ok) {
            data = await response.json();
            break;
          }
        } catch {
          // Street marks are optional in a pzmap2dzi package.
        }
      }
      if (!Array.isArray(data)) {
        throw new Error('No street data was found in the selected map package.');
      }
      this.streetData = data
        .filter(
          (item): item is Record<string, unknown> => !!item && typeof item === 'object',
        )
        .filter((item) => Array.isArray(item['points']))
        .map((item, index) => ({
          id: String(item['id'] ?? `street-${index}`),
          name: String(item['name'] ?? item['id'] ?? `Street ${index + 1}`),
          layer: typeof item['layer'] === 'number' ? item['layer'] : undefined,
          color: typeof item['color'] === 'string' ? item['color'] : undefined,
          textColor: typeof item['text_color'] === 'string' ? item['text_color'] : undefined,
          visibleZoomLevel: typeof item['visible_zoom_level'] === 'number'
            ? item['visible_zoom_level']
            : undefined,
          width: typeof item['width'] === 'number' ? item['width'] : undefined,
          points: (item['points'] as unknown[])
            .filter((point): point is Record<string, unknown> => !!point && typeof point === 'object')
            .filter(
              (point) => typeof point['x'] === 'number' && typeof point['y'] === 'number',
            )
            .map((point) => ({ x: Number(point['x']), y: Number(point['y']) })),
        }))
        .filter((street) => street.points.length > 1);
      this.streetLoaded = true;
      this.scheduleOverlayRender();
    } catch (error) {
      this.streetError = this.toErrorMessage(error);
    } finally {
      this.streetLoading = false;
    }
  }

  private async loadAreaOverlayData(overlay: 'rooms' | 'objects'): Promise<void> {
    if (this.overlayAreaData.has(overlay) || this.overlayAreaLoading.has(overlay)) {
      return;
    }

    this.overlayAreaLoading.add(overlay);
    this.overlayError = '';
    try {
      const candidates = [
        `${overlay}/marks.json`,
        `../${overlay}/marks.json`,
      ];
      let data: unknown = null;
      for (const candidate of candidates) {
        try {
          const resourceUrl = candidate.startsWith('../') && this.sourceType === 'local'
            ? this.buildSiblingResourceUrl(candidate.slice(3))
            : this.buildResourceUrl(candidate);
          const response = await this.fetchMapResource(resourceUrl, { cache: 'force-cache' });
          if (response.ok) {
            data = await response.json();
            break;
          }
        } catch {
          // Try the next supported package location.
        }
      }
      if (!Array.isArray(data)) {
        throw new Error(`No ${overlay} area data was found in the selected map package.`);
      }

      const areas = data
        .filter(
          (item): item is Record<string, unknown> => !!item && typeof item === 'object',
        )
        .filter((item) => item['type'] === 'area' && Array.isArray(item['rects']))
        .map((item, index) => ({
          id: String(item['id'] ?? `${overlay}-${index}`),
          name: String(item['name'] ?? `${overlay} area ${index + 1}`),
          layer: typeof item['layer'] === 'number' ? item['layer'] : undefined,
          color: typeof item['color'] === 'string' ? item['color'] : undefined,
          rects: (item['rects'] as unknown[])
            .filter((rect): rect is Record<string, unknown> => !!rect && typeof rect === 'object')
            .filter(
              (rect) =>
                typeof rect['x'] === 'number' &&
                typeof rect['y'] === 'number' &&
                typeof rect['width'] === 'number' &&
                typeof rect['height'] === 'number',
            )
            .map((rect) => ({
              x: Number(rect['x']),
              y: Number(rect['y']),
              width: Number(rect['width']),
              height: Number(rect['height']),
            })),
        }))
        .filter((area) => area.rects.length > 0);

      this.overlayAreaData.set(overlay, areas);
      this.indexOverlayAreas(overlay, areas);
      this.scheduleOverlayRender();
    } catch (error) {
      this.overlayError = this.toErrorMessage(error);
    } finally {
      this.overlayAreaLoading.delete(overlay);
    }
  }

  private indexOverlayAreas(overlay: string, areas: MapArea[]): void {
    for (const area of areas) {
      for (const rect of area.rects) {
        const firstBucketX = Math.floor(rect.x / this.overlayAreaBucketSize);
        const lastBucketX = Math.floor(
          (rect.x + rect.width) / this.overlayAreaBucketSize,
        );
        const firstBucketY = Math.floor(rect.y / this.overlayAreaBucketSize);
        const lastBucketY = Math.floor(
          (rect.y + rect.height) / this.overlayAreaBucketSize,
        );
        for (let bucketY = firstBucketY; bucketY <= lastBucketY; bucketY += 1) {
          for (let bucketX = firstBucketX; bucketX <= lastBucketX; bucketX += 1) {
            const key = this.overlayAreaBucketKey(overlay, bucketX, bucketY);
            const bucket = this.overlayAreaIndex.get(key) ?? [];
            bucket.push({ area, rect });
            this.overlayAreaIndex.set(key, bucket);
          }
        }
      }
    }
  }

  private async loadZombieHeatmapData(): Promise<boolean> {
    if (this.zombieHeatmapData) {
      return true;
    }
    if (this.zombieHeatmapLoading) {
      return false;
    }

    this.zombieHeatmapLoading = true;
    try {
      const metadataResponse = await this.fetchMapResource(
        this.buildResourceUrl('zombie/heatmap.json'),
        { cache: 'force-cache' },
      );
      if (!metadataResponse.ok) {
        return false;
      }
      const metadata = await metadataResponse.json() as Record<string, unknown>;
      const cells = Array.isArray(metadata['cells'])
        ? metadata['cells']
          .filter((cell): cell is unknown[] => Array.isArray(cell))
          .map((cell) => ({ x: Number(cell[0]), y: Number(cell[1]) }))
          .filter((cell) => Number.isFinite(cell.x) && Number.isFinite(cell.y))
        : [];
      const cellSize = Number(metadata['cell_size']);
      const cellSizeInBlock = Number(metadata['cell_size_in_block']);
      if (!cells.length || !Number.isFinite(cellSize) || !Number.isFinite(cellSizeInBlock) || cellSizeInBlock <= 0) {
        return false;
      }
      const dataFile = typeof metadata['data'] === 'string'
        ? metadata['data']
        : 'heatmap.bin';
      const dataResponse = await this.fetchMapResource(
        this.buildResourceUrl(`zombie/${dataFile.replace(/^[/\\]+/, '')}`),
        { cache: 'force-cache' },
      );
      if (!dataResponse.ok) {
        return false;
      }
      const values = new Uint8Array(await dataResponse.arrayBuffer());
      const expectedLength = cells.length * cellSizeInBlock * cellSizeInBlock;
      if (values.length !== expectedLength) {
        return false;
      }
      this.zombieHeatmapData = {
        cellSize,
        cellSizeInBlock,
        cells: cells.map((cell, index) => ({ ...cell, index })),
        values,
      };
      return true;
    } catch {
      // Older pzmap packages use the DZI fallback instead of heatmap data.
      return false;
    } finally {
      this.zombieHeatmapLoading = false;
    }
  }

  private async loadOverlayTile(overlay: string): Promise<void> {
    if (!this.viewer || this.overlayTileItems.has(overlay)) {
      return;
    }

    if (overlay === 'zombie' && await this.loadZombieHeatmapData()) {
      this.scheduleOverlayRender();
      return;
    }

    const overlayRoot = this.mapView === 'top' && ['zombie', 'foraging'].includes(overlay)
      ? `${overlay}_top`
      : overlay;
    const overlayLayer = overlay === 'zombie' || overlay === 'foraging'
      ? 0
      : this.selectedLayer;
    const tileSource = await this.buildTileSource(
      `${overlayRoot}/layer${overlayLayer}.dzi`,
    );
    this.ngZone.runOutsideAngular(() => {
      this.viewer?.addTiledImage({
        tileSource,
        // Sunday Drivers uses a semi-transparent overlay so the base map
        // remains legible beneath heatmap/foraging colors.
        opacity: 0.5,
        success: (event) => {
          const item = (event as Event & { item: OpenSeadragon.TiledImage }).item;
          const keep = this.selectedOverlay === overlay || this.activeOverlayLayers.has(overlay);
          if (keep) {
            this.overlayTileItems.set(overlay, item);
            this.scheduleOverlayRender();
          } else {
            this.viewer?.world.removeItem(item);
          }
        },
        error: () => {
          this.removeOverlayTile(overlay);
        },
      });
    });
  }

  private removeOverlayTile(overlay: string): void {
    const item = this.overlayTileItems.get(overlay);
    if (item) {
      this.viewer?.world.removeItem(item);
      this.overlayTileItems.delete(overlay);
    }
  }

  private reloadActiveOverlays(): void {
    for (const overlay of this.activeOverlayLayers) {
      if (overlay === 'streets') {
        this.showStreets = true;
        if (!this.streetLoaded && !this.streetLoading) {
          void this.loadStreetData();
        }
        continue;
      }
      if (overlay === 'rooms' || overlay === 'objects') {
        void this.loadAreaOverlayData(overlay);
        continue;
      }
      this.removeOverlayTile(overlay);
      void this.loadOverlayTile(overlay);
    }
    if (this.selectedOverlay) {
      this.removeOverlayTile(this.selectedOverlay);
      void this.loadOverlayTile(this.selectedOverlay);
    }
  }

  private buildPoiResourceUrl(): string {
    if (this.sourceType === 'url') {
      return this.buildResourceUrl('../pzmap/i18n/marks_en.json');
    }

    const root = this.sourceLocation.trim().replace(/[\\/]+$/, '');
    const separator = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'));
    const parent = separator >= 0 ? root.slice(0, separator) : root;
    return convertFileSrc(`${parent}/pzmap/i18n/marks_en.json`.replace(/\\/g, '/'));
  }

  private buildSiblingResourceUrl(relativePath: string): string {
    if (this.sourceType === 'url') {
      return this.buildResourceUrl(`../${relativePath}`);
    }
    const root = this.sourceLocation.trim().replace(/[\\/]+$/, '');
    const separator = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'));
    const parent = separator >= 0 ? root.slice(0, separator) : root;
    return convertFileSrc(`${parent}/${relativePath}`.replace(/\\/g, '/'));
  }

  private updateAvailableLayerOptions(status: MapRenderStatus): void {
    if (!this.mapInfo || !Array.isArray(status.available_layers)) {
      return;
    }

    this.layerOptions = this.createLayerOptions(
      this.mapInfo,
      status.available_layers,
    );
    const selectedIsAvailable = this.layerOptions.some(
      (option) => option.value === this.selectedLayer,
    );
    if (!selectedIsAvailable && this.layerOptions.length > 0) {
      this.selectedLayer = this.layerOptions[0].value;
      if (this.viewer && this.hasLoadedMap && !this.loading) {
        void this.openLayer(this.selectedLayer);
      }
    }
  }

  get renderStatusSeverity(): 'info' | 'success' | 'warn' | 'error' {
    switch (this.renderStatus?.state) {
      case 'ready':
        return 'success';
      case 'error':
        return 'error';
      default:
        return 'info';
    }
  }

  get coordinateReadout(): string {
    return this.mapCoordinates || `x: —, y: —\ncell: —\nlayer: ${this.selectedLayer}`;
  }

  private startRenderStatusPolling(): void {
    void this.refreshRenderStatus();
    this.renderStatusTimer = window.setInterval(() => {
      void this.refreshRenderStatus();
    }, 5000);
  }

  private async refreshRenderStatus(): Promise<void> {
    if (
      !this.store.isTauriRuntime() ||
      this.sourceType !== 'local' ||
      !this.sourceLocation.trim()
    ) {
      this.renderStatus = null;
      return;
    }

    try {
      this.renderStatus = await invoke<MapRenderStatus>(
        'inspect_map_render_status',
        { root: this.sourceLocation.trim(), view: this.mapView },
      );
      this.updateAvailableLayerOptions(this.renderStatus);

    } catch {
      this.renderStatus = null;
    }
  }

  private clearTileErrorTimer(): void {
    if (this.tileErrorTimer !== null) {
      window.clearTimeout(this.tileErrorTimer);
      this.tileErrorTimer = null;
    }
  }

  private scheduleViewportPersistence(): void {
    if (!this.viewer || !this.mapInfo || !this.loadedMapView) {
      return;
    }
    if (this.viewportSaveTimer !== null) {
      window.clearTimeout(this.viewportSaveTimer);
    }
    this.viewportSaveTimer = window.setTimeout(() => {
      this.viewportSaveTimer = null;
      void this.writeSettings();
    }, 250);
  }

  private clearViewportSaveTimer(): void {
    if (this.viewportSaveTimer !== null) {
      window.clearTimeout(this.viewportSaveTimer);
      this.viewportSaveTimer = null;
    }
  }

  private resizeViewer(viewer: OpenSeadragon.Viewer): void {
    this.ngZone.runOutsideAngular(() => {
      const host = this.mapHost.nativeElement;
      if (!host.clientWidth || !host.clientHeight) {
        return;
      }

      viewer.forceResize();
      viewer.viewport?.update();
      viewer.forceRedraw();
    });
  }

  private getTileLoaderLimit(): number {
    const cpuCount = navigator.hardwareConcurrency || 4;
    return Math.min(16, Math.max(4, cpuCount));
  }

  private getTileFrameLimit(): number {
    const cpuCount = navigator.hardwareConcurrency || 4;
    return Math.min(24, Math.max(8, cpuCount * 2));
  }

  private getTileCacheCount(): number {
    const deviceMemory = (
      navigator as Navigator & { deviceMemory?: number }
    ).deviceMemory;
    const memoryGiB = deviceMemory && deviceMemory > 0 ? deviceMemory : 8;
    return Math.min(1024, Math.max(256, Math.round(memoryGiB * 64)));
  }

  private updateWebMapSiteUrl(): void {
    this.webMapSiteUrl = this.getWebMapSource(this.webMapSource).url;
  }

  private scheduleWebSiteEmbedding(): void {
    if (
      !this.isTauriRuntime ||
      this.sourceType !== 'url' ||
      this.webSiteSyncFrame !== null
    ) {
      return;
    }

    this.webSiteSyncFrame = window.requestAnimationFrame(() => {
      this.webSiteSyncFrame = null;
      void this.syncEmbeddedWebSite();
    });
  }

  private setupWebSiteResizeObserver(): void {
    if (!this.isTauriRuntime || this.webSiteResizeObserver || !this.webSiteHost) {
      return;
    }

    this.webSiteResizeObserver = new ResizeObserver(() => {
      this.scheduleWebSiteEmbedding();
    });
    this.webSiteResizeObserver.observe(this.webSiteHost.nativeElement);
  }

  private disconnectWebSiteResizeObserver(): void {
    this.webSiteResizeObserver?.disconnect();
    this.webSiteResizeObserver = null;
  }

  private async syncEmbeddedWebSite(): Promise<void> {
    if (!this.isTauriRuntime || this.sourceType !== 'url' || !this.webSiteHost) {
      return;
    }

    if (this.webSiteEmbeddingOperation) {
      await this.webSiteEmbeddingOperation;
      if (this.sourceType === 'url') {
        this.scheduleWebSiteEmbedding();
      }
      return;
    }

    const operation = this.openEmbeddedWebSite();
    this.webSiteEmbeddingOperation = operation;
    try {
      await operation;
    } finally {
      if (this.webSiteEmbeddingOperation === operation) {
        this.webSiteEmbeddingOperation = null;
      }
    }
  }

  private async openEmbeddedWebSite(): Promise<void> {
    if (!this.webSiteHost) {
      return;
    }

    this.setupWebSiteResizeObserver();
    const rect = this.webSiteHost.nativeElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }

    try {
      await invoke('open_project_zomboid_map', {
        bounds: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
          url: this.webMapSiteUrl,
        },
      });
    } catch (error) {
      this.error = this.toErrorMessage(error);
    }
  }

  private async closeEmbeddedWebSite(): Promise<void> {
    if (!this.isTauriRuntime) {
      return;
    }

    if (this.webSiteEmbeddingOperation) {
      await this.webSiteEmbeddingOperation;
      this.webSiteEmbeddingOperation = null;
    }

    try {
      await invoke('close_project_zomboid_map');
    } catch {
      // The child webview may already be closed during app shutdown.
    }
  }

  private waitForViewUpdate(): Promise<void> {
    return new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  private async fetchMapResource(
    url: string,
    options?: RequestInit,
  ): Promise<Response> {
    if (this.sourceType === 'url' && this.store.isTauriRuntime()) {
      return tauriFetch(url, options);
    }

    return window.fetch(url, options);
  }

  private async buildTileSource(relativePath: string): Promise<string> {
    const resourceUrl = this.buildResourceUrl(relativePath);

    // FanMap42's tile host allows image requests but does not expose its DZI
    // XML to browser XHR. Fetch the XML through Tauri's HTTP client and hand
    // OpenSeadragon an inline source whose tile directory remains remote.
    if (this.sourceType !== 'url' || !this.store.isTauriRuntime()) {
      return resourceUrl;
    }

    const response = await this.fetchMapResource(resourceUrl, {
      cache: 'force-cache',
    });
    if (!response.ok) {
      throw new Error(`Map tile metadata was not found (HTTP ${response.status}).`);
    }

    const dzi = await response.text();
    const urlAttribute = dzi.match(/\bUrl\s*=\s*(["'])(.*?)\1/i);
    const dziFileName = resourceUrl.split('/').pop() ?? 'layer0.dzi';
    const tileDirectory = new URL(
      `${dziFileName.replace(/\.dzi(?:\?.*)?$/i, '')}_files/`,
      resourceUrl,
    ).toString();

    if (urlAttribute) {
      const resolvedTileDirectory = new URL(
        urlAttribute[2],
        resourceUrl,
      ).toString();
      return dzi.replace(
        urlAttribute[0],
        `Url=${urlAttribute[1]}${resolvedTileDirectory}${urlAttribute[1]}`,
      );
    }

    if (!/<Image\b/i.test(dzi)) {
      throw new Error('The selected map tile metadata is not valid DZI XML.');
    }

    return dzi.replace(
      /<Image\b/i,
      `<Image Url="${tileDirectory}"`,
    );
  }

  private buildResourceUrl(relativePath: string): string {
    const root = this.sourceLocation.trim().replace(/[\\/]+$/, '');
    if (this.sourceType === 'url') {
      return new URL(relativePath.replace(/^\//, ''), `${root}/`).toString();
    }

    if (!this.store.isTauriRuntime()) {
      throw new Error(
        'Local map folders can only be opened from the Tauri desktop application. Use a web address while running Angular in a browser.',
      );
    }

    // Keep the filesystem path Windows-compatible while using forward slash
    // separators in the asset URL. Tauri's asset protocol percent-encodes the
    // complete path. With backslashes this produces URLs such as
    // `D%3A%5C...%5Clayer0_files%5C16%5C17_8.webp`; OpenSeadragon then appends
    // the DZI-relative tile path to that encoded Windows path. Forward slash
    // separators decode cleanly inside Tauri and preserve the DZI `_files`
    // layout for native OpenSeadragon tile URL resolution.
    const localPath = `${root}/${relativePath.replace(/^[/\\]+/, '')}`.replace(
      /\\/g,
      '/',
    );
    return convertFileSrc(localPath);
  }


  private destroyViewer(): void {
    this.stopHoverPulseAnimation();
    this.mapResizeObserver?.disconnect();
    this.mapResizeObserver = null;
    this.viewer?.destroy();
    this.viewer = null;
    this.loadedMapView = null;
    this.overlayTileItems.clear();
  }

  private async readSettings(): Promise<MapSourceSettings | null> {
    if (this.store.isTauriRuntime()) {
      const value = await this.store.getItem<MapSourceSettings>(this.storeKey);
      return this.isValidSettings(value) ? value : null;
    }

    try {
      const value = JSON.parse(localStorage.getItem(this.storeKey) ?? 'null') as MapSourceSettings | null;
      return this.isValidSettings(value) ? value : null;
    } catch {
      return null;
    }
  }

  private async writeSettings(): Promise<void> {
    const settings: MapSourceSettings = {
      sourceType: this.sourceType,
      sourceLocation: this.sourceLocation.trim(),
      viewType: this.mapView,
      selectedLayer: this.selectedLayer,
      navigation: {
        collapsed: this.navigationCollapsed,
        sections: { ...this.toolSections },
        selectedOverlay: this.selectedOverlay,
        activeOverlayLayers: [...this.activeOverlayLayers],
        visibleMarkerGroups: [...this.visibleMarkerGroups],
        visibleAreaGroups: [...this.visibleAreaGroups],
        viewport: this.captureViewportState(this.loadedMapView) ?? this.pendingViewportRestore ?? undefined,
        showAnnotations: this.showAnnotations,
        showSaves: this.showSaves,
        markerDefaultsApplied: true,
        navigationDefaultsApplied: true,
      },
      customPois: this.customPois,
    };

    if (this.store.isTauriRuntime()) {
      await this.store.setItem(this.storeKey, settings);
      return;
    }

    try {
      localStorage.setItem(this.storeKey, JSON.stringify(settings));
    } catch {
      // Browser storage may be unavailable in private or restricted contexts.
    }
  }

  private isValidSettings(value: MapSourceSettings | null): value is MapSourceSettings {
    return (
      !!value &&
      (value.sourceType === 'local' || value.sourceType === 'url') &&
      typeof value.sourceLocation === 'string' &&
      value.sourceLocation.trim().length > 0 &&
      (value.viewType === undefined ||
        value.viewType === 'iso' ||
        value.viewType === 'top') &&
      (value.selectedLayer === undefined || Number.isFinite(value.selectedLayer))
    );
  }

  private restoreNavigationSettings(settings?: MapNavigationSettings): void {
    if (!settings) {
      return;
    }

    this.navigationCollapsed = settings.collapsed === true;
    if (settings.navigationDefaultsApplied === true) {
      for (const section of ['overlay', 'layers', 'markers', 'editor', 'legend', 'coordinates'] as const) {
        const value = settings.sections?.[section];
        if (typeof value === 'boolean') {
          this.toolSections[section] = value;
        }
      }
    }
    this.selectedOverlay = typeof settings.selectedOverlay === 'string'
      ? settings.selectedOverlay
      : '';
    this.activeOverlayLayers = new Set(
      Array.isArray(settings.activeOverlayLayers) ? settings.activeOverlayLayers : [],
    );
    this.visibleMarkerGroups = new Set(
      Array.isArray(settings.visibleMarkerGroups) ? settings.visibleMarkerGroups : [],
    );
    if (settings.markerDefaultsApplied !== true) {
      this.visibleMarkerGroups.add('main-areas');
    }
    this.visibleAreaGroups = new Set(
      Array.isArray(settings.visibleAreaGroups) ? settings.visibleAreaGroups : [],
    );
    const viewport = settings.viewport;
    this.pendingViewportRestore = viewport &&
      Number.isFinite(viewport.squareX) &&
      Number.isFinite(viewport.squareY) &&
      Number.isFinite(viewport.zoom)
      ? viewport
      : null;
    this.showAnnotations = settings.showAnnotations !== false;
    this.showSaves = settings.showSaves === true;
  }

  private normalizeCustomPois(value: unknown): CustomMapPoi[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item, index): CustomMapPoi | null => {
        const geometry = item['geometry'] === 'line' || item['geometry'] === 'polygon' || item['geometry'] === 'text'
          ? item['geometry']
          : 'point';
        const tool: MapEditorTool = item['tool'] === 'point' || item['tool'] === 'shape' || item['tool'] === 'text' || item['tool'] === 'line' || item['tool'] === 'polygon'
          ? item['tool']
          : geometry === 'text' ? 'text' : geometry === 'line' ? 'line' : geometry === 'polygon' ? 'polygon' : 'point';
        const vertices = Array.isArray(item['vertices'])
          ? item['vertices']
            .filter((vertex): vertex is Record<string, unknown> => !!vertex && typeof vertex === 'object')
            .filter((vertex) => typeof vertex['x'] === 'number' && typeof vertex['y'] === 'number')
            .map((vertex) => ({ x: Number(vertex['x']), y: Number(vertex['y']) }))
          : [];
        const minimumVertices = geometry === 'polygon' ? 3 : 2;
        if (geometry !== 'point' && geometry !== 'text' && vertices.length < minimumVertices) {
          return null;
        }
        const anchor = vertices.length > 0
          ? {
            x: vertices.reduce((sum, vertex) => sum + vertex.x, 0) / vertices.length,
            y: vertices.reduce((sum, vertex) => sum + vertex.y, 0) / vertices.length,
          }
          : null;
        const x = typeof item['x'] === 'number' ? Number(item['x']) : anchor?.x;
        const y = typeof item['y'] === 'number' ? Number(item['y']) : anchor?.y;
        if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
          return null;
        }
        return {
          id: typeof item['id'] === 'string' && item['id'].trim() ? item['id'] : `annotation-${index + 1}`,
          tool,
          label: typeof item['label'] === 'string' && item['label'].trim()
            ? item['label'].trim()
            : `Annotation ${index + 1}`,
          description: typeof item['description'] === 'string' ? item['description'] : '',
          category: 'my-poi',
          x,
          y,
          layer: typeof item['layer'] === 'number' ? item['layer'] : 0,
          icon: this.poiIconOptions.some((option) => option.value === item['icon']) ? String(item['icon']) : '●',
          shape: this.poiShapeOptions.some((option) => option.value === item['shape'])
            ? item['shape'] as PoiShape
            : 'circle',
          color: typeof item['color'] === 'string' && item['color'].trim() ? item['color'] : '#f59e0b',
          size: this.poiSizeOptions.some((option) => option.value === item['size'])
            ? item['size'] as PoiSize
            : 'medium',
          strokeWidth: this.normalizeStrokeWidth(item['strokeWidth']),
          linePattern: this.normalizeLinePattern(item['linePattern']),
          geometry,
          vertices: geometry === 'point' || geometry === 'text' ? undefined : vertices,
        };
      })
      .filter((item): item is CustomMapPoi => item !== null);
  }

  private createPoiId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `annotation-${crypto.randomUUID()}`;
    }
    return `annotation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private normalizeStrokeWidth(value: unknown): number {
    const width = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(width)) {
      return 4;
    }
    return Math.min(16, Math.max(1, Math.round(width)));
  }

  private normalizeLinePattern(value: unknown): LinePattern {
    return value === 'dashed' || value === 'dotted' || value === 'dash-dot'
      ? value
      : 'solid';
  }

  private lineDashForPattern(pattern: LinePattern | undefined): number[] {
    switch (pattern ?? 'solid') {
      case 'dashed':
        return [12, 8];
      case 'dotted':
        return [2, 7];
      case 'dash-dot':
        return [12, 6, 2, 6];
      default:
        return [];
    }
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isMapPackageResolutionError(message: string): boolean {
    return message.toLocaleLowerCase().includes('map package folder could not be resolved');
  }
}
