export interface CharacterSaveSlot {
  relativePath: string;
  mode: string;
  saveName: string;
  modifiedAt: string | null;
  fileCount: number;
  sizeBytes: number;
}

export interface SaveMapMarker {
  id: string;
  name: string;
  x: number;
  y: number;
  savedAt: string | null;
  relativePath: string;
  saveName: string;
}

export interface CharacterSummary {
  id: number;
  name: string;
  source: string;
  isDead: boolean;
  worldVersion: number;
  worldX: number;
  worldY: number;
  x: number;
  y: number;
  z: number;
}

export interface CharacterSkill {
  id: string;
  category: string;
  level: number;
  xp: number | null;
}

export interface CharacterStatValue {
  id: string;
  label: string;
  value: number;
  moodleIcon: CharacterRenderAsset | null;
}

export interface CharacterBodyPart {
  id: string;
  health: number;
  cut: boolean;
  bitten: boolean;
  scratched: boolean;
  bandaged: boolean;
  bleeding: boolean;
  deepWounded: boolean;
  fakeInfected: boolean;
  infected: boolean;
  infectedWound: boolean;
  wetness: number;
  stiffness: number;
}

export interface CharacterTemperature {
  coreTemperature: number | null;
  bodyHeatGeneration: number | null;
  bodyHeatReal: number | null;
  coreHeatDelta: number | null;
  skinTemperature: number | null;
  bodyResponse: number | null;
  insulation: number | null;
}

export interface CharacterProtection {
  id: string;
  bite: number | null;
  scratch: number | null;
}

export interface CharacterInfo {
  weight: number | null;
  hoursSurvived: number | null;
  zombiesKilled: number | null;
  knownRecipes: number;
  knownMedia: number;
}

export interface CharacterBodyPartUpdate {
  id: string;
  health: number;
}

export interface CharacterEditPayload {
  stats: CharacterStatValue[];
  bodyParts: CharacterBodyPartUpdate[];
  skills: CharacterSkill[];
}

export interface CharacterVisuals {
  gender: string;
  skinColor: string | null;
  hairColor: string | null;
  beardColor: string | null;
  skinTexture: string | null;
  hairModel: string | null;
  beardModel: string | null;
  bodyHairIndex: number | null;
  clothing: string[];
  gear: string[];
  items: CharacterVisualItem[];
}

export interface CharacterVisualItem {
  fullType: string;
  clothingName: string | null;
  alternateModel: string | null;
  baseTexture: number | null;
  textureChoice: number | null;
}

export interface CharacterRenderAsset {
  id: string;
  path: string;
  dataUrl: string;
}

export interface CharacterCustomizationOption {
  id: string;
  label: string;
  slot: string | null;
}

export interface CharacterCustomizationOptions {
  hairModels: CharacterCustomizationOption[];
  beardModels: CharacterCustomizationOption[];
  clothing: CharacterCustomizationOption[];
}

export interface CharacterTrait {
  id: string;
  label: string;
  category: string;
  description: string | null;
  cost: number | null;
  icon: CharacterRenderAsset | null;
}

export interface CharacterRenderAssets {
  models: CharacterRenderAsset[];
  textures: CharacterRenderAsset[];
  clothingLayers: CharacterRenderLayer[];
  animations: CharacterRenderAsset[];
  warnings: string[];
}

export interface CharacterRenderLayer {
  itemKey: string;
  modelId: string | null;
  attachBone: string | null;
  textureIds: string[];
  selectedTexture: number | null;
  maskTextureIds: string[];
}

export interface CharacterDetails {
  summary: CharacterSummary;
  forename: string | null;
  surname: string | null;
  profession: string | null;
  professionIcon: CharacterRenderAsset | null;
  traits: CharacterTrait[];
  skills: CharacterSkill[];
  stats: CharacterStatValue[];
  info: CharacterInfo;
  health: CharacterBodyPart[];
  temperature: CharacterTemperature;
  protection: CharacterProtection[];
  visuals: CharacterVisuals;
  inventoryCount: number;
  readableStrings: string[];
  binarySize: number;
  previewSvg: string;
}

export interface CharacterSaveSnapshot {
  relativePath: string;
  mode: string;
  saveName: string;
  modifiedAt: string | null;
  fileCount: number;
  sizeBytes: number;
  characters: CharacterDetails[];
}
