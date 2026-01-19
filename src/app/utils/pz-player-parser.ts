export interface ParsedColor {
  r: number;
  g: number;
  b: number;
}

export interface ParsedItemVisual {
  fullType: string;
  alternateModelName: string;
  clothingItemName: string;
  tint: ParsedColor | null;
  baseTexture: number | null;
  textureChoice: number | null;
  hue: number | null;
  decal: string | null;
  blood: number[];
  dirt: number[];
  holes: number[];
  basicPatches: number[];
  denimPatches: number[];
  leatherPatches: number[];
}

export interface ParsedHumanVisual {
  hairColor: ParsedColor | null;
  beardColor: ParsedColor | null;
  skinColor: ParsedColor | null;
  bodyHair: number;
  skinTexture: number;
  zombieRotStage: number;
  skinTextureName: string | null;
  beardModel: string | null;
  hairModel: string | null;
  blood: number[];
  dirt: number[];
  holes: number[];
  items: ParsedItemVisual[];
  nonAttachedHair: string;
  naturalHairColor: ParsedColor | null;
  naturalBeardColor: ParsedColor | null;
  bipedVisual: ParsedBipedVisual | null;
}

export interface ParsedBipedVisual {
  texture: string;
  noWeapon: boolean;
  modelGuid: string;
  primaryHandItem: string | null;
  secondaryHandItem: string | null;
}

export interface ParsedDescriptor {
  id: number;
  forename: string;
  surname: string;
  torso: string;
  female: boolean;
  profession: string;
  extra: string[];
  xpBoosts: Array<{ perk: string; level: number }>;
  voicePrefix: string;
  voicePitch: number;
  voiceType: number;
}

export interface ParsedPosition {
  offsetX: number;
  offsetY: number;
  x: number;
  y: number;
  z: number;
  dir: number;
}

export interface PlayerVisualProfile {
  position: ParsedPosition;
  descriptor: ParsedDescriptor;
  visual: ParsedHumanVisual;
  parseOffset: number;
  tableMode: 'kahlua' | 'pznet' | 'none';
  worldVersion: number;
}

export interface PlayerInventorySummary {
  containerType: string;
  explored: boolean;
  hasBeenLooted: boolean;
  capacity: number;
  itemCount: number;
  registryCounts: Record<string, number>;
  registryIds: number[];
}

export interface PlayerBlobSummary {
  tableMode: PlayerVisualProfile['tableMode'];
  position: ParsedPosition;
  descriptor: ParsedDescriptor;
  visual: ParsedHumanVisual;
  inventory: PlayerInventorySummary;
  stats: Record<string, number>;
  bodyDamage: {
    counts: BodyDamageCounts;
    parts: Array<Record<string, unknown>>;
    main: BodyDamageMain;
    thermoregulator?: Record<string, unknown>;
  };
  xp: {
    traits: string[];
    totalXp: number;
    level: number;
    lastLevel: number;
    perkXp: Record<string, number>;
    perkLevels: Record<string, number>;
    xpMultipliers: Array<{ perk: string; multiplier: number; minLevel: number; maxLevel: number }>;
  };
  character: {
    asleep: boolean;
    forceWakeUpTime: number;
    leftHandIndex: number;
    rightHandIndex: number;
    onFire: boolean;
    effects: Record<string, number>;
    readBooks: Array<{ fullType: string; pages: number }>;
    reduceInfectionPower: number;
    knownRecipes: string[];
    lastHourSleeped: number;
    timeSinceLastSmoke: number;
    beardGrowTiming: number;
    hairGrowTiming: number;
    flags: Record<string, boolean>;
    readLiterature: Array<{ title: string; day: number }>;
    readPrintMedia: string[];
    lastAnimalPet: string;
    cheats: string[];
  };
  player: {
    hoursSurvived: number;
    zombieKills: number;
    survivorKills: number;
    wornItems: Array<{ location: string; itemIndex: number; registryId?: number }>;
    primaryHandIndex: number;
    secondaryHandIndex: number;
    nutrition: Record<string, number>;
    allChatMuted: boolean;
    tagPrefix: string;
    tagColor: Record<string, number>;
    displayName: string;
    showTag: boolean;
    factionPvp: boolean;
    autoDrink?: boolean;
    extraInfoFlags: number;
    savedVehicle?: Record<string, unknown>;
    mechanicsItem: Array<{ itemId: string; value: string }>;
    fitness: FitnessSummary;
    alreadyReadBook: number[];
    knownMediaLines: string[];
    voiceType?: number;
    craftHistory?: Array<{ craftType: string; craftCount: number; lastCraftTime: number }>;
  };
  parseOffset: number;
  remainingBytes: number;
}

type BodyDamageCounts = {
  cut: number;
  bitten: number;
  scratched: number;
  bandaged: number;
  bleeding: number;
  deepWounded: number;
  infected: number;
  fractured: number;
  burned: number;
};

