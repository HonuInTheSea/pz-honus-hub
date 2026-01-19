import type { ParsedColor, ParsedItemVisual, PlayerVisualProfile } from './pz-player-parser';

export interface AvatarAsset {
  kind: 'body' | 'hair' | 'beard' | 'clothing';
  modelPaths: string[];
  texturePaths?: string[];
  overlays?: AvatarOverlay[];
  tint?: ParsedColor | null;
  hue?: number | null;
  scale?: number;
  invertX?: boolean;
}

export interface AvatarAssetSet {
  items: AvatarAsset[];
}

export interface AvatarOverlay {
  texturePaths: string[];
  tint?: ParsedColor | null;
  hue?: number | null;
}

type HairStyleDef = {
  name: string;
  texture: string;
  model: string;
};

type BeardStyleDef = {
  name: string;
  texture: string;
  model: string;
};

type ClothingItemDef = {
  maleModel: string;
  femaleModel: string;
  baseTextures: string[];
  textureChoices: string[];
  allowRandomHue: boolean;
  allowRandomTint: boolean;
};

type ModelScriptDef = {
  name: string;
  meshName: string;
  textureName: string | null;
  scale: number;
  invertX: boolean;
};

export class PzMediaResolver {
  private hairStylesPromise: Promise<Map<string, HairStyleDef>> | null = null;
  private beardStylesPromise: Promise<Map<string, BeardStyleDef>> | null = null;
  private modelScriptsPromise: Promise<Map<string, ModelScriptDef>> | null = null;
  private clothingCache = new Map<string, Promise<ClothingItemDef | null>>();
  private mediaRoots: string[];

  constructor(
    private readonly readTextFile: (path: string) => Promise<string>,
    private readonly listScriptFiles: (
      mediaDir: string,
      modMediaDir?: string,
    ) => Promise<string[]>,
    private mediaDir: string,
    private modMediaDir?: string,
  ) {
    const normalizedMedia = this.normalizeRoot(mediaDir);
    const normalizedMod = this.normalizeRoot(modMediaDir);
    this.mediaDir = normalizedMedia ?? '';
    this.modMediaDir = normalizedMod ?? undefined;
    this.mediaRoots = [normalizedMod, normalizedMedia].filter(
      (entry): entry is string => !!entry && entry.length > 0,
    );
  }

  setMediaDirs(path: string, modPath?: string): void {
    const normalizedMedia = this.normalizeRoot(path);
    const normalizedMod = this.normalizeRoot(modPath);
    this.mediaDir = normalizedMedia ?? '';
    this.modMediaDir = normalizedMod ?? undefined;
    const roots = [normalizedMod, normalizedMedia].filter(
      (entry): entry is string => !!entry && entry.length > 0,
    );
    this.mediaRoots = Array.from(new Set(roots));
    this.hairStylesPromise = null;
    this.beardStylesPromise = null;
    this.modelScriptsPromise = null;
    this.clothingCache.clear();
  }

  getMediaRoots(): string[] {
    return [...this.mediaRoots];
  }

  async resolveAvatar(profile: PlayerVisualProfile): Promise<AvatarAssetSet> {
    const female = profile.descriptor.female;
    const items: AvatarAsset[] = [];
    const bodyTexture = this.resolveSkinTexture(profile);
    const bodyScriptName = female ? 'FemaleBody' : 'MaleBody';
    const bodyScript = await this.getModelScript(bodyScriptName);
    const bodyModelPaths = bodyScript
      ? this.resolveModelFromMeshName(bodyScript.meshName)
      : this.resolveModelCandidates(
          this.joinPath('models_X', 'Skinned', female ? 'FemaleBody.X' : 'MaleBody.X'),
        );
    items.push({
      kind: 'body',
      modelPaths: bodyModelPaths,
      texturePaths: bodyTexture,
      overlays: [],
      tint: profile.visual.skinColor,
      scale: bodyScript?.scale,
      invertX: bodyScript?.invertX,
    });

    const hairTint = profile.visual.hairColor ?? profile.visual.naturalHairColor;
    const hairAsset = await this.resolveHair(profile.visual.hairModel, female, hairTint);
    if (hairAsset) {
      items.push(hairAsset);
    }

    const beardTint = profile.visual.beardColor ?? profile.visual.naturalBeardColor;
    const beardAsset = await this.resolveBeard(profile.visual.beardModel, beardTint);
    if (beardAsset) {
      items.push(beardAsset);
    }

    const { clothingAssets, bodyOverlays } = await this.resolveClothing(
      profile.visual.items,
      female,
    );
    items.push(...clothingAssets);
    const bodyAsset = items.find((item) => item.kind === 'body');
    if (bodyAsset && bodyOverlays.length) {
      bodyAsset.overlays = bodyOverlays;
    }

    return { items };
  }

