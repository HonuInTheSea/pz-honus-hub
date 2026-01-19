import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import type {
  PlayerDbBlob,
  PlayerDbEntry,
  PlayerDbExportPayload,
  PlayerDbInspect,
  PlayerDbUpdate,
  PlayerBlobTextFile,
} from '../models/player-db.models';

type SqlRow = Record<string, unknown>;
type SqlValue = string | number | boolean | null | Uint8Array | ArrayBuffer | number[];

@Injectable({ providedIn: 'root' })
export class PlayerDbService {
  private dbCache = new Map<string, Promise<Database>>();
  private tableCache = new Map<string, Promise<string>>();
  private columnCache = new Map<string, Promise<Set<string>>>();

  async listSavePlayerDbs(userDir: string): Promise<string[]> {
    return invoke<string[]>('list_save_player_dbs', { userDir });
  }

  async readPlayersDb(dbPath: string, tableOverride?: string): Promise<PlayerDbEntry[]> {
    const db = await this.getDb(dbPath);
    const table = await this.getPlayersTable(dbPath, db, tableOverride);
    const columns = await this.getTableColumns(dbPath, db, table);
    const selectCols = ['id', 'name', 'wx', 'wy', 'x', 'y', 'z', 'worldVersion', 'isDead', 'dataLen']
      .filter((col) => columns.has(col.toLowerCase()));
    const query = selectCols.length ? selectCols.join(', ') : '*';
    const rows = await db.select<SqlRow[]>(`SELECT ${query} FROM ${table}`);
    return rows.map((row) => this.mapPlayerEntry(row, columns));
  }

  async readPlayerDbBlob(
    dbPath: string,
    id: number,
    tableOverride?: string,
  ): Promise<PlayerDbBlob> {
    const db = await this.getDb(dbPath);
    const table = await this.getPlayersTable(dbPath, db, tableOverride);
    const columns = await this.getTableColumns(dbPath, db, table);
    const selectCols = ['id', 'name', 'wx', 'wy', 'x', 'y', 'z', 'worldVersion', 'isDead', 'data']
      .filter((col) => columns.has(col.toLowerCase()));
    const query = selectCols.length ? selectCols.join(', ') : '*';
    const rows = await db.select<SqlRow[]>(`SELECT ${query} FROM ${table} WHERE id = ?1`, [id]);
    const row = rows[0];
    if (!row) {
      throw new Error('Player not found.');
    }
    const dataLen = this.toNumber(this.getColumn(row, ['dataLen', 'datalen'])) ?? 0;
    let data = this.toBytes(this.getColumn(row, ['data', 'blob', 'dataBlob']));
    let dataHex = data ? this.bytesToHex(data) : '';
    if ((dataLen > 0 && (!data || data.length < dataLen)) || (!data && dataHex === '')) {
      const hexRows = await db.select<Array<{ dataHex: string | null }>>(
        `SELECT hex(data) as dataHex FROM ${table} WHERE id = ?1`,
        [id],
      );
      const hexRow = hexRows[0];
      if (hexRow?.dataHex) {
        const fallbackHex = hexRow.dataHex.trim();
        const fallbackBytes = this.hexToBytes(fallbackHex);
        if (fallbackBytes) {
          data = fallbackBytes;
          dataHex = fallbackHex;
        }
      }
    }
    return {
      id: this.toNumber(this.getColumn(row, ['id'])) ?? id,
      name: this.toStringOrNull(this.getColumn(row, ['name'])),
      wx: this.toNumber(this.getColumn(row, ['wx'])) ?? 0,
      wy: this.toNumber(this.getColumn(row, ['wy'])) ?? 0,
      x: this.toNumber(this.getColumn(row, ['x'])) ?? 0,
      y: this.toNumber(this.getColumn(row, ['y'])) ?? 0,
      z: this.toNumber(this.getColumn(row, ['z'])) ?? 0,
      worldVersion: this.toNumber(this.getColumn(row, ['worldVersion', 'world_version'])) ?? 0,
      isDead: this.toBoolean(this.getColumn(row, ['isDead', 'is_dead'])) ?? false,
      dataHex,
      dataBytes: data ?? undefined,
    };
  }

