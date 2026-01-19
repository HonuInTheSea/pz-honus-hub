import { convertFileSrc } from '@tauri-apps/api/core';
import * as THREE from 'three';
import { FBXLoader, XLoader } from 'three-stdlib';
import type { AvatarAsset, AvatarAssetSet } from './pz-media-resolver';
import type { ParsedColor, ParsedItemVisual, PlayerVisualProfile } from './pz-player-parser';
import type { PzMediaResolver } from './pz-media-resolver';

const DEFAULT_SKIN = new THREE.Color(0xe0c6b5);
const DEFAULT_HAIR = new THREE.Color(0x3b2f2f);
const DEFAULT_CLOTH = new THREE.Color(0x5a6675);
const TARGET_HEIGHT = 1.7;

export class AvatarRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private root: THREE.Group;
  private assetGroup: THREE.Group;
  private fallbackGroup: THREE.Group;
  private skinMaterial: THREE.MeshStandardMaterial;
  private hairMaterial: THREE.MeshStandardMaterial;
  private beardMaterial: THREE.MeshStandardMaterial;
  private upperMaterial: THREE.MeshStandardMaterial;
  private lowerMaterial: THREE.MeshStandardMaterial;
  private resizeObserver: ResizeObserver;
  private animId = 0;
  private spin = 0;
  private loadToken = 0;
  private xLoader: XLoader;
  private fbxLoader: FBXLoader;
  private fbxManager: THREE.LoadingManager;
  private textureLoader: THREE.TextureLoader;
  private modelCache = new Map<string, Promise<THREE.Group>>();
  private textureCache = new Map<string, THREE.Texture>();

  constructor(
    private readonly host: HTMLElement,
    private readonly onLog?: (message: string) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio ?? 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.host.innerHTML = '';
    this.host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(0, 1.6, 3.1);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(2, 3, 4);
    const fill = new THREE.DirectionalLight(0xbad7ff, 0.4);
    fill.position.set(-2, 1.5, 2);
    this.scene.add(ambient, key, fill);

    this.skinMaterial = new THREE.MeshStandardMaterial({ color: DEFAULT_SKIN });
    this.hairMaterial = new THREE.MeshStandardMaterial({ color: DEFAULT_HAIR });
    this.beardMaterial = new THREE.MeshStandardMaterial({ color: DEFAULT_HAIR });
    this.upperMaterial = new THREE.MeshStandardMaterial({ color: DEFAULT_CLOTH });
    this.lowerMaterial = new THREE.MeshStandardMaterial({ color: DEFAULT_CLOTH });

    this.root = new THREE.Group();
    this.root.position.y = -0.2;
    this.assetGroup = new THREE.Group();
    this.fallbackGroup = new THREE.Group();
    this.root.add(this.assetGroup, this.fallbackGroup);
    this.scene.add(this.root);
    this.buildFallbackRig();
    this.resize();

    this.xLoader = createXLoader();
    this.fbxManager = new THREE.LoadingManager();
    this.fbxLoader = new FBXLoader(this.fbxManager);
    this.textureLoader = new THREE.TextureLoader();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.host);
    this.animate();
  }

  setProfile(profile: PlayerVisualProfile | null, resolver?: PzMediaResolver): void {
    this.loadToken += 1;
    const token = this.loadToken;
    this.clearAssets();
    this.log(`profile=${profile ? 'ok' : 'none'} resolver=${resolver ? 'ok' : 'none'}`);
    if (!profile || !resolver) {
      this.fallbackGroup.visible = true;
      this.updateFallbackColors(null);
      return;
    }
    this.updateFallbackColors(profile);
    this.fallbackGroup.visible = true;
    resolver
      .resolveAvatar(profile)
      .then((assets) => {
        if (this.loadToken !== token) {
          return;
        }
        this.log(`assets=${assets.items.length}`);
        return this.loadAssets(assets, token);
      })
      .catch((err) => {
        if (this.loadToken !== token) {
          return;
        }
        this.log(`resolve error: ${String(err)}`);
        this.clearAssets();
      });
  }

  private updateFallbackColors(profile: PlayerVisualProfile | null): void {
    if (!profile) {
      this.skinMaterial.color.copy(DEFAULT_SKIN);
      this.hairMaterial.color.copy(DEFAULT_HAIR);
      this.beardMaterial.color.copy(DEFAULT_HAIR);
      this.upperMaterial.color.copy(DEFAULT_CLOTH);
      this.lowerMaterial.color.copy(DEFAULT_CLOTH);
      return;
    }
    const visual = profile.visual;
    this.skinMaterial.color.copy(toColor(visual.skinColor, DEFAULT_SKIN));
    this.hairMaterial.color.copy(
      toColor(visual.hairColor ?? visual.naturalHairColor, DEFAULT_HAIR),
    );
    this.beardMaterial.color.copy(
      toColor(visual.beardColor ?? visual.naturalBeardColor, DEFAULT_HAIR),
    );
    const [upper, lower] = pickClothingColors(visual.items);
    this.upperMaterial.color.copy(upper);
    this.lowerMaterial.color.copy(lower);
  }

  destroy(): void {
    cancelAnimationFrame(this.animId);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.host.innerHTML = '';
  }

  private buildFallbackRig(): void {
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 32, 32), this.skinMaterial);
    head.position.set(0, 1.35, 0);

    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.23, 32, 32, 0, Math.PI * 2, 0, Math.PI * 0.55), this.hairMaterial);
    hair.position.set(0, 1.38, 0.01);

    const beard = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 0.18, 24), this.beardMaterial);
    beard.position.set(0, 1.17, 0.05);
    beard.rotation.x = Math.PI * 0.08;

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 0.6, 32), this.upperMaterial);
    torso.position.set(0, 0.85, 0);

    const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.25, 24), this.lowerMaterial);
    hips.position.set(0, 0.5, 0);

    const legLeft = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.6, 18), this.lowerMaterial);
    legLeft.position.set(-0.12, 0.1, 0);

    const legRight = legLeft.clone();
    legRight.position.set(0.12, 0.1, 0);

    const armLeft = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.5, 16), this.upperMaterial);
    armLeft.position.set(-0.38, 0.9, 0);
    armLeft.rotation.z = Math.PI * 0.2;

    const armRight = armLeft.clone();
    armRight.position.set(0.38, 0.9, 0);
    armRight.rotation.z = -Math.PI * 0.2;

    this.fallbackGroup.add(head, hair, beard, torso, hips, legLeft, legRight, armLeft, armRight);
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  private animate(): void {
    this.spin += 0.003;
    this.root.rotation.y = this.spin;
    this.renderer.render(this.scene, this.camera);
    this.animId = requestAnimationFrame(() => this.animate());
  }

  private async loadAssets(assets: AvatarAssetSet, token: number): Promise<void> {
    const bodyAsset = assets.items.find((item) => item.kind === 'body');
    if (bodyAsset) {
      try {
        const body = await this.loadModel(bodyAsset);
        if (this.loadToken !== token) {
          return;
        }
        this.assetGroup.add(body);
        this.scaleToHeight(body, TARGET_HEIGHT);
        await this.applyBodyOverlays(bodyAsset);
      } catch (err) {
        this.log(`body model failed: ${String(err)}`);
      }
    }

    const extraAssets = assets.items.filter((item) => item.kind !== 'body');
    for (const asset of extraAssets) {
      try {
        const model = await this.loadModel(asset);
        if (this.loadToken !== token) {
          return;
        }
        this.assetGroup.add(model);
      } catch (err) {
        this.log(`asset model failed: ${String(err)}`);
      }
    }
    this.fallbackGroup.visible = this.assetGroup.children.length === 0;
  }

  private async loadModel(asset: AvatarAsset): Promise<THREE.Group> {
    const model = await this.getModel(asset.modelPaths, asset.texturePaths);
    this.applyMaterialOverrides(model, asset);
    if (asset.scale && Number.isFinite(asset.scale)) {
      model.scale.multiplyScalar(asset.scale);
    }
    if (asset.invertX) {
      model.scale.x *= -1;
    }
    return model;
  }

  private async getModel(modelPaths: string[], texturePaths?: string[]): Promise<THREE.Group> {
    let lastError: unknown = null;
    for (const modelPath of modelPaths) {
      this.log(`load model: ${modelPath}`);
      if (!this.modelCache.has(modelPath)) {
        const loadPromise = new Promise<THREE.Group>((resolve, reject) => {
          const modelUrl = convertFileSrc(modelPath);
          if (modelPath.toLowerCase().endsWith('.fbx')) {
            const baseDir = this.dirname(modelPath);
            const baseUrl = ensureTrailingSlash(convertFileSrc(baseDir));
            const fileName = this.basename(modelPath);
            this.fbxLoader.setPath(baseUrl);
            this.fbxLoader.setResourcePath(baseUrl);
            this.fbxManager.setURLModifier((url) => resolveFbxUrl(baseDir, url));
            this.fbxLoader.load(
              fileName,
              (obj) => resolve(obj as THREE.Group),
              undefined,
              (err) => reject(err),
            );
            return;
          }
          const loader = this.xLoader;
          (loader as any).path = '';
          const texturePath = this.pickFirst(texturePaths);
          if (texturePath) {
            const textureDir = this.dirname(texturePath);
            (loader as any).resourcePath = ensureTrailingSlash(convertFileSrc(textureDir));
          } else {
            (loader as any).resourcePath = '';
          }
          loader.load(
            modelUrl,
            (obj) => {
              const resolved = resolveXResult(obj);
              if (resolved) {
                resolve(resolved);
              } else {
                reject(new Error('Failed to resolve X model'));
              }
            },
            undefined,
            (err) => reject(err),
          );
        });
        this.modelCache.set(modelPath, loadPromise);
      }
      try {
        const loaded = await this.modelCache.get(modelPath)!;
        this.log(`loaded model: ${modelPath}`);
        return loaded.clone(true);
      } catch (err) {
        this.log(`model error: ${modelPath} -> ${String(err)}`);
        lastError = err;
      }
    }
    throw lastError ?? new Error('Failed to load model');
  }

  private applyMaterialOverrides(model: THREE.Group, asset: AvatarAsset): void {
    const color = asset.tint
      ? toColor(asset.tint, DEFAULT_CLOTH)
      : asset.hue !== null && asset.hue !== undefined
        ? hueToColor(asset.hue)
        : null;
    const texture = asset.texturePaths ? this.getTexture(this.pickFirst(asset.texturePaths)) : null;
    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      const mesh = child as THREE.Mesh;
      const material = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of material) {
        if (mat && 'color' in mat) {
          if (color) {
            (mat as THREE.MeshStandardMaterial).color.copy(color);
          }
          if (texture) {
            (mat as THREE.MeshStandardMaterial).map = texture;
            (mat as THREE.MeshStandardMaterial).needsUpdate = true;
          }
        }
      }
    });
  }

  private getTexture(path: string | null): THREE.Texture | null {
    if (!path) {
      return null;
    }
    const cached = this.textureCache.get(path);
    if (cached) {
      return cached;
    }
    const texture = this.textureLoader.load(convertFileSrc(path));
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textureCache.set(path, texture);
    return texture;
  }

  private clearAssets(): void {
    while (this.assetGroup.children.length > 0) {
      const child = this.assetGroup.children.pop();
      if (child) {
        child.removeFromParent();
      }
    }
    this.assetGroup.scale.setScalar(1);
  }

  private scaleToHeight(model: THREE.Object3D, target: number): void {
    this.assetGroup.scale.setScalar(1);
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    if (size.y <= 0.0001) {
      return;
    }
    const scale = target / size.y;
    this.assetGroup.scale.setScalar(scale);
  }

  private dirname(path: string): string {
    const normalized = path.replace(/[\\/]+/g, '\\');
    const idx = normalized.lastIndexOf('\\');
    if (idx === -1) {
      return normalized;
    }
    return normalized.slice(0, idx);
  }

  private basename(path: string): string {
    const normalized = path.replace(/[\\/]+/g, '\\');
    const idx = normalized.lastIndexOf('\\');
    if (idx === -1) {
      return normalized;
    }
    return normalized.slice(idx + 1);
  }

  private pickFirst(paths?: string[]): string | null {
    if (!paths || paths.length === 0) {
      return null;
    }
    return paths[0];
  }

  private async applyBodyOverlays(asset: AvatarAsset): Promise<void> {
    if (!asset.overlays || !asset.texturePaths?.length) {
      return;
    }
    const baseCandidates = asset.texturePaths ?? [];
    if (baseCandidates.length === 0) {
      return;
    }
    const texture = await this.composeTexture(baseCandidates, asset.overlays);
    if (!texture) {
      this.log('overlay failed: no texture generated');
      return;
    }
    this.assetGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        const material = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of material) {
          if (mat && 'map' in mat) {
            (mat as THREE.MeshStandardMaterial).map = texture;
            (mat as THREE.MeshStandardMaterial).needsUpdate = true;
          }
        }
      }
    });
    this.log('overlay applied');
  }

  private async composeTexture(
    baseCandidates: string[],
    overlays: AvatarAsset['overlays'],
  ): Promise<THREE.Texture | null> {
    if (!overlays) {
      return null;
    }
    const baseImage = await this.loadImageCandidates(baseCandidates);
    if (!baseImage) {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = baseImage.width;
    canvas.height = baseImage.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }
    ctx.drawImage(baseImage, 0, 0);
    for (const overlay of overlays) {
      if (!overlay.texturePaths.length) {
        continue;
      }
      const overlayImage = await this.loadImageCandidates(overlay.texturePaths);
      if (!overlayImage) {
        continue;
      }
      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = baseImage.width;
      overlayCanvas.height = baseImage.height;
      const overlayCtx = overlayCanvas.getContext('2d');
      if (!overlayCtx) {
        continue;
      }
      overlayCtx.drawImage(overlayImage, 0, 0, baseImage.width, baseImage.height);
      const tintColor = overlay.tint ? toColor(overlay.tint, DEFAULT_CLOTH) : null;
      const hueColor =
        overlay.hue !== null && overlay.hue !== undefined ? hueToColor(overlay.hue) : null;
      const overlayTint = tintColor ?? hueColor;
      if (overlayTint) {
        overlayCtx.globalCompositeOperation = 'multiply';
        overlayCtx.fillStyle = `#${overlayTint.getHexString()}`;
        overlayCtx.fillRect(0, 0, baseImage.width, baseImage.height);
        overlayCtx.globalCompositeOperation = 'destination-in';
        overlayCtx.drawImage(overlayImage, 0, 0, baseImage.width, baseImage.height);
      }
      ctx.drawImage(overlayCanvas, 0, 0);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private loadImage(path: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = convertFileSrc(path);
    });
  }

  private async loadImageCandidates(paths: string[]): Promise<HTMLImageElement | null> {
    for (const path of paths) {
      this.log(`load texture: ${path}`);
      const img = await this.loadImage(path);
      if (img) {
        this.log(`loaded texture: ${path}`);
        return img;
      }
    }
    return null;
  }

  private log(message: string): void {
    if (this.onLog) {
      this.onLog(message);
    }
  }
}