  private resolveSkinTexture(profile: PlayerVisualProfile): string[] {
    const bipedTexture = profile.visual.bipedVisual?.texture?.trim();
    if (bipedTexture) {
      return this.resolveTextureCandidates(this.texturePathFromName(bipedTexture, 'Body'));
    }
    const name = (profile.visual.skinTextureName ?? '').trim();
    if (name) {
      return this.resolveTextureCandidates(this.texturePathFromName(name, 'Body'));
    }
    const fallback = profile.descriptor.female ? 'FemaleBody02a' : 'MaleBody02a';
    return this.resolveTextureCandidates(this.texturePathFromName(fallback, 'Body'));
  }

  private async resolveHair(
    styleName: string | null,
    female: boolean,
    tint: ParsedColor | null,
  ): Promise<AvatarAsset | null> {
    const style = (styleName ?? '').trim();
    if (!style) {
      return null;
    }
    const hairStyles = await this.loadHairStyles();
    const def = hairStyles.get(style.toLowerCase());
    if (!def || !def.model) {
      return null;
    }
    const modelName = female ? `F_Hair_${style}` : `Bob_Hair_${style}`;
    const modelCandidate = def.model || modelName;
    const modelResolved = await this.resolveModelEntry(modelCandidate, ['models_X', 'Skinned', 'Hair']);
    return {
      kind: 'hair',
      modelPaths: modelResolved.paths,
      texturePaths: def
        ? this.resolveTextureCandidates(this.texturePathFromName(def.texture, ''))
        : modelResolved.textureName
          ? this.resolveTextureCandidates(this.texturePathFromName(modelResolved.textureName, ''))
          : [],
      tint,
      scale: modelResolved.scale,
      invertX: modelResolved.invertX,
    };
  }

  private async resolveBeard(
    styleName: string | null,
    tint: ParsedColor | null,
  ): Promise<AvatarAsset | null> {
    const style = (styleName ?? '').trim();
    if (!style || style.toLowerCase() === 'none') {
      return null;
    }
    const beardStyles = await this.loadBeardStyles();
    const def = beardStyles.get(style.toLowerCase());
    const modelName = `Bob_Beard_${style}`;
    const modelCandidate = def?.model || modelName;
    const modelResolved = await this.resolveModelEntry(modelCandidate, ['models_X', 'Skinned', 'Beards']);
    return {
      kind: 'beard',
      modelPaths: modelResolved.paths,
      texturePaths: def
        ? this.resolveTextureCandidates(this.texturePathFromName(def.texture, ''))
        : modelResolved.textureName
          ? this.resolveTextureCandidates(this.texturePathFromName(modelResolved.textureName, ''))
          : [],
      tint,
      scale: modelResolved.scale,
      invertX: modelResolved.invertX,
    };
  }

  private async resolveClothing(
    items: ParsedItemVisual[],
    female: boolean,
  ): Promise<{ clothingAssets: AvatarAsset[]; bodyOverlays: AvatarOverlay[] }> {
    const clothingAssets: AvatarAsset[] = [];
    const bodyOverlays: AvatarOverlay[] = [];
    for (const item of items) {
      const def = await this.loadClothingItem(item);
      if (!def) {
        continue;
      }
      const modelValue = female ? def.femaleModel : def.maleModel;
      let texturePaths = this.resolveClothingTexture(def, item);
      if (modelValue) {
        const modelResolved = await this.resolveModelEntry(modelValue);
        if (texturePaths.length === 0 && modelResolved.textureName) {
          texturePaths = this.resolveTextureCandidates(
            this.texturePathFromName(modelResolved.textureName, ''),
          );
        }
        clothingAssets.push({
          kind: 'clothing',
          modelPaths: modelResolved.paths,
          texturePaths,
          tint: item.tint,
          hue: item.hue,
          scale: modelResolved.scale,
          invertX: modelResolved.invertX,
        });
      } else if (texturePaths.length > 0) {
        bodyOverlays.push({
          texturePaths,
          tint: item.tint,
          hue: item.hue,
        });
      }
    }
    return { clothingAssets, bodyOverlays };
  }