  async updatePlayerDbEntry(
    dbPath: string,
    update: PlayerDbUpdate,
    tableOverride?: string,
  ): Promise<PlayerDbEntry> {
    const db = await this.getDb(dbPath);
    const table = await this.getPlayersTable(dbPath, db, tableOverride);
    const columns = await this.getTableColumns(dbPath, db, table);
    if (update.backup) {
      await invoke<void>('backup_file', { path: dbPath });
    }

    const updateField = async (column: string, value: SqlValue): Promise<void> => {
      if (!columns.has(column.toLowerCase())) {
        return;
      }
      await db.execute(`UPDATE ${table} SET ${column} = ?1 WHERE id = ?2`, [
        value,
        update.id,
      ]);
    };

    if (update.name !== undefined) {
      await updateField('name', update.name);
    }
    if (update.x !== undefined && update.x !== null) {
      await updateField('x', update.x);
    }
    if (update.y !== undefined && update.y !== null) {
      await updateField('y', update.y);
    }
    if (update.z !== undefined && update.z !== null) {
      await updateField('z', update.z);
    }
    if (update.isDead !== undefined && update.isDead !== null) {
      await updateField('isDead', update.isDead ? 1 : 0);
    }

    let dataHex = update.dataHex ?? null;
    if (!dataHex && update.death_cause !== undefined) {
      const blob = await this.readPlayerDbBlob(dbPath, update.id, tableOverride);
      dataHex = await invoke<string>('apply_player_death_cause_to_blob', {
        dataHex: blob.dataHex,
        deathCause: update.death_cause ?? '',
      });
    }
    if (dataHex !== null && dataHex !== undefined) {
      const bytes = this.hexToBytes(dataHex);
      if (!bytes) {
        throw new Error('Invalid hex payload.');
      }
      await updateField('data', bytes);
      if (columns.has('datalen')) {
        await updateField('dataLen', bytes.length);
      }
    }

    const row = await this.readPlayerEntry(dbPath, update.id, tableOverride);
    if (!row) {
      throw new Error('Player not found after update.');
    }
    if (dataHex && update.death_cause !== undefined) {
      const deathCause = await this.extractDeathCauseFromBlobHex(dataHex);
      if (deathCause) {
        row.death_cause = deathCause;
      }
    }
    return row;
  }

  async inspectPlayerDbBlob(
    dbPath: string,
    id: number,
    tableOverride?: string,
  ): Promise<PlayerDbInspect> {
    const blob = await this.readPlayerDbBlob(dbPath, id, tableOverride);
    return this.inspectPlayerBlobHex(blob.dataHex, blob.id);
  }

  async exportPlayerDbJson(payload: PlayerDbExportPayload): Promise<void> {
    return invoke<void>('export_player_db_json', { payload });
  }

  async inspectPlayerBlobHex(hex: string, id = 0): Promise<PlayerDbInspect> {
    const bytes = this.hexToBytes(hex);
    if (!bytes) {
      return { id, size: 0, strings: [] };
    }
    const strings = this.inspectPlayerBytes(bytes);
    return { id, size: bytes.length, strings };
  }

  async extractDeathCauseFromBlobHex(hex: string): Promise<string | null> {
    return invoke<string | null>('extract_player_death_cause_from_blob', { dataHex: hex });
  }

  async extractPlayerBlobText(hex: string): Promise<PlayerBlobTextFile[]> {
    return invoke<PlayerBlobTextFile[]>('extract_player_blob_text', { dataHex: hex });
  }

  private async readPlayerEntry(
    dbPath: string,
    id: number,
    tableOverride?: string,
  ): Promise<PlayerDbEntry | null> {
    const db = await this.getDb(dbPath);
    const table = await this.getPlayersTable(dbPath, db, tableOverride);
    const columns = await this.getTableColumns(dbPath, db, table);
    const selectCols = ['id', 'name', 'wx', 'wy', 'x', 'y', 'z', 'worldVersion', 'isDead', 'dataLen']
      .filter((col) => columns.has(col.toLowerCase()));
    const query = selectCols.length ? selectCols.join(', ') : '*';
    const rows = await db.select<SqlRow[]>(`SELECT ${query} FROM ${table} WHERE id = ?1`, [id]);
    const row = rows[0];
    if (!row) {
      return null;
    }
    return this.mapPlayerEntry(row, columns);
  }

  private mapPlayerEntry(row: SqlRow, columns: Set<string>): PlayerDbEntry {
    const dataLen = this.toNumber(this.getColumn(row, ['dataLen', 'datalen']));
    return {
      id: this.toNumber(this.getColumn(row, ['id'])) ?? 0,
      name: this.toStringOrNull(this.getColumn(row, ['name'])),
      wx: this.toNumber(this.getColumn(row, ['wx'])) ?? 0,
      wy: this.toNumber(this.getColumn(row, ['wy'])) ?? 0,
      x: this.toNumber(this.getColumn(row, ['x'])) ?? 0,
      y: this.toNumber(this.getColumn(row, ['y'])) ?? 0,
      z: this.toNumber(this.getColumn(row, ['z'])) ?? 0,
      worldVersion: this.toNumber(this.getColumn(row, ['worldVersion', 'world_version'])) ?? 0,
      isDead: this.toBoolean(this.getColumn(row, ['isDead', 'is_dead'])) ?? false,
      dataLen: dataLen ?? 0,
      death_cause: undefined,
    };
  }

  private async getDb(dbPath: string): Promise<Database> {
    if (!this.dbCache.has(dbPath)) {
      this.dbCache.set(dbPath, Database.load(`sqlite:${dbPath}`));
    }
    return this.dbCache.get(dbPath)!;
  }

