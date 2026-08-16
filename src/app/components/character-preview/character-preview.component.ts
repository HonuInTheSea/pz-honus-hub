import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import {
  AmbientLight,
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  CanvasTexture,
  Clock,
  Color,
  DirectionalLight,
  Group,
  LoadingManager,
  LoopRepeat,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  QuaternionKeyframeTrack,
  SRGBColorSpace,
  Scene,
  SkinnedMesh,
  Texture,
  TextureLoader,
  VectorKeyframeTrack,
  Vector3,
  WebGLRenderer,
} from 'three';
import { FBXLoader, XLoader } from 'three-stdlib';
import type {
  CharacterDetails,
  CharacterRenderAsset,
  CharacterRenderAssets,
  CharacterRenderLayer,
} from '../../models/character.models';
import { CharacterEditorService } from '../../services/character-editor.service';

type ParsedX = {
  models: Object3D[];
  animations: Array<Record<string, unknown>>;
};

type CompatibleXLoader = XLoader & {
  _setMaterial(): void;
  _computeGroups(geometry: { addGroup: (start: number, count: number, materialIndex: number) => void }, indices: number[]): void;
  _makeOutputGeometry(): void;
};

type AnimationVector = { x: number; y: number; z: number };
type AnimationRotation = { x: number; y: number; z: number; w: number } | number[];
type AnimationKey = {
  time?: number;
  pos?: AnimationVector;
  rot?: AnimationRotation;
  scl?: AnimationVector;
};
type AnimationHierarchyEntry = {
  name?: string;
  keys?: AnimationKey[];
};
type ParsedAnimation = {
  name?: string;
  fps?: number;
  length?: number;
  hierarchy?: AnimationHierarchyEntry[];
};