  private resolveClothingTexture(def: ClothingItemDef, item: ParsedItemVisual): string[] {
    const baseTextures = def.baseTextures;
    const choiceTextures = def.textureChoices;
    if (baseTextures.length > 0) {
      const index = item.baseTexture ?? 0;
      const rel = baseTextures[index] ?? baseTextures[0];
      return this.resolveTextureCandidates(this.texturePathFromName(rel, ''));
    }
    if (choiceTextures.length > 0) {
      const index = item.textureChoice ?? 0;
      const rel = choiceTextures[index] ?? choiceTextures[0];
      return this.resolveTextureCandidates(this.texturePathFromName(rel, ''));
    }
    return [];
  }

  private async loadHairStyles(): Promise<Map<string, HairStyleDef>> {
    if (this.hairStylesPromise) {
      return this.hairStylesPromise;
    }
    this.hairStylesPromise = (async () => {
      const xml = await this.readTextFromRoots(this.joinPath('hairStyles', 'hairStyles.xml'));
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const map = new Map<string, HairStyleDef>();
      const nodes = Array.from(doc.querySelectorAll('male, female'));
      for (const node of nodes) {
        const name = this.text(node, 'name');
        if (!name) {
          continue;
        }
      const texture = this.text(node, 'texture') || 'F_Hair_White';
      const model = this.text(node, 'model');
      map.set(name.toLowerCase(), { name, texture, model });
      }
      return map;
    })();
    return this.hairStylesPromise;
  }

  private async loadBeardStyles(): Promise<Map<string, BeardStyleDef>> {
    if (this.beardStylesPromise) {
      return this.beardStylesPromise;
    }
    this.beardStylesPromise = (async () => {
      const xml = await this.readTextFromRoots(this.joinPath('hairStyles', 'beardStyles.xml'));
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const map = new Map<string, BeardStyleDef>();
      const nodes = Array.from(doc.querySelectorAll('style'));
      for (const node of nodes) {
        const name = this.text(node, 'name');
        if (!name) {
          continue;
        }
      const texture = this.text(node, 'texture') || 'F_Hair_White';
      const model = this.text(node, 'model');
      map.set(name.toLowerCase(), { name, texture, model });
      }
      return map;
    })();
    return this.beardStylesPromise;
  }

  private async loadClothingItem(item: ParsedItemVisual): Promise<ClothingItemDef | null> {
    const name = this.getClothingItemName(item);
    if (!name) {
      return null;
    }
    if (this.clothingCache.has(name)) {
      return this.clothingCache.get(name) ?? null;
    }
    const promise = (async () => {
      try {
        const xml = await this.readTextFromRoots(
          this.joinPath('clothing', 'clothingItems', `${name}.xml`),
        );
        return this.parseClothingXml(xml);
      } catch {
        return null;
      }
    })();
    this.clothingCache.set(name, promise);
    return promise;
  }

  private getClothingItemName(item: ParsedItemVisual): string | null {
    if (item.clothingItemName) {
      return item.clothingItemName;
    }
    if (item.fullType && item.fullType.includes('.')) {
      return item.fullType.split('.').pop() ?? null;
    }
    return item.fullType || null;
  }

  private parseClothingXml(xml: string): ClothingItemDef {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const root = doc.querySelector('clothingItem');
    if (!root) {
      return {
        maleModel: '',
        femaleModel: '',
        baseTextures: [],
        textureChoices: [],
        allowRandomHue: false,
        allowRandomTint: false,
      };
    }
    const maleModel = this.text(root, 'm_MaleModel');
    const femaleModel = this.text(root, 'm_FemaleModel');
    const baseTextures = this.textList(root, 'm_BaseTextures', 'baseTextures');
    const textureChoices = this.textList(root, 'textureChoices', 'm_TextureChoices');
    const allowRandomHue = this.text(root, 'm_AllowRandomHue') === 'true';
    const allowRandomTint = this.text(root, 'm_AllowRandomTint') === 'true';
    return {
      maleModel,
      femaleModel,
      baseTextures,
      textureChoices,
      allowRandomHue,
      allowRandomTint,
    };
  }