type BodyDamageMain = {
  catchACold: number;
  hasACold: boolean;
  coldStrength: number;
  timeToSneezeOrCough?: number;
  reduceFakeInfection: boolean;
  healthFromFoodTimer: number;
  painReduction: number;
  coldReduction: number;
  infectionTime: number;
  infectionMortalityDuration: number;
  coldDamageStage: number;
};

type FitnessSummary = {
  stiffnessIncMap: Record<string, number>;
  stiffnessTimerMap: Record<string, number>;
  regularityMap: Record<string, number>;
  bodypartToIncStiffness: string[];
  exeTimer: Record<string, string>;
};

class ByteReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private readonly decoder = new TextDecoder('utf-8');
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  mark(): number {
    return this.pos;
  }

  restore(mark: number): void {
    this.pos = mark;
  }

  remaining(): number {
    return this.bytes.length - this.pos;
  }

  skip(len: number): void {
    this.ensure(len);
    this.pos += len;
  }

  readU8(): number {
    this.ensure(1);
    return this.view.getUint8(this.pos++);
  }

  readI8(): number {
    this.ensure(1);
    return this.view.getInt8(this.pos++);
  }

  readU16(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return value;
  }

  readI16(): number {
    this.ensure(2);
    const value = this.view.getInt16(this.pos, false);
    this.pos += 2;
    return value;
  }

  readI32(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return value;
  }

  readF32(): number {
    this.ensure(4);
    const value = this.view.getFloat32(this.pos, false);
    this.pos += 4;
    return value;
  }

  readF64(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.pos, false);
    this.pos += 8;
    return value;
  }

  readI64(): bigint {
    this.ensure(8);
    const value = this.view.getBigInt64(this.pos, false);
    this.pos += 8;
    return value;
  }

  readBool(): boolean {
    return this.readU8() !== 0;
  }

  readString(): string {
    const len = this.readU16();
    if (len === 0) {
      return '';
    }
    this.ensure(len);
    const slice = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return this.decoder.decode(slice);
  }

  readBytes(len: number): Uint8Array {
    this.ensure(len);
    const slice = this.bytes.subarray(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  readChar(): string {
    return String.fromCharCode(this.readU16());
  }

  readChars(count: number): string {
    if (count <= 0) {
      return '';
    }
    const chars: string[] = [];
    for (let i = 0; i < count; i += 1) {
      chars.push(this.readChar());
    }
    return chars.join('');
  }

  private ensure(len: number): void {
    if (this.pos + len > this.bytes.length) {
      throw new Error(
        `Unexpected end of buffer at ${this.pos} (need ${len}, remaining ${this.remaining()})`,
      );
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  const cleaned = (hex ?? '').replace(/\s+/g, '');
  if (cleaned.length % 2 !== 0) {
    throw new Error('Hex data must have an even number of characters.');
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    const hi = parseInt(cleaned[i], 16);
    const lo = parseInt(cleaned[i + 1], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) {
      throw new Error('Invalid hex character found.');
    }
    out[i / 2] = (hi << 4) | lo;
  }
  return out;
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = (value ?? '').trim().replace(/^data:[^;]+;base64,/, '');
  if (!normalized) {
    return new Uint8Array();
  }
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function parseColor(reader: ByteReader): ParsedColor {
  return {
    r: reader.readU8(),
    g: reader.readU8(),
    b: reader.readU8(),
  };
}

function parseDescriptor(reader: ByteReader): ParsedDescriptor {
  const id = reader.readI32();
  const forename = reader.readString();
  const surname = reader.readString();
  const torso = reader.readString();
  const female = reader.readI32() === 1;
  const profession = reader.readString();
  const extra: string[] = [];
  const hasExtra = reader.readI32() === 1;
  if (hasExtra) {
    const size = reader.readI32();
    for (let i = 0; i < size; i += 1) {
      extra.push(reader.readString());
    }
  }
  const xpBoosts: Array<{ perk: string; level: number }> = [];
  const boostCount = reader.readI32();
  for (let i = 0; i < boostCount; i += 1) {
    xpBoosts.push({ perk: reader.readString(), level: reader.readI32() });
  }
  const voicePrefix = reader.readString();
  const voicePitch = reader.readF32();
  const voiceType = reader.readI32();
  return {
    id,
    forename,
    surname,
    torso,
    female,
    profession,
    extra,
    xpBoosts,
    voicePrefix,
    voicePitch,
    voiceType,
  };
}

function parseItemVisual(reader: ByteReader): ParsedItemVisual {
  const flags = reader.readU8();
  const fullType = reader.readString();
  const alternateModelName = reader.readString();
  const clothingItemName = reader.readString();
  const tint = flags & 0x01 ? parseColor(reader) : null;
  const baseTexture = flags & 0x02 ? reader.readU8() : null;
  const textureChoice = flags & 0x04 ? reader.readU8() : null;
  const hue = flags & 0x08 ? reader.readF32() : null;
  const decal = flags & 0x10 ? reader.readString() : null;
  const blood = Array.from(readByteArray(reader));
  const dirt = Array.from(readByteArray(reader));
  const holes = Array.from(readByteArray(reader));
  const basicPatches = Array.from(readByteArray(reader));
  const denimPatches = Array.from(readByteArray(reader));
  const leatherPatches = Array.from(readByteArray(reader));
  return {
    fullType,
    alternateModelName,
    clothingItemName,
    tint,
    baseTexture,
    textureChoice,
    hue,
    decal,
    blood,
    dirt,
    holes,
    basicPatches,
    denimPatches,
    leatherPatches,
  };
}

function parseHumanVisual(reader: ByteReader, worldVersion: number): ParsedHumanVisual {
  const flags1 = reader.readU8();
  const hairColor = flags1 & 0x04 ? parseColor(reader) : null;
  const beardColor = flags1 & 0x02 ? parseColor(reader) : null;
  const skinColor = flags1 & 0x08 ? parseColor(reader) : null;
  const bodyHair = reader.readI8();
  const skinTexture = reader.readI8();
  const zombieRotStage = reader.readI8();
  const skinTextureName = flags1 & 0x40 ? reader.readString() : null;
  const beardModel = flags1 & 0x10 ? reader.readString() : null;
  const hairModel = flags1 & 0x20 ? reader.readString() : null;
  const blood = Array.from(readByteArray(reader));
  const dirt = Array.from(readByteArray(reader));
  const holes = Array.from(readByteArray(reader));
  const itemCount = reader.readU8();
  const items: ParsedItemVisual[] = [];
  for (let i = 0; i < itemCount; i += 1) {
    items.push(parseItemVisual(reader));
  }
  const nonAttachedHair = reader.readString();
  const flags2 = reader.readU8();
  const naturalHairColor = flags2 & 0x04 ? parseColor(reader) : null;
  const naturalBeardColor = flags2 & 0x02 ? parseColor(reader) : null;
  const bipedVisual = worldVersion >= 185 ? parseBipedVisual(reader) : null;
  return {
    hairColor,
    beardColor,
    skinColor,
    bodyHair,
    skinTexture,
    zombieRotStage,
    skinTextureName,
    beardModel,
    hairModel,
    blood,
    dirt,
    holes,
    items,
    nonAttachedHair,
    naturalHairColor,
    naturalBeardColor,
    bipedVisual,
  };
}

function parseBipedVisual(reader: ByteReader): ParsedBipedVisual {
  const texture = reader.readString();
  const noWeapon = reader.readU8() === 1;
  const modelGuid = reader.readString();
  const primaryHandItem = reader.readU8() === 1 ? reader.readString() : null;
  const secondaryHandItem = reader.readU8() === 1 ? reader.readString() : null;
  return { texture, noWeapon, modelGuid, primaryHandItem, secondaryHandItem };
}

function readByteArray(reader: ByteReader): Uint8Array {
  const len = reader.readU8();
  if (len === 0) {
    return new Uint8Array();
  }
  return reader.readBytes(len);
}

function parseLuaTableKahlua(reader: ByteReader, worldVersion: number): void {
  const count = reader.readI32();
  if (worldVersion >= 25) {
    for (let i = 0; i < count; i += 1) {
      const keyType = reader.readU8();
      skipKahluaValue(reader, keyType, worldVersion);
      const valueType = reader.readU8();
      skipKahluaValue(reader, valueType, worldVersion);
    }
    return;
  }
  for (let i = 0; i < count; i += 1) {
    const valueType = reader.readU8();
    reader.readString();
    skipKahluaValue(reader, valueType, worldVersion);
  }
}

function skipKahluaValue(reader: ByteReader, type: number, worldVersion: number): void {
  switch (type) {
    case 0:
      reader.readString();
      return;
    case 1:
      reader.readF64();
      return;
    case 2:
      parseLuaTableKahlua(reader, worldVersion);
      return;
    case 3:
      reader.readU8();
      return;
    default:
      throw new Error(`Invalid Kahlua table type ${type}`);
  }
}

function parseLuaTablePzNet(reader: ByteReader): void {
  const count = reader.readI32();
  for (let i = 0; i < count; i += 1) {
    const keyType = reader.readU8();
    skipPzNetValue(reader, keyType);
    const valueType = reader.readU8();
    skipPzNetValue(reader, valueType);
  }
}

function skipPzNetValue(reader: ByteReader, type: number): void {
  switch (type) {
    case 0:
      reader.readI32();
      return;
    case 1:
      reader.readString();
      return;
    case 2:
      reader.readF64();
      return;
    case 3:
      parseLuaTableKahlua(reader, 240);
      return;
    case 4:
      parseLuaTablePzNet(reader);
      return;
    case 5:
      reader.readU8();
      return;
    case 6:
      skipContainerId(reader);
      reader.readI32();
      return;
    case 7:
      skipNetObject(reader);
      return;
    case 8:
      skipPlayerId(reader);
      return;
    case 9:
      skipContainerId(reader);
      return;
    case 10:
      skipPlayerId(reader);
      reader.readI32();
      return;
    case 11:
      reader.readU16();
      reader.readString();
      return;
    case 12:
      reader.readU16();
      return;
    case 13:
      reader.readI32();
      reader.readI32();
      reader.readU8();
      return;
    case 14:
      reader.readString();
      return;
    case 15:
      reader.readI32();
      return;
    case 16:
      reader.readU16();
      reader.readU8();
      return;
    case 17:
      reader.readU16();
      return;
    case 18:
      reader.readString();
      return;
    case 19:
      reader.skip(8);
      reader.readString();
      return;
    case 20:
      reader.readI32();
      return;
    case 21:
      reader.readString();
      return;
    case 22:
      reader.readString();
      return;
    case 23: {
      const subtype = reader.readU8();
      if (subtype === 6) {
        skipContainerId(reader);
        reader.readI32();
      } else if (subtype === 7) {
        skipNetObject(reader);
      }
      return;
    }
    case 24:
      reader.readU16();
      reader.readString();
      return;
    case 25:
      reader.readString();
      return;
    case 26: {
      const size = reader.readI32();
      for (let i = 0; i < size; i += 1) {
        const entryType = reader.readU8();
        if (entryType === 0xff) {
          break;
        }
        skipPzNetValue(reader, entryType);
      }
      return;
    }
    case 27:
      return;
    case 28:
      reader.readF32();
      return;
    case 29:
      reader.skip(8);
      return;
    case 30:
      reader.readU16();
      return;
    case 31:
      reader.readU8();
      return;
    case 32:
      reader.readI32();
      return;
    case 33:
      reader.readString();
      return;
    case 34:
      skipClimbParams(reader);
      return;
    case 35:
      reader.readU16();
      return;
    case 36:
      reader.skip(8);
      reader.readU16();
      return;
    case 37:
      reader.readI32();
      return;
    case 38:
      skipVariables(reader);
      return;
    default:
      throw new Error(`Invalid PZNet table type ${type}`);
  }
}

function skipPlayerId(reader: ByteReader): void {
  reader.readU16();
  reader.readU8();
}

function skipCharacterId(reader: ByteReader): void {
  const kind = reader.readU8();
  if (kind === 1) {
    skipPlayerId(reader);
  } else if (kind === 2 || kind === 3) {
    reader.readU16();
  }
}

function skipContainerId(reader: ByteReader): void {
  const type = reader.readU8();
  if (type === 0) {
    return;
  }
  if (type === 7) {
    skipPlayerId(reader);
    return;
  }
  if (type === 8) {
    skipPlayerId(reader);
    reader.readI32();
    return;
  }
  reader.readI32();
  reader.readI32();
  reader.readU8();
  if (type === 1) {
    reader.readU16();
  } else if (type === 2) {
    reader.readI32();
  } else if (type === 3) {
    reader.readU16();
  } else if (type === 4) {
    reader.readU16();
    reader.readU16();
  } else if (type === 5) {
    reader.readU16();
    reader.readU16();
    reader.readU16();
  } else if (type === 6) {
    reader.readU16();
    reader.readU16();
  }
}

function skipNetObject(reader: ByteReader): void {
  const objectType = reader.readU8();
  if (objectType === 1) {
    reader.readU16();
    reader.readI32();
    reader.readI32();
    reader.readU8();
  }
}

function skipClimbParams(reader: ByteReader): void {
  reader.readI32();
  reader.readI32();
  reader.readI32();
  reader.readI32();
  reader.readU8();
  reader.readI32();
  reader.readI32();
  reader.readU8();
  skipCharacterId(reader);
  skipNetObject(reader);
  reader.readU8();
}

function skipVariables(reader: ByteReader): void {
  const size = reader.readI32();
  for (let i = 0; i < size; i += 1) {
    reader.readString();
    reader.readString();
  }
}

function parseLuaTable(reader: ByteReader, worldVersion: number): 'kahlua' | 'pznet' {
  const mark = reader.mark();
  try {
    parseLuaTableKahlua(reader, worldVersion);
    return 'kahlua';
  } catch (err) {
    reader.restore(mark);
    parseLuaTablePzNet(reader);
    return 'pznet';
  }
}

export function parsePlayerBlobBytes(
  bytes: Uint8Array,
  worldVersion = 240,
): PlayerVisualProfile {
  const reader = new ByteReader(bytes);
  reader.readU8();
  reader.readU8();
  const position: ParsedPosition = {
    offsetX: reader.readF32(),
    offsetY: reader.readF32(),
    x: reader.readF32(),
    y: reader.readF32(),
    z: reader.readF32(),
    dir: reader.readI32(),
  };
  let tableMode: PlayerVisualProfile['tableMode'] = 'none';
  const hasTable = reader.readU8() !== 0;
  if (hasTable) {
    tableMode = parseLuaTable(reader, worldVersion);
  }
  const hasDescriptor = reader.readU8() !== 0;
  if (!hasDescriptor) {
    throw new Error('Missing SurvivorDesc; cannot parse visual data.');
  }
  const descriptor = parseDescriptor(reader);
  const visual = parseHumanVisual(reader, worldVersion);
  return {
    position,
    descriptor,
    visual,
    parseOffset: reader.pos,
    tableMode,
    worldVersion,
  };
}

export function parsePlayerBlobBase64(
  base64: string,
  worldVersion = 240,
): PlayerVisualProfile {
  const bytes = base64ToBytes(base64);
  return parsePlayerBlobBytes(bytes, worldVersion);
}

export function parsePlayerBlobHex(hex: string, worldVersion = 240): PlayerVisualProfile {
  const bytes = hexToBytes(hex);
  return parsePlayerBlobBytes(bytes, worldVersion);
}

const CHARACTER_STATS = [
  'Anger',
  'Boredom',
  'Discomfort',
  'Endurance',
  'Fatigue',
  'Fitness',
  'FoodSickness',
  'Hunger',
  'Idleness',
  'Intoxication',
  'Morale',
  'NicotineWithdrawal',
  'Pain',
  'Panic',
  'Poison',
  'Sanity',
  'Sickness',
  'Stress',
  'Temperature',
  'Thirst',
  'Unhappiness',
  'Wetness',
  'ZombieFever',
  'ZombieInfection',
];

const BODY_PARTS = [
  'Hand_L',
  'Hand_R',
  'ForeArm_L',
  'ForeArm_R',
  'UpperArm_L',
  'UpperArm_R',
  'Torso_Upper',
  'Torso_Lower',
  'Head',
  'Neck',
  'Groin',
  'UpperLeg_L',
  'UpperLeg_R',
  'LowerLeg_L',
  'LowerLeg_R',
  'Foot_L',
  'Foot_R',
];

function parseStats(reader: ByteReader): Record<string, number> {
  const out: Record<string, number> = {};
  for (const stat of CHARACTER_STATS) {
    out[stat] = reader.readF32();
  }
  return out;
}

function parseTraits(reader: ByteReader): string[] {
  const count = reader.readI32();
  const traits: string[] = [];
  for (let i = 0; i < count; i += 1) {
    traits.push(reader.readString());
  }
  return traits;
}

function parseXp(reader: ByteReader, worldVersion: number): PlayerBlobSummary['xp'] {
  const traits = parseTraits(reader);
  const totalXp = reader.readF32();
  const level = reader.readI32();
  const lastLevel = reader.readI32();
  const xpCount = reader.readI32();
  const perkXp: Record<string, number> = {};
  for (let i = 0; i < xpCount; i += 1) {
    const perk = reader.readString();
    const xp = reader.readF32();
    if (perk) {
      perkXp[perk] = xp;
    }
  }
  const perkLevels: Record<string, number> = {};
  const perkLevelCount = reader.readI32();
  for (let i = 0; i < perkLevelCount; i += 1) {
    const perk = reader.readString();
    const perkLevel = reader.readI32();
    if (perk) {
      perkLevels[perk] = perkLevel;
    }
  }
  const multiplierCount = reader.readI32();
  const xpMultipliers: Array<{
    perk: string;
    multiplier: number;
    minLevel: number;
    maxLevel: number;
  }> = [];
  for (let i = 0; i < multiplierCount; i += 1) {
    const perk = reader.readString();
    const multiplier = reader.readF32();
    const minLevel = reader.readI8();
    const maxLevel = reader.readI8();
    if (perk) {
      xpMultipliers.push({ perk, multiplier, minLevel, maxLevel });
    }
  }
  void worldVersion;
  return { traits, totalXp, level, lastLevel, perkXp, perkLevels, xpMultipliers };
}

function skipInventoryItem(
  reader: ByteReader,
): { registryId: number; dataLen: number } {
  const dataLen = reader.readI32();
  const itemStart = reader.pos;
  const registryId = reader.readU16();
  reader.readU8();
  reader.pos = itemStart + dataLen;
  return { registryId, dataLen };
}

function parseInventory(reader: ByteReader): PlayerInventorySummary {
  const containerType = reader.readString();
  const explored = reader.readBool();
  const count = reader.readU16();
  const registryIds: number[] = [];
  const registryCounts: Record<string, number> = {};
  for (let i = 0; i < count; i += 1) {
    const identical = reader.readI32();
    const { registryId } = skipInventoryItem(reader);
    for (let j = 0; j < identical; j += 1) {
      registryIds.push(registryId);
    }
    const key = String(registryId);
    registryCounts[key] = (registryCounts[key] ?? 0) + identical;
    if (identical > 1) {
      reader.skip((identical - 1) * 4);
    }
  }
  const hasBeenLooted = reader.readBool();
  const capacity = reader.readI32();
  return {
    containerType,
    explored,
    hasBeenLooted,
    capacity,
    itemCount: registryIds.length,
    registryCounts,
    registryIds,
  };
}

function parseBodyDamage(reader: ByteReader, worldVersion: number): PlayerBlobSummary['bodyDamage'] {
  const parts: Array<Record<string, unknown>> = [];
  const counts: BodyDamageCounts = {
    cut: 0,
    bitten: 0,
    scratched: 0,
    bandaged: 0,
    bleeding: 0,
    deepWounded: 0,
    infected: 0,
    fractured: 0,
    burned: 0,
  };

  for (const partName of BODY_PARTS) {
    const cut = reader.readBool();
    const bitten = reader.readBool();
    const scratched = reader.readBool();
    const bandaged = reader.readBool();
    const bleeding = reader.readBool();
    const deepWounded = reader.readBool();
    const fakeInfected = reader.readBool();
    const infected = reader.readBool();
    const health = reader.readF32();
    const bandageLife = bandaged ? reader.readF32() : null;
    const infectedWound = reader.readBool();
    const woundInfectionLevel = infectedWound ? reader.readF32() : null;
    const cutTime = reader.readF32();
    const biteTime = reader.readF32();
    const scratchTime = reader.readF32();
    const bleedingTime = reader.readF32();
    const alcoholLevel = reader.readF32();
    const additionalPain = reader.readF32();
    const deepWoundTime = reader.readF32();
    const haveGlass = reader.readBool();
    const getBandageXp = reader.readBool();
    const stitched = reader.readBool();
    const stitchTime = reader.readF32();
    const getStitchXp = reader.readBool();
    const getSplintXp = reader.readBool();
    const fractureTime = reader.readF32();
    const splint = reader.readBool();
    const splintFactor = splint ? reader.readF32() : null;
    const haveBullet = reader.readBool();
    const burnTime = reader.readF32();
    const needBurnWash = reader.readBool();
    const lastTimeBurnWash = reader.readF32();
    const splintItem = reader.readString();
    const bandageType = reader.readString();
    const cutTime2 = reader.readF32();
    const wetness = reader.readF32();
    const stiffness = reader.readF32();
    const comfreyFactor = worldVersion >= 227 ? reader.readF32() : null;
    const garlicFactor = worldVersion >= 227 ? reader.readF32() : null;
    const plantainFactor = worldVersion >= 227 ? reader.readF32() : null;

    if (cut) counts.cut += 1;
    if (bitten) counts.bitten += 1;
    if (scratched) counts.scratched += 1;
    if (bandaged) counts.bandaged += 1;
    if (bleeding) counts.bleeding += 1;
    if (deepWounded) counts.deepWounded += 1;
    if (infected) counts.infected += 1;
    if (fractureTime > 0) counts.fractured += 1;
    if (burnTime > 0) counts.burned += 1;

    parts.push({
      part: partName,
      cut,
      bitten,
      scratched,
      bandaged,
      bleeding,
      deepWounded,
      fakeInfected,
      infected,
      health,
      bandageLife,
      infectedWound,
      woundInfectionLevel,
      cutTime,
      biteTime,
      scratchTime,
      bleedingTime,
      alcoholLevel,
      additionalPain,
      deepWoundTime,
      haveGlass,
      getBandageXp,
      stitched,
      stitchTime,
      getStitchXp,
      getSplintXp,
      fractureTime,
      splint,
      splintFactor,
      haveBullet,
      burnTime,
      needBurnWash,
      lastTimeBurnWash,
      splintItem,
      bandageType,
      cutTime2,
      wetness,
      stiffness,
      comfreyFactor,
      garlicFactor,
      plantainFactor,
    });
  }

  const catchACold = reader.readF32();
  const hasACold = reader.readBool();
  const coldStrength = reader.readF32();
  const timeToSneezeOrCough = worldVersion >= 222 ? reader.readI32() : undefined;
  const reduceFakeInfection = reader.readBool();
  const healthFromFoodTimer = reader.readF32();
  const painReduction = reader.readF32();
  const coldReduction = reader.readF32();
  const infectionTime = reader.readF32();
  const infectionMortalityDuration = reader.readF32();
  const coldDamageStage = reader.readF32();
  const main: BodyDamageMain = {
    catchACold,
    hasACold,
    coldStrength,
    timeToSneezeOrCough,
    reduceFakeInfection,
    healthFromFoodTimer,
    painReduction,
    coldReduction,
    infectionTime,
    infectionMortalityDuration,
    coldDamageStage,
  };

  let thermoregulator: Record<string, unknown> | undefined;
  const hasThermo = reader.readBool();
  if (hasThermo) {
    const setPoint = reader.readF32();
    const metabolicRate = reader.readF32();
    const metabolicTarget = reader.readF32();
    const bodyHeatDelta = reader.readF32();
    const coreHeatDelta = reader.readF32();
    const thermalDamage = reader.readF32();
    const damageCounter = reader.readF32();
    const nodeCount = reader.readI32();
    const nodes: Array<Record<string, number>> = [];
    for (let i = 0; i < nodeCount; i += 1) {
      nodes.push({
        bodyPartIndex: reader.readI32(),
        celcius: reader.readF32(),
        skinCelcius: reader.readF32(),
        heatDelta: reader.readF32(),
        primary: reader.readF32(),
        secondary: reader.readF32(),
      });
    }
    thermoregulator = {
      setPoint,
      metabolicRate,
      metabolicTarget,
      bodyHeatDelta,
      coreHeatDelta,
      thermalDamage,
      damageCounter,
      nodes,
    };
  }

  return { counts, parts, main, thermoregulator };
}

function parseFitness(reader: ByteReader): FitnessSummary {
  const out: FitnessSummary = {
    stiffnessIncMap: {},
    stiffnessTimerMap: {},
    regularityMap: {},
    bodypartToIncStiffness: [],
    exeTimer: {},
  };
  const readMapFloat = (): Record<string, number> => {
    const size = reader.readI32();
    const map: Record<string, number> = {};
    for (let i = 0; i < size; i += 1) {
      map[reader.readString()] = reader.readF32();
    }
    return map;
  };
  const readMapInt = (): Record<string, number> => {
    const size = reader.readI32();
    const map: Record<string, number> = {};
    for (let i = 0; i < size; i += 1) {
      map[reader.readString()] = reader.readI32();
    }
    return map;
  };
  const readMapLong = (): Record<string, string> => {
    const size = reader.readI32();
    const map: Record<string, string> = {};
    for (let i = 0; i < size; i += 1) {
      map[reader.readString()] = reader.readI64().toString();
    }
    return map;
  };
  out.stiffnessIncMap = readMapFloat();
  out.stiffnessTimerMap = readMapInt();
  out.regularityMap = readMapFloat();
  const listSize = reader.readI32();
  const list: string[] = [];
  for (let i = 0; i < listSize; i += 1) {
    list.push(reader.readString());
  }
  out.bodypartToIncStiffness = list;
  out.exeTimer = readMapLong();
  return out;
}

function parseCraftHistory(reader: ByteReader): Array<{ craftType: string; craftCount: number; lastCraftTime: number }> {
  const entryCount = reader.readI32();
  const entries: Array<{ craftType: string; craftCount: number; lastCraftTime: number }> = [];
  for (let i = 0; i < entryCount; i += 1) {
    const keyCharCount = reader.readI32();
    const craftType = reader.readChars(keyCharCount);
    const craftCount = reader.readI32();
    const lastCraftTime = reader.readF64();
    entries.push({ craftType, craftCount, lastCraftTime });
  }
  return entries;
}

export function parsePlayerBlobSummary(
  bytes: Uint8Array,
  worldVersion = 240,
): PlayerBlobSummary {
  const reader = new ByteReader(bytes);
  reader.readU8();
  reader.readU8();
  const position: ParsedPosition = {
    offsetX: reader.readF32(),
    offsetY: reader.readF32(),
    x: reader.readF32(),
    y: reader.readF32(),
    z: reader.readF32(),
    dir: reader.readI32(),
  };
  let tableMode: PlayerVisualProfile['tableMode'] = 'none';
  if (reader.readBool()) {
    tableMode = parseLuaTable(reader, worldVersion);
  }
  if (!reader.readBool()) {
    throw new Error('Missing SurvivorDesc; cannot parse player blob.');
  }
  const descriptor = parseDescriptor(reader);
  const visual = parseHumanVisual(reader, worldVersion);
  const inventory = parseInventory(reader);
  const asleep = reader.readBool();
  const forceWakeUpTime = reader.readF32();
  const stats = parseStats(reader);
  const bodyDamage = parseBodyDamage(reader, worldVersion);
  const xp = parseXp(reader, worldVersion);
  const leftHandIndex = reader.readI32();
  const rightHandIndex = reader.readI32();
  const onFire = reader.readBool();
  const effects = {
    depressEffect: reader.readF32(),
    depressFirstTakeTime: reader.readF32(),
    betaEffect: reader.readF32(),
    betaDelta: reader.readF32(),
    painEffect: reader.readF32(),
    painDelta: reader.readF32(),
    sleepingTabletEffect: reader.readF32(),
    sleepingTabletDelta: reader.readF32(),
  };
  const readBooksCount = reader.readI32();
  const readBooks: Array<{ fullType: string; pages: number }> = [];
  for (let i = 0; i < readBooksCount; i += 1) {
    readBooks.push({ fullType: reader.readString(), pages: reader.readI32() });
  }
  const reduceInfectionPower = reader.readF32();
  const knownRecipesCount = reader.readI32();
  const knownRecipes: string[] = [];
  for (let i = 0; i < knownRecipesCount; i += 1) {
    knownRecipes.push(reader.readString());
  }
  const lastHourSleeped = reader.readI32();
  const timeSinceLastSmoke = reader.readF32();
  const beardGrowTiming = reader.readF32();
  const hairGrowTiming = reader.readF32();
  const flags: Record<string, boolean> = {
    unlimitedCarry: reader.readBool(),
    buildCheat: reader.readBool(),
    healthCheat: reader.readBool(),
    mechanicsCheat: reader.readBool(),
    movablesCheat: reader.readBool(),
    farmingCheat: reader.readBool(),
    fishingCheat: worldVersion >= 202 ? reader.readBool() : false,
    canUseBrushTool: worldVersion >= 217 ? reader.readBool() : false,
    fastMoveCheat: worldVersion >= 217 ? reader.readBool() : false,
    timedActionInstantCheat: reader.readBool(),
    unlimitedEndurance: reader.readBool(),
    unlimitedAmmo: worldVersion >= 230 ? reader.readBool() : false,
    knowAllRecipes: worldVersion >= 230 ? reader.readBool() : false,
    sneaking: reader.readBool(),
    deathDragDown: reader.readBool(),
  };
  const readLiteratureCount = reader.readI32();
  const readLiterature: Array<{ title: string; day: number }> = [];
  for (let i = 0; i < readLiteratureCount; i += 1) {
    readLiterature.push({ title: reader.readString(), day: reader.readI32() });
  }
  const readPrintMedia: string[] = [];
  if (worldVersion >= 222) {
    const count = reader.readI32();
    for (let i = 0; i < count; i += 1) {
      readPrintMedia.push(reader.readString());
    }
  }
  const lastAnimalPet = reader.readI64().toString();
  const cheats: string[] = [];
  if (worldVersion >= 231) {
    const cheatCount = reader.readI32();
    for (let i = 0; i < cheatCount; i += 1) {
      cheats.push(String(reader.readI8()));
    }
  }

  const hoursSurvived = reader.readF64();
  const zombieKills = reader.readI32();
  const wornCount = reader.readU8();
  const wornItems: Array<{ location: string; itemIndex: number; registryId?: number }> = [];
  for (let i = 0; i < wornCount; i += 1) {
    const location = reader.readString();
    const itemIndex = reader.readI16();
    wornItems.push({
      location,
      itemIndex,
      registryId:
        itemIndex >= 0 && itemIndex < inventory.registryIds.length
          ? inventory.registryIds[itemIndex]
          : undefined,
    });
  }
  const primaryHandIndex = reader.readI16();
  const secondaryHandIndex = reader.readI16();
  const survivorKills = reader.readI32();
  const nutrition = {
    calories: reader.readF32(),
    proteins: reader.readF32(),
    lipids: reader.readF32(),
    carbohydrates: reader.readF32(),
    weight: reader.readF32(),
  };
  const allChatMuted = reader.readBool();
  const tagPrefix = reader.readString();
  const tagColor = {
    r: reader.readF32(),
    g: reader.readF32(),
    b: reader.readF32(),
  };
  const displayName = reader.readString();
  const showTag = reader.readBool();
  const factionPvp = reader.readBool();
  const autoDrink = worldVersion >= 239 ? reader.readBool() : undefined;
  const extraInfoFlags = reader.readU8();
  let savedVehicle: Record<string, unknown> | undefined;
  if (reader.readBool()) {
    savedVehicle = {
      x: reader.readF32(),
      y: reader.readF32(),
      seat: reader.readU8(),
      running: reader.readBool(),
    };
  }
  const mechanicsCount = reader.readI32();
  const mechanicsItem: Array<{ itemId: string; value: string }> = [];
  for (let i = 0; i < mechanicsCount; i += 1) {
    mechanicsItem.push({
      itemId: reader.readI64().toString(),
      value: reader.readI64().toString(),
    });
  }
  const fitness = parseFitness(reader);
  const readBookCount = reader.readU16();
  const alreadyReadBook: number[] = [];
  for (let i = 0; i < readBookCount; i += 1) {
    alreadyReadBook.push(reader.readI16());
  }
  const knownMediaLinesCount = reader.readU16();
  const knownMediaLines: string[] = [];
  for (let i = 0; i < knownMediaLinesCount; i += 1) {
    knownMediaLines.push(reader.readString());
  }
  const voiceType = worldVersion >= 203 ? reader.readU8() : undefined;
  const craftHistory = worldVersion >= 228 ? parseCraftHistory(reader) : undefined;

  return {
    tableMode,
    position,
    descriptor,
    visual,
    inventory,
    stats,
    bodyDamage,
    xp,
    character: {
      asleep,
      forceWakeUpTime,
      leftHandIndex,
      rightHandIndex,
      onFire,
      effects,
      readBooks,
      reduceInfectionPower,
      knownRecipes,
      lastHourSleeped,
      timeSinceLastSmoke,
      beardGrowTiming,
      hairGrowTiming,
      flags,
      readLiterature,
      readPrintMedia,
      lastAnimalPet,
      cheats,
    },
    player: {
      hoursSurvived,
      zombieKills,
      survivorKills,
      wornItems,
      primaryHandIndex,
      secondaryHandIndex,
      nutrition,
      allChatMuted,
      tagPrefix,
      tagColor,
      displayName,
      showTag,
      factionPvp,
      autoDrink,
      extraInfoFlags,
      savedVehicle,
      mechanicsItem,
      fitness,
      alreadyReadBook,
      knownMediaLines,
      voiceType,
      craftHistory,
    },
    parseOffset: reader.pos,
    remainingBytes: reader.remaining(),
  };
}
