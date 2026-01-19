export interface PlayerDbEntry {
  id: number;
  name: string | null;
  wx: number;
  wy: number;
  x: number;
  y: number;
  z: number;
  worldVersion: number;
  isDead: boolean;
  dataLen: number;
  death_cause?: string;
}

export interface PlayerDbBlob {
  id: number;
  name: string | null;
  wx: number;
  wy: number;
  x: number;
  y: number;
  z: number;
  worldVersion: number;
  isDead: boolean;
  dataHex: string;
  dataBytes?: Uint8Array;
}

export interface PlayerDbUpdate {
  id: number;
  name?: string | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  isDead?: boolean | null;
  dataHex?: string | null;
  backup?: boolean;
  death_cause?: string;
}

export interface PlayerDbStringHit {
  offset: number;
  length: number;
  value: string;
}

export interface PlayerDbInspect {
  id: number;
  size: number;
  strings: PlayerDbStringHit[];
}

export interface PlayerDbExportPayload {
  dbPath: string;
  player: PlayerDbEntry;
  blobHex: string;
  strings: PlayerDbStringHit[];
  exportedAt: string;
}

export interface PlayerBlobTextFile {
  name: string;
  text: string;
}