  private modelPathFromDefinition(model: string): string {
    const normalized = model.replace(/[\\/]+/g, '\\').replace(/^\\+/, '');
    if (normalized.toLowerCase().endsWith('.x')) {
      return normalized;
    }
    return normalized + '.X';
  }

  private texturePathFromName(name: string, category: string): string {
    const trimmed = name.replace(/[\\/]+/g, '\\').replace(/^\\+/, '');
    const fileName = trimmed.toLowerCase().endsWith('.png') ? trimmed : `${trimmed}.png`;
    if (category) {
      return this.joinPath('textures', category, fileName);
    }
    return this.joinPath('textures', fileName);
  }

  private text(node: Element, tag: string): string {
    const value = node.querySelector(tag)?.textContent ?? '';
    return value.trim();
  }

  private textList(node: Element, ...tags: string[]): string[] {
    const values: string[] = [];
    for (const tag of tags) {
      const entries = Array.from(node.querySelectorAll(tag));
      for (const entry of entries) {
        const text = entry.textContent?.trim();
        if (text) {
          values.push(text);
        }
      }
    }
    return values;
  }

  private joinPath(...parts: string[]): string {
    return parts
      .map((part) => part.replace(/[\\/]+$/g, ''))
      .filter((part) => part.length > 0)
      .join('\\');
  }

  private resolveModelFromMeshName(meshName: string): string[] {
    const normalized = meshName.replace(/[\\/]+/g, '\\').replace(/^\\+/, '');
    const [pathOnly] = normalized.split('|');
    const withExt = /\.[^\\.]+$/i.test(pathOnly) ? pathOnly : `${pathOnly}.X`;
    const rel = this.joinPath('models_X', withExt);
    const relFbx = rel.replace(/\.x$/i, '.fbx').replace('\\models_X\\', '\\models\\');
    const relGltf = rel.replace(/\.x$/i, '.gltf').replace('\\models_X\\', '\\models\\');
    const candidates: string[] = [];
    for (const root of this.mediaRoots) {
      candidates.push(this.joinPath(root, relFbx));
      candidates.push(this.joinPath(root, relGltf));
      candidates.push(this.joinPath(root, rel));
    }
    return candidates;
  }

  private resolveModelCandidates(relativePath: string): string[] {
    const normalized = relativePath.replace(/[\\/]+/g, '\\').replace(/^\\+/, '');
    const candidates: string[] = [];
    const hasExt = /\.[^\\.]+$/i.test(normalized);
    const withX = hasExt ? normalized : `${normalized}.X`;
    const withFbx = withX.replace(/\.x$/i, '.fbx');
    const withGltf = withX.replace(/\.x$/i, '.gltf');
    for (const root of this.mediaRoots) {
      if (withFbx.toLowerCase() !== withX.toLowerCase()) {
        candidates.push(this.joinPath(root, withFbx));
      }
      if (withGltf.toLowerCase() !== withX.toLowerCase()) {
        candidates.push(this.joinPath(root, withGltf));
      }
      candidates.push(this.joinPath(root, withX));
    }
    return candidates;
  }

  private resolveTextureCandidates(relativePath: string): string[] {
    const normalized = relativePath.replace(/[\\/]+/g, '\\').replace(/^\\+/, '');
    return this.mediaRoots.map((root) => this.joinPath(root, normalized));
  }