@Component({
  selector: 'app-character-preview',
  standalone: true,
  template:
    '<div #viewport class="character-preview-viewport">' +
    '<div class="preview-animation-controls">' +
    '<label for="preview-animation">Pose</label>' +
    '<select id="preview-animation" [value]="selectedAnimation" (change)="changeAnimation($any($event.target).value)">' +
    '<option value="idle">Idle</option><option value="walk">Walk</option><option value="run">Run</option><option value="sit">Sit</option>' +
    '</select>' +
    '<label for="preview-zoom">Zoom</label>' +
    '<input id="preview-zoom" type="range" min="0" max="40" step="1" [value]="zoomLevel" (input)="changeZoom($any($event.target).value)" aria-label="Preview zoom level" />' +
    '<span class="preview-zoom-value">{{ zoomLevel + 1 }}/41</span>' +
    '</div>' +
    '<div class="preview-status">{{ statusText }}</div>' +
    '</div>',
  styleUrl: './character-preview.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CharacterPreviewComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() character: CharacterDetails | null = null;
  @Input() gameDir = '';
  @Input() visualRevision = 0;
  @ViewChild('viewport') viewport?: ElementRef<HTMLDivElement>;

  statusText = '';
  selectedAnimation = 'idle';
  zoomLevel = 0;

  private readonly scene = new Scene();
  private readonly world = new Group();
  private readonly camera = new PerspectiveCamera(35, 1, 0.01, 100);
  private readonly renderer = new WebGLRenderer({ antialias: true, alpha: false });
  private readonly textureLoader = new TextureLoader();
  private readonly clock = new Clock();
  private readonly modelGroup = new Group();
  private animationFrame = 0;
  private viewReady = false;
  private renderRequest = 0;
  private animationRequest = 0;
  private loadedRenderKey = '';
  private fitDistance = 10;
  private readonly fittedModelSize = new Vector3();
  private readonly fittedTarget = new Vector3();
  // Reference placement from the requested 693x448 diagnostic view:
  // model 221.5,140.4 px at zoom 12/41.
  private readonly referenceScreenPosition = {
    x: 221.5 / 693,
    y: 140.4 / 448,
  };
  private resizeObserver?: ResizeObserver;
  private hasManualPlacement = false;
  private rotating = false;
  private rotationLastX = 0;
  private rotationAnchor?: Vector3;
  private renderAssets: CharacterRenderAssets | null = null;
  private animatedModels: Mesh[] = [];
  private mixers: AnimationMixer[] = [];
  private animationActions: AnimationAction[] = [];

  constructor(
    private readonly editor: CharacterEditorService,
    private readonly changeDetector: ChangeDetectorRef,
  ) {
    this.scene.add(this.world);
    this.world.add(this.modelGroup);
    this.world.add(new AmbientLight(0xb8d4df, 2.1));

    const key = new DirectionalLight(0xffffff, 3.2);
    key.position.set(3, 5, -5);
    this.world.add(key);

    const fill = new DirectionalLight(0x6ca9c4, 1.8);
    fill.position.set(-4, 2, 1);
    this.world.add(fill);

    this.camera.position.set(0, 2.1, -7.2);
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    const host = this.viewport?.nativeElement;
    if (!host) return;
    host.appendChild(this.renderer.domElement);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    host.addEventListener('pointerdown', this.handlePointerDown, true);
    host.addEventListener('pointermove', this.handlePointerMove, true);
    host.addEventListener('pointerup', this.handlePointerUp, true);
    host.addEventListener('pointercancel', this.handlePointerUp, true);
    this.resize();
    this.animate();
    void this.loadCharacter();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.viewReady) return;
    const characterChanged = Boolean(changes['character']);
    const gameDirectoryChanged = Boolean(changes['gameDir']);
    const visualsChanged = Boolean(changes['visualRevision']);
    if ((characterChanged || gameDirectoryChanged || visualsChanged) && this.renderKey() !== this.loadedRenderKey) {
      void this.loadCharacter();
    }
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.animationFrame);
    this.resizeObserver?.disconnect();
    const host = this.viewport?.nativeElement;
    host?.removeEventListener('pointerdown', this.handlePointerDown, true);
    host?.removeEventListener('pointermove', this.handlePointerMove, true);
    host?.removeEventListener('pointerup', this.handlePointerUp, true);
    host?.removeEventListener('pointercancel', this.handlePointerUp, true);
    this.disposeObject(this.modelGroup);
    this.renderer.dispose();
  }

  changeAnimation(animationId: string): void {
    void this.playAnimation(animationId);
  }

  changeZoom(value: string): void {
    const level = Number(value);
    if (!Number.isFinite(level)) return;
    this.zoomLevel = Math.max(0, Math.min(40, Math.round(level)));
    this.applyZoom();
  }

  private async loadCharacter(): Promise<void> {
    const request = ++this.renderRequest;
    this.clearModel();
    this.modelGroup.visible = false;
    if (!this.character) {
      this.statusText = 'Select a character to render a preview.';
      this.changeDetector.markForCheck();
      return;
    }
    if (!this.gameDir) {
      this.statusText = 'Configure the Project Zomboid game directory to load 3D assets.';
      this.changeDetector.markForCheck();
      return;
    }

    this.statusText = 'Loading Build 42 character assets…';
    this.changeDetector.markForCheck();
    try {
      const assets = await this.editor.loadRenderAssets(this.gameDir, this.character.visuals);
      if (request !== this.renderRequest) return;
      await this.buildModel(assets);
      if (request !== this.renderRequest) return;
      await this.playAnimation(this.selectedAnimation, false);
      this.applyReferencePlacement();
      this.loadedRenderKey = this.renderKey();
      this.modelGroup.visible = true;
      this.statusText = assets.warnings.length
        ? 'Rendered game assets · ' + assets.warnings.length + ' optional asset warning' + (assets.warnings.length === 1 ? '' : 's')
        : 'Rendered Build 42 assets · click and drag to rotate';
      this.changeDetector.markForCheck();
    } catch (error) {
      if (request !== this.renderRequest) return;
      this.statusText = '3D asset preview unavailable: ' + this.errorMessage(error);
      this.changeDetector.markForCheck();
    }
  }

  private async buildModel(assets: CharacterRenderAssets): Promise<void> {
    this.renderAssets = assets;
    this.animatedModels = [];
    const textures = new Map<string, Texture>();
    await Promise.all(
      assets.textures.map(async (asset) => {
        try {
          const texture = await this.loadTexture(asset);
          texture.colorSpace = SRGBColorSpace;
          textures.set(asset.id, texture);
        } catch {
          // Optional texture failures are reflected by the Rust warning list.
        }
      }),
    );
    const bodyTexture = this.createBodyTexture(assets, textures)
      ?? this.firstModelTexture('body', assets, textures)
      ?? textures.get('skin');
    const fbxLoader = new FBXLoader();
    for (const [modelIndex, asset] of assets.models.entries()) {
      const parsed = await this.parseModel(asset, fbxLoader);
      const preferredTexture = this.textureForModel(asset, modelIndex, assets, textures, bodyTexture);
      const tint = asset.id === 'hair'
        ? this.colorFromCss(this.character?.visuals.hairColor)
        : asset.id === 'beard'
          ? this.colorFromCss(this.character?.visuals.beardColor)
          : undefined;
      for (const model of parsed.models) {
        this.applyTexture(model, preferredTexture, tint);
        if ((model as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh && (model as Mesh & { skeleton?: unknown }).skeleton) {
          this.animatedModels.push(model as Mesh);
        }
        const attachBone = assets.clothingLayers.find((layer) => layer.modelId === asset.id)?.attachBone;
        const parent = attachBone ? this.findBodyBone(attachBone) : undefined;
        (parent ?? this.modelGroup).add(model);
      }
    }

    this.modelGroup.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(this.modelGroup);
    if (bounds.isEmpty()) throw new Error('The game model did not contain renderable geometry.');
    const renderedBounds = new Box3();
    this.expandRenderedBounds(this.modelGroup, renderedBounds);
    const framingBounds = renderedBounds.isEmpty() ? bounds : renderedBounds;
    const size = framingBounds.getSize(new Vector3());
    const center = framingBounds.getCenter(new Vector3());
    const height = Math.max(size.y, 0.01);
    const scale = 3.2 / height;
    this.modelGroup.scale.setScalar(scale);
    this.modelGroup.position.set(
      -center.x * scale,
      0.1 - framingBounds.min.y * scale,
      -center.z * scale,
    );
    this.modelGroup.updateMatrixWorld(true);
    const fittedBounds = new Box3();
    this.expandRenderedBounds(this.modelGroup, fittedBounds);
    if (!fittedBounds.isEmpty()) {
      const fittedCenter = fittedBounds.getCenter(new Vector3());
      this.modelGroup.position.x -= fittedCenter.x;
      this.modelGroup.position.y += 0.1 - fittedBounds.min.y;
      this.modelGroup.position.z -= fittedCenter.z;
    }
    this.modelGroup.updateMatrixWorld(true);
    const finalBounds = new Box3();
    this.expandRenderedBounds(this.modelGroup, finalBounds);
    const target = finalBounds.isEmpty() ? new Vector3(0, 1.6, 0) : finalBounds.getCenter(new Vector3());
    const finalSize = finalBounds.isEmpty() ? new Vector3(0, 3.2, 0) : finalBounds.getSize(new Vector3());
    this.fittedModelSize.copy(finalSize);
    this.fittedTarget.copy(target);
    this.updateCameraFit();
    this.camera.position.set(target.x, target.y, target.z - this.fitDistance);
    this.applyZoom();
    this.alignModelToViewportCenter();
  }

  private textureForModel(
    model: CharacterRenderAsset,
    modelIndex: number,
    assets: CharacterRenderAssets,
    textures: Map<string, Texture>,
    bodyTexture?: Texture,
  ): Texture | undefined {
    if (model.id === 'body') {
      return bodyTexture ?? this.firstModelTexture(model.id, assets, textures) ?? textures.get('skin');
    }
    if (model.id === 'hair' || model.id === 'beard') return textures.get('hair');
    const layer = assets.clothingLayers.find((candidate) => candidate.modelId === model.id);
    const textureId = layer ? this.selectedTextureId(layer) : undefined;
    return textureId ? textures.get(textureId) : undefined;
  }

  private selectedTextureId(layer: CharacterRenderLayer): string | undefined {
    if (!layer.textureIds.length) return undefined;
    return layer.textureIds[layer.selectedTexture ?? 0] ?? layer.textureIds[0];
  }

  private firstModelTexture(
    modelId: string,
    assets: CharacterRenderAssets,
    textures: Map<string, Texture>,
  ): Texture | undefined {
    const prefix = 'model-texture-' + modelId + '-';
    for (const textureAsset of assets.textures) {
      if (textureAsset.id.startsWith(prefix)) {
        const texture = textures.get(textureAsset.id);
        if (texture) return texture;
      }
    }
    return undefined;
  }

  private createBodyTexture(
    assets: CharacterRenderAssets,
    textures: Map<string, Texture>,
  ): Texture | undefined {
    const base = textures.get('skin');
    if (!base?.image || typeof document === 'undefined') return base?.image ? base : undefined;
    const image = base.image as HTMLImageElement;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    if (!canvas.width || !canvas.height) return base;
    const context = canvas.getContext('2d');
    if (!context) return base;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const skinTint = this.colorFromCss(this.character?.visuals.skinColor);
    if (skinTint) {
      const original = document.createElement('canvas');
      original.width = canvas.width;
      original.height = canvas.height;
      original.getContext('2d')?.drawImage(canvas, 0, 0);
      context.save();
      context.globalCompositeOperation = 'multiply';
      context.fillStyle = '#' + skinTint.getHexString();
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(original, 0, 0);
      context.restore();
    }
    for (const layer of assets.clothingLayers) {
      const mask = this.createMaskCanvas(layer, textures, canvas.width, canvas.height);
      if (mask && this.shouldHideBodyUnder(layer)) {
        context.save();
        context.globalCompositeOperation = 'destination-out';
        context.drawImage(mask, 0, 0);
        context.restore();
      }
      if (!this.isBodyOverlayLayer(layer)) continue;
      const textureId = this.selectedTextureId(layer);
      const overlay = textureId ? textures.get(textureId) : undefined;
      if (overlay?.image) {
        this.drawMaskedOverlay(context, overlay.image as CanvasImageSource, layer, textures, canvas.width, canvas.height);
      }
    }
    context.save();
    context.globalCompositeOperation = 'destination-out';
    context.beginPath();
    context.moveTo(canvas.width * 0.43, canvas.height * 0.63);
    context.lineTo(canvas.width * 0.57, canvas.height * 0.63);
    context.lineTo(canvas.width * 0.58, canvas.height);
    context.lineTo(canvas.width * 0.42, canvas.height);
    context.closePath();
    context.fill();
    context.restore();
    const composed = new CanvasTexture(canvas);
    composed.colorSpace = SRGBColorSpace;
    composed.needsUpdate = true;
    return composed;
  }

  private createMaskCanvas(
    layer: CharacterRenderLayer,
    textures: Map<string, Texture>,
    width: number,
    height: number,
  ): HTMLCanvasElement | undefined {
    if (typeof document === 'undefined' || !layer.maskTextureIds.length) return undefined;
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = width;
    maskCanvas.height = height;
    const maskContext = maskCanvas.getContext('2d');
    if (!maskContext) return undefined;
    for (const maskId of layer.maskTextureIds) {
      const image = textures.get(maskId)?.image;
      if (!image) continue;
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = width;
      sourceCanvas.height = height;
      const sourceContext = sourceCanvas.getContext('2d');
      if (!sourceContext) continue;
      sourceContext.drawImage(image as CanvasImageSource, 0, 0, width, height);
      // Clothing textures are mirrored for the X model UV layout. The mask
      // must use the same transform or one limb receives the other limb's mask.
      // Build 42.20 mask PNGs already encode coverage in their alpha channel;
      // preserving it is important because their RGB channels are labels, not
      // opacity data.
      maskContext.save();
      maskContext.translate(width, 0);
      maskContext.scale(-1, 1);
      maskContext.drawImage(sourceCanvas, 0, 0);
      maskContext.restore();
    }
    return maskCanvas;
  }

  private shouldHideBodyUnder(layer: CharacterRenderLayer): boolean {
    const key = layer.itemKey.toLowerCase();
    return !['hat', 'bandana', 'beanie', 'glass', 'eyewear', 'mask', 'necklace', 'scarf']
      .some((term) => key.includes(term));
  }

  private drawMaskedOverlay(
    target: CanvasRenderingContext2D,
    overlay: CanvasImageSource,
    layer: CharacterRenderLayer,
    textures: Map<string, Texture>,
    width: number,
    height: number,
  ): void {
    if (typeof document === 'undefined') return;
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = width;
    overlayCanvas.height = height;
    const overlayContext = overlayCanvas.getContext('2d');
    if (!overlayContext) return;
    overlayContext.translate(width, 0);
    overlayContext.scale(-1, 1);
    overlayContext.drawImage(overlay, 0, 0, width, height);

    if (!layer.maskTextureIds.length) {
      target.drawImage(overlayCanvas, 0, 0);
      return;
    }

    const maskCanvas = this.createMaskCanvas(layer, textures, width, height);
    if (!maskCanvas) return;
    overlayContext.globalCompositeOperation = 'destination-in';
    overlayContext.drawImage(maskCanvas, 0, 0);
    target.drawImage(overlayCanvas, 0, 0);
  }

  private isBodyOverlayLayer(layer: CharacterRenderLayer): boolean {
    if (layer.modelId || !layer.textureIds.length) return false;
    const key = layer.itemKey.toLowerCase();
    return ['shirt', 'tshirt', 'tanktop', 'vest', 'undershirt', 'sweater', 'jumper', 'bra']
      .some((term) => key.includes(term));
  }

  private findBodyBone(name: string): Object3D | undefined {
    for (const model of this.animatedModels) {
      const skeleton = (model as Mesh & { skeleton?: { bones: Object3D[] } }).skeleton;
      const bone = skeleton?.bones.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
      if (bone) return bone;
    }
    return undefined;
  }

  private applyTexture(root: Object3D, texture?: Texture, tint?: Color): void {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (!materials.length || materials.some((material) => !material)) {
        object.material = new MeshStandardMaterial({
          map: texture ?? null,
          color: tint ?? new Color(0xffffff),
          roughness: 0.8,
          alphaTest: texture ? 0.02 : 0,
          transparent: Boolean(texture),
        });
      } else {
        for (const material of materials) {
          if ('map' in material) {
            if (texture) material.map = texture;
            if ('color' in material) material.color = tint ?? new Color(0xffffff);
            if ('vertexColors' in material) material.vertexColors = false;
            if (texture) {
              material.alphaTest = 0.02;
              material.transparent = true;
            }
            material.needsUpdate = true;
          }
        }
      }
      object.castShadow = true;
      object.receiveShadow = true;
    });
  }

  private expandRenderedBounds(root: Object3D, bounds: Box3): void {
    root.traverse((object) => {
      if (object instanceof SkinnedMesh) {
        const position = object.geometry.getAttribute('position');
        const vertex = new Vector3();
        for (let index = 0; index < position.count; index++) {
          object.getVertexPosition(index, vertex);
          bounds.expandByPoint(vertex.applyMatrix4(object.matrixWorld));
        }
        return;
      }
      if (object instanceof Mesh) bounds.expandByObject(object);
    });
  }

  private parseModel(asset: CharacterRenderAsset, fbxLoader: FBXLoader): Promise<ParsedX> {
    if (asset.path.toLowerCase().endsWith('.fbx')) {
      return fetch(asset.dataUrl)
        .then((response) => response.arrayBuffer())
        .then((buffer) => ({ models: [fbxLoader.parse(buffer, '')], animations: [] }));
    }
    return this.parseX(asset.dataUrl);
  }

  private parseX(dataUrl: string): Promise<ParsedX> {
    return fetch(dataUrl)
      .then((response) => response.text())
      .then((text) => new Promise<ParsedX>((resolve, reject) => {
        const loader = this.createXLoader();
        try {
          loader.parse(text, (result) => {
            const parsed = result as Partial<ParsedX>;
            resolve({ models: parsed.models ?? [], animations: parsed.animations ?? [] });
          });
        } catch (error) {
          reject(error);
        }
      }));
  }

  private createXLoader(): CompatibleXLoader {
    const manager = new LoadingManager();
    const textureLoader = new TextureLoader(manager);
    textureLoader.load = (() => new Texture()) as TextureLoader['load'];
    const loader = Object.create(XLoader.prototype) as CompatibleXLoader & Record<string, unknown>;
    Object.assign(loader, {
      manager,
      crossOrigin: 'anonymous',
      path: '',
      resourcePath: '',
      requestHeader: {},
      withCredentials: false,
      debug: false,
      texloader: textureLoader,
      url: '',
      options: { putPos: true, putRot: true, putScl: true },
      _putMatLength: 0,
      _nowMat: null,
      _nowFrameName: '',
      frameHierarchie: [],
      Hierarchies: {},
      HieStack: [],
      _currentObject: {},
      _currentFrame: {},
      _data: null,
      onLoad: null,
      IsUvYReverse: true,
      Meshes: [],
      animations: [],
      animTicksPerSecond: 30,
      _currentGeo: null,
      _currentAnime: null,
      _currentAnimeFrames: null,
    });
    const prototype = XLoader.prototype as unknown as Record<string, any>;
    const originalSetMaterial = prototype['_setMaterial'] as (this: CompatibleXLoader) => void;
    loader._setMaterial = function (): void {
      const state = this as unknown as Record<string, any>;
      if (!state['_currentGeo']?.Materials) return;
      originalSetMaterial.call(this);
    };
    loader._computeGroups = function (geometry, indices): void {
      let start = 0;
      let materialIndex = indices[0] ?? 0;
      for (let index = 1; index <= indices.length; index++) {
        if (index === indices.length || indices[index] !== materialIndex) {
          geometry.addGroup(start * 3, (index - start) * 3, materialIndex);
          start = index;
          materialIndex = indices[index] ?? materialIndex;
        }
      }
    };
    const originalOutputGeometry = prototype['_makeOutputGeometry'] as (this: CompatibleXLoader) => void;
    loader._makeOutputGeometry = function (): void {
      const state = this as unknown as Record<string, any>;
      if (state['_currentGeo']?.baseFrame && !state['_currentGeo'].baseFrame.parentName) {
        state['_currentGeo'].baseFrame.parentName = 'Dummy01';
      }
      originalOutputGeometry.call(this);
    };
    return loader;
  }

  private async playAnimation(animationId: string, updateStatus = true): Promise<void> {
    const request = ++this.animationRequest;
    this.selectedAnimation = animationId;
    const asset = this.renderAssets?.animations.find((candidate) => candidate.id === animationId);
    if (!asset || !this.animatedModels.length) return;
    try {
      const parsed = await this.parseX(asset.dataUrl);
      if (request !== this.animationRequest) return;
      const animation = parsed.animations[0] as ParsedAnimation | undefined;
      if (!animation) throw new Error('Animation clip did not contain keyframes.');
      const nextActions: AnimationAction[] = [];
      const nextMixers: AnimationMixer[] = [];
      let createdActions = 0;
      for (const [modelIndex, model] of this.animatedModels.entries()) {
        const clip = this.createAnimationClip(model, animation);
        if (!clip) continue;
        const mixer = this.mixers[modelIndex] ?? new AnimationMixer(model);
        const previous = this.animationActions[modelIndex];
        const action = mixer.clipAction(clip);
        // Activate the parsed clip directly. Cross-fading an X animation can
        // leave the newly-created action at zero weight when its first frame
        // is parsed asynchronously, which makes the selector appear broken.
        if (previous && previous !== action) previous.stop();
        action.reset().setLoop(LoopRepeat, Infinity).setEffectiveTimeScale(1).setEffectiveWeight(1).play();
        mixer.update(0);
        nextMixers[modelIndex] = mixer;
        nextActions[modelIndex] = action;
        createdActions++;
      }
      if (!createdActions) throw new Error('Animation did not contain tracks for the character skeleton.');
      if (request !== this.animationRequest) return;
      this.mixers = nextMixers;
      this.animationActions = nextActions;
      this.modelGroup.updateMatrixWorld(true);
      this.refitCameraToCurrentPose();
      if (updateStatus) {
        this.statusText = 'Playing ' + animationId + ' animation · click and drag to rotate';
        this.changeDetector.markForCheck();
      }
    } catch (error) {
      if (updateStatus) {
        this.statusText = 'Animation unavailable: ' + this.errorMessage(error);
        this.changeDetector.markForCheck();
      }
    }
  }

  private createAnimationClip(model: Mesh, animation: ParsedAnimation): AnimationClip | undefined {
    const hierarchy = animation.hierarchy ?? [];
    const fps = Math.max(animation.fps ?? 4800, 1);
    // XLoader multiplies source X-frame ticks by fps while parsing. Convert its
    // resulting values back to seconds for current Three.js keyframe tracks.
    const timeScale = fps * fps;
    const tracks = [];

    const skeleton = (model as Mesh & { skeleton?: { bones: Array<{ name: string }> } }).skeleton;
    for (const bone of skeleton?.bones ?? []) {
      const source = hierarchy.find((entry) => entry.name?.trim().toLowerCase() === bone.name.trim().toLowerCase());
      const keys = source?.keys ?? [];
      if (!keys.length) continue;

      const positionTimes: number[] = [];
      const positionValues: number[] = [];
      const rotationTimes: number[] = [];
      const rotationValues: number[] = [];
      const scaleTimes: number[] = [];
      const scaleValues: number[] = [];
      for (const key of keys) {
        if (typeof key.time !== 'number') continue;
        const time = key.time / timeScale;
        if (key.pos) {
          positionTimes.push(time);
          positionValues.push(key.pos.x, key.pos.y, key.pos.z);
        }
        if (key.rot) {
          const rotation = Array.isArray(key.rot)
            ? key.rot
            : [key.rot.x, key.rot.y, key.rot.z, key.rot.w];
          if (rotation.length < 4 || rotation.slice(0, 4).some((value) => !Number.isFinite(value))) continue;
          rotationTimes.push(time);
          rotationValues.push(rotation[0], rotation[1], rotation[2], rotation[3]);
        }
        if (key.scl) {
          scaleTimes.push(time);
          scaleValues.push(key.scl.x, key.scl.y, key.scl.z);
        }
      }

      const trackName = '.bones[' + bone.name + ']';
      const positionTrack = this.sortTrack(positionTimes, positionValues, 3);
      const rotationTrack = this.sortTrack(rotationTimes, rotationValues, 4);
      const scaleTrack = this.sortTrack(scaleTimes, scaleValues, 3);
      if (positionTrack.times.length) {
        tracks.push(new VectorKeyframeTrack(trackName + '.position', positionTrack.times, positionTrack.values));
      }
      if (rotationTrack.times.length) {
        tracks.push(new QuaternionKeyframeTrack(trackName + '.quaternion', rotationTrack.times, rotationTrack.values));
      }
      if (scaleTrack.times.length) {
        tracks.push(new VectorKeyframeTrack(trackName + '.scale', scaleTrack.times, scaleTrack.values));
      }
    }

    if (!tracks.length) return undefined;
    const duration = typeof animation.length === 'number'
      ? animation.length / timeScale
      : Math.max(...tracks.flatMap((track) => Array.from(track.times)));
    return new AnimationClip(animation.name ?? 'Project Zomboid animation', duration, tracks);
  }

  private sortTrack(times: number[], values: number[], stride: number): { times: number[]; values: number[] } {
    const order = times.map((_time, index) => index).sort((left, right) => times[left] - times[right]);
    return {
      times: order.map((index) => times[index]),
      values: order.flatMap((index) => values.slice(index * stride, index * stride + stride)),
    };
  }

  private loadTexture(asset: CharacterRenderAsset): Promise<Texture> {
    return new Promise((resolve, reject) => {
      this.textureLoader.load(asset.dataUrl, resolve, undefined, reject);
    });
  }

  private clearModel(): void {
    this.animationRequest++;
    this.loadedRenderKey = '';
    this.animationActions.forEach((action) => action.stop());
    this.mixers.forEach((mixer, index) => {
      const model = this.animatedModels[index];
      if (model) mixer.uncacheRoot(model);
    });
    this.mixers = [];
    this.animationActions = [];
    this.animatedModels = [];
    this.renderAssets = null;
    this.rotating = false;
    this.rotationAnchor = undefined;
    this.hasManualPlacement = false;
    this.fittedModelSize.set(0, 0, 0);
    this.fittedTarget.set(0, 0, 0);
    this.disposeObject(this.modelGroup);
    this.modelGroup.position.set(0, 0, 0);
    this.modelGroup.rotation.set(0, 0, 0);
    this.modelGroup.scale.setScalar(1);
  }

  private renderKey(): string {
    return this.character && this.gameDir
      ? this.gameDir + '|' + JSON.stringify(this.character.visuals)
      : '';
  }

  private disposeObject(object: Object3D): void {
    while (object.children.length) {
      const child = object.children.pop();
      if (child) this.disposeObject(child);
    }
    if (object instanceof Mesh) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material?.dispose());
    }
  }

  private resize(): void {
    const host = this.viewport?.nativeElement;
    if (!host) return;
    const width = Math.max(host.clientWidth, 1);
    const height = Math.max(host.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    if (this.fittedModelSize.lengthSq() > 0) {
      this.updateCameraFit();
      this.applyZoom();
      this.alignModelToViewportCenter();
    }
  }

  private refitCameraToCurrentPose(): void {
    const bounds = new Box3();
    this.expandRenderedBounds(this.modelGroup, bounds);
    if (bounds.isEmpty()) return;
    this.fittedModelSize.copy(bounds.getSize(new Vector3()));
    this.updateCameraFit();
    this.applyZoom();
    this.alignModelToViewportCenter();
  }

  private updateCameraFit(): void {
    const host = this.viewport?.nativeElement;
    const viewportWidth = Math.max(host?.clientWidth ?? 1, 1);
    const viewportHeight = Math.max(host?.clientHeight ?? 1, 1);
    const aspect = viewportWidth / viewportHeight;
    // Fit both projected axes. Padding is applied to the measured bounds so
    // the camera, rather than a fixed canvas offset, owns the framing.
    const padding = 1.5;
    const halfFov = (this.camera.fov * Math.PI) / 360;
    const verticalDistance = (this.fittedModelSize.y * padding) / (2 * Math.tan(halfFov));
    const horizontalDistance = (this.fittedModelSize.x * padding) / (2 * Math.tan(halfFov) * aspect);
    this.fitDistance = Math.max(6, verticalDistance, horizontalDistance);
  }

  /**
   * Center the visible rendered pixels in the fixed camera viewport. This is
   * deliberately model-side placement: the camera stays fixed and cannot
   * introduce an orbit-target offset.
   */
  private alignModelToViewportCenter(): void {
    if (this.hasManualPlacement) {
      return;
    }
    this.modelGroup.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);

    const position = new Vector3();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let depthSum = 0;
    let depthCount = 0;

    this.modelGroup.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const attribute = object.geometry.getAttribute('position');
      for (let index = 0; index < attribute.count; index++) {
        object.getVertexPosition(index, position);
        position.applyMatrix4(object.matrixWorld);
        const projected = position.clone().project(this.camera);
        if (![projected.x, projected.y, projected.z].every(Number.isFinite)) continue;
        minX = Math.min(minX, projected.x);
        maxX = Math.max(maxX, projected.x);
        minY = Math.min(minY, projected.y);
        maxY = Math.max(maxY, projected.y);
        depthSum += projected.z;
        depthCount++;
      }
    });

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || depthCount === 0) return;
    const currentScreenCenter = new Vector3(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      depthSum / depthCount,
    );
    const currentWorldCenter = currentScreenCenter.clone().unproject(this.camera);
    const viewportWorldCenter = new Vector3(0, 0, currentScreenCenter.z).unproject(this.camera);
    this.modelGroup.position.add(viewportWorldCenter.sub(currentWorldCenter));
    this.modelGroup.updateMatrixWorld(true);
  }

  private applyReferencePlacement(): void {
    const bounds = new Box3();
    this.modelGroup.updateMatrixWorld(true);
    this.expandRenderedBounds(this.modelGroup, bounds);
    if (bounds.isEmpty()) return;
    this.camera.updateMatrixWorld(true);
    const modelCenter = bounds.getCenter(new Vector3());
    const projectedCenter = modelCenter.clone().project(this.camera);
    if (![projectedCenter.x, projectedCenter.y, projectedCenter.z].every(Number.isFinite)) return;
    const targetNdc = new Vector3(
      this.referenceScreenPosition.x * 2 - 1,
      1 - this.referenceScreenPosition.y * 2,
      projectedCenter.z,
    );
    const targetWorld = targetNdc.unproject(this.camera);
    this.modelGroup.position.add(targetWorld.sub(modelCenter));
    this.modelGroup.updateMatrixWorld(true);
    this.hasManualPlacement = true;
  }

  private applyZoom(): void {
    const modelAnchor = this.hasManualPlacement ? this.projectModelCenter() : undefined;
    const target = this.fittedTarget;
    const direction = this.camera.position.clone().sub(target);
    if (direction.lengthSq() < 0.0001) direction.set(0, 0, -1);
    direction.normalize();
    const zoomSpan = Math.max(3, this.fitDistance * 0.55);
    const distance = Math.max(4.5, this.fitDistance + ((20 - this.zoomLevel) / 40) * zoomSpan);
    this.camera.position.copy(target).addScaledVector(direction, distance);
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld(true);
    if (modelAnchor) this.preserveModelScreenAnchor(modelAnchor);
  }

  private projectModelCenter(): Vector3 | undefined {
    const bounds = new Box3();
    this.modelGroup.updateMatrixWorld(true);
    this.expandRenderedBounds(this.modelGroup, bounds);
    if (bounds.isEmpty()) return undefined;
    this.camera.updateMatrixWorld(true);
    const projected = bounds.getCenter(new Vector3()).project(this.camera);
    return [projected.x, projected.y, projected.z].every(Number.isFinite) ? projected : undefined;
  }

  private preserveModelScreenAnchor(anchor: Vector3): void {
    const bounds = new Box3();
    this.modelGroup.updateMatrixWorld(true);
    this.expandRenderedBounds(this.modelGroup, bounds);
    if (bounds.isEmpty()) return;
    const modelCenter = bounds.getCenter(new Vector3());
    const projectedCenter = modelCenter.clone().project(this.camera);
    if (![projectedCenter.x, projectedCenter.y, projectedCenter.z].every(Number.isFinite)) return;
    const targetWorld = new Vector3(anchor.x, anchor.y, projectedCenter.z).unproject(this.camera);
    this.modelGroup.position.add(targetWorld.sub(modelCenter));
    this.modelGroup.updateMatrixWorld(true);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.target !== this.renderer.domElement) return;
    const host = this.viewport?.nativeElement;
    const anchor = this.projectModelCenter();
    if (!host || !anchor) return;
    this.rotating = true;
    this.rotationLastX = event.clientX;
    this.rotationAnchor = anchor;
    this.hasManualPlacement = true;
    host.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.rotating || !this.rotationAnchor) return;
    const deltaX = event.clientX - this.rotationLastX;
    this.modelGroup.rotation.y += deltaX * 0.01;
    this.rotationLastX = event.clientX;
    this.modelGroup.updateMatrixWorld(true);
    this.preserveModelScreenAnchor(this.rotationAnchor);
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.rotating) return;
    const host = this.viewport?.nativeElement;
    if (host?.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    this.rotating = false;
    this.rotationAnchor = undefined;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private animate(): void {
    this.animationFrame = requestAnimationFrame(() => this.animate());
    const delta = Math.min(this.clock.getDelta(), 0.1);
    this.mixers.forEach((mixer) => mixer.update(delta));
    if (this.mixers.length) this.alignModelToViewportCenter();
    this.renderer.render(this.scene, this.camera);
  }

  private errorMessage(error: unknown): string {
    return typeof error === 'string' ? error : error instanceof Error ? error.message : 'unknown error';
  }

  private colorFromCss(value: string | null | undefined): Color | undefined {
    if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return undefined;
    return new Color(value);
  }
}