  private async getPlayersTable(
    dbPath: string,
    db: Database,
    tableOverride?: string,
  ): Promise<string> {
    if (tableOverride) {
      return tableOverride;
    }
    if (!this.tableCache.has(dbPath)) {
      this.tableCache.set(dbPath, this.resolvePlayersTable(db));
    }
    return this.tableCache.get(dbPath)!;
  }

  private async resolvePlayersTable(db: Database): Promise<string> {
    const rows = await db.select<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    const tableNames = rows.map((row) => row.name).filter((name) => !!name);
    if (tableNames.includes('players')) {
      return 'players';
    }
    const hasLocal = tableNames.includes('localPlayers');
    const hasNetwork = tableNames.includes('networkPlayers');
    if (hasLocal) {
      const count = await this.getTableRowCount(db, 'localPlayers');
      if (count > 0 || !hasNetwork) {
        return 'localPlayers';
      }
    }
    if (hasNetwork) {
      const count = await this.getTableRowCount(db, 'networkPlayers');
      if (count > 0 || !hasLocal) {
        return 'networkPlayers';
      }
    }
    for (const name of tableNames) {
      const columns = await this.getTableColumns('temp', db, name);
      if (columns.has('data') && columns.has('id')) {
        return name;
      }
    }
    throw new Error('No suitable players table found.');
  }

  private async getTableColumns(
    dbPath: string,
    db: Database,
    table: string,
  ): Promise<Set<string>> {
    const cacheKey = `${dbPath}::${table}`;
    if (!this.columnCache.has(cacheKey)) {
      const promise = (async () => {
        const rows = await db.select<Array<{ name: string }>>(
          `PRAGMA table_info(${this.quoteIdent(table)})`,
        );
        const names = rows.map((row) => (row.name ?? '').toLowerCase()).filter((name) => !!name);
        return new Set(names);
      })();
      this.columnCache.set(cacheKey, promise);
    }
    return this.columnCache.get(cacheKey)!;
  }

  private async getTableRowCount(db: Database, table: string): Promise<number> {
    try {
      const rows = await db.select<Array<{ count: number }>>(
        `SELECT COUNT(1) as count FROM ${this.quoteIdent(table)}`,
      );
      return rows?.[0]?.count ?? 0;
    } catch {
      return 0;
    }
  }

  private quoteIdent(value: string): string {
    const safe = value.replace(/\"/g, '""');
    return `"${safe}"`;
  }

  private getColumn(row: SqlRow, candidates: string[]): SqlValue {
    for (const key of candidates) {
      if (key in row) {
        return row[key] as SqlValue;
      }
    }
    const lowerMap = new Map<string, string>();
    for (const key of Object.keys(row)) {
      lowerMap.set(key.toLowerCase(), key);
    }
    for (const key of candidates) {
      const match = lowerMap.get(key.toLowerCase());
      if (match) {
        return row[match] as SqlValue;
      }
    }
    return null;
  }

  private toNumber(value: SqlValue): number | null {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private toBoolean(value: SqlValue): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    if (typeof value === 'string') {
      return value === '1' || value.toLowerCase() === 'true';
    }
    return null;
  }

  private toStringOrNull(value: SqlValue): string | null {
    if (value === null || value === undefined) {
      return null;
    }
    return String(value);
  }

  private toBytes(value: SqlValue): Uint8Array | null {
    if (!value) {
      return null;
    }
    if (value instanceof Uint8Array) {
      return value;
    }
    if (value instanceof ArrayBuffer) {
      return new Uint8Array(value);
    }
    if (Array.isArray(value)) {
      return new Uint8Array(value);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (this.isHex(trimmed)) {
        return this.hexToBytes(trimmed);
      }
      const decoded = this.base64ToBytes(trimmed);
      return decoded ?? null;
    }
    return null;
  }

  private isHex(value: string): boolean {
    return value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
  }

  private hexToBytes(hex: string): Uint8Array | null {
    const cleaned = hex.replace(/\s+/g, '');
    if (cleaned.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(cleaned)) {
      return null;
    }
    const out = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < cleaned.length; i += 2) {
      out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
    }
    return out;
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private base64ToBytes(value: string): Uint8Array | null {
    try {
      const normalized = value.replace(/^[a-z]+:;base64,/i, '');
      const binary = atob(normalized);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        out[i] = binary.charCodeAt(i);
      }
      return out;
    } catch {
      return null;
    }
  }

  private inspectPlayerBytes(data: Uint8Array): PlayerDbInspect['strings'] {
    const hits: PlayerDbInspect['strings'] = [];
    let i = 0;
    while (i + 2 < data.length) {
      const len = data[i] | (data[i + 1] << 8);
      if (len >= 3 && len <= 256 && i + 2 + len <= data.length) {
        const slice = data.subarray(i + 2, i + 2 + len);
        const text = new TextDecoder('utf-8').decode(slice);
        if ([...text].every((ch) => ch >= ' ' || ch === '\n' || ch === '\r' || ch === '\t')) {
          hits.push({ offset: i, length: len, value: text });
          i += 2 + len;
          continue;
        }
      }
      i += 1;
    }
    return hits;
  }
}