function toColor(color: ParsedColor | null, fallback: THREE.Color): THREE.Color {
  if (!color) {
    return fallback.clone();
  }
  return new THREE.Color(color.r / 255, color.g / 255, color.b / 255);
}

function pickClothingColors(items: ParsedItemVisual[]): [THREE.Color, THREE.Color] {
  const upper = items[0] ? itemToColor(items[0]) : DEFAULT_CLOTH.clone();
  const lower = items[1] ? itemToColor(items[1]) : DEFAULT_CLOTH.clone();
  return [upper, lower];
}

function itemToColor(item: ParsedItemVisual): THREE.Color {
  if (item.tint) {
    return new THREE.Color(item.tint.r / 255, item.tint.g / 255, item.tint.b / 255);
  }
  if (item.hue !== null) {
    const hue = (item.hue + 1) / 2;
    const color = new THREE.Color();
    color.setHSL(hue, 0.6, 0.5);
    return color;
  }
  return DEFAULT_CLOTH.clone();
}

function hueToColor(hue: number): THREE.Color {
  const normalized = (hue + 1) / 2;
  const color = new THREE.Color();
  color.setHSL(normalized, 0.6, 0.5);
  return color;
}

function ensureTrailingSlash(value: string): string {
  if (!value.endsWith('/')) {
    return `${value}/`;
  }
  return value;
}