  private async readTextFromRoots(relativePath: string): Promise<string> {
    let lastError: unknown = null;
    for (const root of this.mediaRoots) {
      const candidate = this.joinPath(root, relativePath);
      try {
        return await this.readTextFile(candidate);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError ?? new Error(`Unable to read file: ${relativePath}`);
  }

  private normalizeRoot(value?: string | null): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const cleaned = trimmed.replace(/\//g, '\\').replace(/[\\/]+$/g, '');
    const lower = cleaned.toLowerCase();
    if (lower.endsWith('\\media')) {
      return cleaned;
    }
    const marker = '\\media\\';
    const idx = lower.lastIndexOf(marker);
    if (idx >= 0) {
      return cleaned.slice(0, idx + marker.length - 1);
    }
    return cleaned;
  }

  private async getModelScript(name: string): Promise<ModelScriptDef | null> {
    const scripts = await this.loadModelScripts();
    return scripts.get(name.toLowerCase()) ?? null;
  }

  private async loadModelScripts(): Promise<Map<string, ModelScriptDef>> {
    if (this.modelScriptsPromise) {
      return this.modelScriptsPromise;
    }
    this.modelScriptsPromise = (async () => {
      const map = new Map<string, ModelScriptDef>();
      if (!this.listScriptFiles) {
        return map;
      }
      let files: string[] = [];
      try {
        files = await this.listScriptFiles(this.mediaDir, this.modMediaDir);
      } catch {
        return map;
      }
      for (const file of files) {
        try {
          const text = await this.readTextFile(file);
          const defs = this.parseModelScripts(text);
          for (const def of defs) {
            map.set(def.name.toLowerCase(), def);
          }
        } catch {
          // ignore unreadable script files
        }
      }
      return map;
    })();
    return this.modelScriptsPromise;
  }

  private parseModelScripts(text: string): ModelScriptDef[] {
    const out: ModelScriptDef[] = [];
    const lines = text.split(/\r?\n/);
    let currentName: string | null = null;
    let blockLines: string[] = [];
    let braceCount = 0;
    const flush = () => {
      if (!currentName) {
        return;
      }
      const def = this.parseModelBlock(currentName, blockLines.join('\n'));
      if (def) {
        out.push(def);
      }
      currentName = null;
      blockLines = [];
      braceCount = 0;
    };

    for (const rawLine of lines) {
      const line = rawLine.split('//')[0].trim();
      if (!line) {
        continue;
      }
      if (!currentName) {
        const match = line.match(/^model\s+([^\s{]+)/i);
        if (match) {
          currentName = match[1].trim();
          braceCount += (line.match(/{/g) ?? []).length;
          braceCount -= (line.match(/}/g) ?? []).length;
          blockLines.push(line);
          if (braceCount === 0 && line.includes('{')) {
            flush();
          }
          continue;
        }
      } else {
        blockLines.push(line);
        braceCount += (line.match(/{/g) ?? []).length;
        braceCount -= (line.match(/}/g) ?? []).length;
        if (braceCount <= 0) {
          flush();
        }
      }
    }
    flush();
    return out;
  }

  private parseModelBlock(name: string, block: string): ModelScriptDef | null {
    const getValue = (key: string): string | null => {
      const regex = new RegExp(`${key}\\s*=\\s*([^\\n\\r]+)`, 'i');
      const match = block.match(regex);
      if (!match) {
        return null;
      }
      return match[1]
        .replace(/[;,]$/, '')
        .trim()
        .replace(/^\"|\"$/g, '');
    };
    const meshName = getValue('mesh');
    if (!meshName) {
      return null;
    }
    const textureName = getValue('texture');
    const scaleRaw = getValue('scale');
    const invertRaw = getValue('invertx');
    const scale = scaleRaw ? Number.parseFloat(scaleRaw) : 1;
    const invertX = invertRaw ? invertRaw.toLowerCase() === 'true' : false;
    return {
      name,
      meshName,
      textureName,
      scale: Number.isFinite(scale) ? scale : 1,
      invertX,
    };
  }

  private async resolveModelEntry(
    modelValue: string,
    fallbackParts?: string[],
  ): Promise<{ paths: string[]; scale?: number; invertX?: boolean; textureName?: string | null }> {
    const trimmed = modelValue.trim();
    if (!trimmed) {
      return { paths: [] };
    }
    const hasPath = /[\\/]/.test(trimmed) || /\.[^\\.]+$/i.test(trimmed);
    if (!hasPath) {
      const script = await this.getModelScript(trimmed);
      if (script) {
        return {
          paths: this.resolveModelFromMeshName(script.meshName),
          scale: script.scale,
          invertX: script.invertX,
          textureName: script.textureName ?? undefined,
        };
      }
      const fallback = fallbackParts
        ? this.joinPath(...fallbackParts, `${trimmed}.X`)
        : this.joinPath('models_X', this.modelPathFromDefinition(trimmed));
      return { paths: this.resolveModelCandidates(fallback) };
    }
    const rel = this.modelPathFromDefinition(trimmed);
    const relPath = fallbackParts ? this.joinPath(...fallbackParts, rel) : this.joinPath('models_X', rel);
    return { paths: this.resolveModelCandidates(relPath) };
  }
}