function resolveFbxUrl(baseDir: string, url: string): string {
  const normalized = url.replace(/\\/g, '/');
  if (isWebUrl(normalized)) {
    return url;
  }
  if (isAbsolutePath(normalized)) {
    return convertFileSrc(normalized);
  }
  const joined = joinFsPath(baseDir, normalized);
  return convertFileSrc(joined);
}

function isWebUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('data:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('file:')
  );
}

function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function joinFsPath(baseDir: string, relative: string): string {
  const base = baseDir.replace(/[\\/]+$/g, '');
  const rel = relative.replace(/^[/\\]+/g, '');
  return `${base}\\${rel}`.replace(/\//g, '\\');
}

function resolveXResult(result: unknown): THREE.Group | null {
  if (result instanceof THREE.Group) {
    return result;
  }
  if (result instanceof THREE.Object3D) {
    const group = new THREE.Group();
    group.add(result);
    return group;
  }
  const candidate = result as { scene?: unknown; object?: unknown };
  if (candidate?.scene instanceof THREE.Group) {
    return candidate.scene;
  }
  if (candidate?.object instanceof THREE.Group) {
    return candidate.object;
  }
  if (candidate?.scene instanceof THREE.Object3D) {
    const group = new THREE.Group();
    group.add(candidate.scene);
    return group;
  }
  if (candidate?.object instanceof THREE.Object3D) {
    const group = new THREE.Group();
    group.add(candidate.object);
    return group;
  }
  return null;
}

function createXLoader(): XLoader {
  const loader = Object.create(XLoader.prototype) as XLoader;
  const manager = THREE.DefaultLoadingManager;
  const loaderAny = loader as any;
  loaderAny.manager = manager;
  loaderAny.crossOrigin = 'anonymous';
  loaderAny.path = '';
  loaderAny.resourcePath = '';
  loaderAny.requestHeader = {};
  loaderAny.withCredentials = false;
  loaderAny.debug = false;
  loaderAny.texloader = new THREE.TextureLoader(manager);
  loaderAny.url = '';
  loaderAny._putMatLength = 0;
  loaderAny._nowMat = null;
  loaderAny._nowFrameName = '';
  loaderAny.frameHierarchie = [];
  loaderAny.Hierarchies = {};
  loaderAny.HieStack = [];
  loaderAny._currentObject = {};
  loaderAny._currentFrame = {};
  loaderAny._data = null;
  loaderAny.onLoad = null;
  loaderAny.IsUvYReverse = true;
  loaderAny.Meshes = [];
  loaderAny.animations = [];
  loaderAny.animTicksPerSecond = 30;
  loaderAny._currentGeo = null;
  loaderAny._currentAnime = null;
  loaderAny._currentAnimeFrames = null;
  return loader;
}
