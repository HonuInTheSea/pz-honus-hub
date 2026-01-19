import { AfterViewInit, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { TextareaModule } from 'primeng/textarea';
import { MessageModule } from 'primeng/message';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TagModule } from 'primeng/tag';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { join } from '@tauri-apps/api/path';
import { PlayerDbService } from '../../services/player-db.service';
import { TauriStoreService } from '../../services/tauri-store.service';
import { LoadoutsService } from '../../services/loadouts.service';
import { PzDefaultPathsService } from '../../services/pz-default-paths.service';
import { AvatarRenderer } from '../../utils/avatar-renderer';
import {
  type PlayerVisualProfile,
  parsePlayerBlobBytes,
  parsePlayerBlobHex,
  parsePlayerBlobSummary,
} from '../../utils/pz-player-parser';
import { PzMediaResolver } from '../../utils/pz-media-resolver';
import type {
  PlayerDbBlob,
  PlayerDbEntry,
  PlayerDbExportPayload,
  PlayerDbInspect,
  PlayerDbStringHit,
  PlayerDbUpdate,
} from '../../models/player-db.models';

type DbOption = { label: string; value: string };

@Component({
  selector: 'app-players-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    CardModule,
    ButtonModule,
    InputTextModule,
    TableModule,
    TextareaModule,
    MessageModule,
    ToggleSwitchModule,
    TagModule,
  ],
  templateUrl: './players.page.html',
  styleUrl: './players.page.css',
})
export class PlayersPageComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('avatarHost') avatarHost?: ElementRef<HTMLDivElement>;

  userDir = '';
  mediaDir = '';
  modMediaDir = '';
  userDirPlaceholder = '';
  mediaDirPlaceholder = '';
  modMediaDirPlaceholder = '';
  dbPaths: string[] = [];
  dbOptions: DbOption[] = [];
  selectedDbPath = '';
  players: PlayerDbEntry[] = [];
  selectedPlayer: PlayerDbEntry | null = null;
  playerBlob: PlayerDbBlob | null = null;
  inspect: PlayerDbInspect | null = null;
  errorMessage = '';
  loading = false;
  saving = false;
  backupEnabled = true;

  draftName = '';
  draftX = 0;
  draftY = 0;
  draftZ = 0;
  draftIsDead = false;
  draftDeathCause = '';
  draftDataHex = '';
  draftDataBytes: Uint8Array | null = null;
  metaDirty = false;
  hexDirty = false;
  hexError = '';
  stringEdits: Record<string, string> = {};
  jsonPreview = '';
  parsedBlobSummary = '';
  jsonImportError = '';
  hexDumpOffset = 0;
  hexDumpBytesPerRow = 16;
  hexDumpRows = 24;
  hexDumpText = '';
  diffFileA = '';
  diffFileB = '';
  diffSummary = '';
  diffPayloadA: PlayerDbExportPayload | null = null;
  diffPayloadB: PlayerDbExportPayload | null = null;
  diffMetaRows: Array<{ field: string; a: string; b: string; changed: boolean }> = [];
  diffStringRows: Array<{ key: string; a: string; b: string; changed: boolean }> = [];
  diffHashA = '';
  diffHashB = '';
  safePatchMode = true;
  playersTableMode: 'auto' | 'localPlayers' | 'networkPlayers' = 'auto';
  blobTextFiles: Array<{ name: string; text: string; decodedText?: string }> = [];
  hexSearch = '';
  asciiSearch = '';
  searchResults: number[] = [];
  visualProfile: PlayerVisualProfile | null = null;
  visualError = '';
  avatarLogs: string[] = [];
  private avatarRenderer: AvatarRenderer | null = null;
  private mediaResolver: PzMediaResolver | null = null;

  constructor(
    private readonly playersApi: PlayerDbService,
    private readonly store: TauriStoreService,
    private readonly loadoutsApi: LoadoutsService,
    private readonly zone: NgZone,
    private readonly pzDefaults: PzDefaultPathsService,
  ) {}

  async ngOnInit(): Promise<void> {
    const storedUserDir = await this.store.getItem<string>('pz_user_dir');
    const storedMediaDir = await this.store.getItem<string>('pz_media_dir');
    const storedModMediaDir = await this.store.getItem<string>('pz_mod_media_dir');
    const defaultUserDir = await this.loadoutsApi.getDefaultZomboidUserDir();
    const defaultGameDir = await this.pzDefaults.getDefaultGameDir();
    const defaultMediaDir = await join(defaultGameDir, 'media');
    this.userDirPlaceholder = await this.pzDefaults.getDefaultUserDirExample();
    this.mediaDirPlaceholder = await this.pzDefaults.getDefaultMediaDirExample();
    this.modMediaDirPlaceholder =
      await this.pzDefaults.getDefaultWorkshopModMediaDirExample();
    this.userDir = (storedUserDir ?? '').trim() || (defaultUserDir ?? '').trim();
    this.mediaDir = (storedMediaDir ?? '').trim() || defaultMediaDir;
    this.modMediaDir = (storedModMediaDir ?? '').trim();
    this.mediaResolver = new PzMediaResolver(
      (path) => this.loadoutsApi.readTextFile(path),
      (mediaDir, modMediaDir) => this.loadoutsApi.listMediaScripts(mediaDir, modMediaDir),
      this.mediaDir,
      this.modMediaDir,
    );
    if (this.userDir) {
      await this.onScanSaves();
    }
  }

  ngAfterViewInit(): void {
    if (this.avatarHost?.nativeElement) {
      this.avatarRenderer = new AvatarRenderer(
        this.avatarHost.nativeElement,
        (msg) => this.pushAvatarLog(msg),
      );
      this.syncAvatar();
    }
  }

  ngOnDestroy(): void {
    this.avatarRenderer?.destroy();
    this.avatarRenderer = null;
  }

  async onScanSaves(): Promise<void> {
    this.errorMessage = '';
    if (!this.userDir.trim()) {
      this.errorMessage = 'Set your Zomboid user folder first.';
      return;
    }
    try {
      this.dbPaths = await this.playersApi.listSavePlayerDbs(this.userDir);
      this.dbOptions = this.dbPaths.map((path) => ({
        label: this.describeDbPath(path),
        value: path,
      }));
    } catch (err: unknown) {
      this.errorMessage = this.describeError(err, 'Failed to scan for players.db.');
    }
  }

  async onBrowseDb(): Promise<void> {
    this.errorMessage = '';
    const result = await openDialog({
      multiple: false,
      filters: [{ name: 'players.db', extensions: ['db'] }],
    });
    if (!result || typeof result !== 'string') {
      return;
    }
    this.selectedDbPath = result;
    if (!this.dbPaths.includes(result)) {
      this.dbPaths = [result, ...this.dbPaths];
      this.dbOptions = this.dbPaths.map((path) => ({
        label: this.describeDbPath(path),
        value: path,
      }));
    }
    await this.onDbSelected();
  }

  async onBrowseMediaDir(): Promise<void> {
    const result = await openDialog({
      directory: true,
      multiple: false,
    });
    if (!result || typeof result !== 'string') {
      return;
    }
    this.mediaDir = result;
    await this.onMediaDirUpdated();
  }

  async onMediaDirUpdated(): Promise<void> {
    await this.store.setItem('pz_media_dir', this.mediaDir);
    if (this.mediaResolver) {
      this.mediaResolver.setMediaDirs(this.mediaDir, this.modMediaDir);
    } else {
      this.mediaResolver = new PzMediaResolver(
        (path) => this.loadoutsApi.readTextFile(path),
        (mediaDir, modMediaDir) => this.loadoutsApi.listMediaScripts(mediaDir, modMediaDir),
        this.mediaDir,
        this.modMediaDir,
      );
    }
    this.syncAvatar();
  }

  async onBrowseModMediaDir(): Promise<void> {
    const result = await openDialog({
      directory: true,
      multiple: false,
    });
    if (!result || typeof result !== 'string') {
      return;
    }
    this.modMediaDir = result;
    await this.onModMediaDirUpdated();
  }

  async onModMediaDirUpdated(): Promise<void> {
    await this.store.setItem('pz_mod_media_dir', this.modMediaDir);
    if (this.mediaResolver) {
      this.mediaResolver.setMediaDirs(this.mediaDir, this.modMediaDir);
    } else {
      this.mediaResolver = new PzMediaResolver(
        (path) => this.loadoutsApi.readTextFile(path),
        (mediaDir, modMediaDir) => this.loadoutsApi.listMediaScripts(mediaDir, modMediaDir),
        this.mediaDir,
        this.modMediaDir,
      );
    }
    this.syncAvatar();
  }

  async onDbSelected(): Promise<void> {
    if (!this.selectedDbPath) {
      return;
    }
    await this.loadPlayers();
  }

  async onPlayersTableChanged(): Promise<void> {
    if (!this.selectedDbPath) {
      return;
    }
    await this.loadPlayers();
  }

  async loadPlayers(): Promise<void> {
    this.errorMessage = '';
    this.loading = true;
    this.players = [];
    this.selectedPlayer = null;
    this.playerBlob = null;
    this.inspect = null;
    try {
      this.players = await this.playersApi.readPlayersDb(
        this.selectedDbPath,
        this.getTableOverride(),
      );
      if (this.players.length > 0) {
        this.selectPlayer(this.players[0]);
      }
    } catch (err: unknown) {
      this.errorMessage = this.describeError(err, 'Failed to load players.db.');
    } finally {
      this.loading = false;
    }
  }

  async selectPlayer(player: PlayerDbEntry): Promise<void> {
    if (!player) {
      return;
    }
    this.selectedPlayer = player;
    await this.loadPlayerBlob();
  }

  async loadPlayerBlob(): Promise<void> {
    if (!this.selectedDbPath || !this.selectedPlayer) {
      return;
    }
    this.errorMessage = '';
    this.loading = true;
    try {
      this.playerBlob = await this.playersApi.readPlayerDbBlob(
        this.selectedDbPath,
        this.selectedPlayer.id,
        this.getTableOverride(),
      );
      this.inspect = await this.playersApi.inspectPlayerBlobHex(
        this.playerBlob.dataHex,
        this.playerBlob.id,
      );
      const deathCause = await this.playersApi.extractDeathCauseFromBlobHex(
        this.playerBlob.dataHex,
      );
      if (this.selectedPlayer) {
        this.selectedPlayer = {
          ...this.selectedPlayer,
          death_cause: deathCause ?? this.selectedPlayer.death_cause,
        };
      }
      this.blobTextFiles = this.withDecodedBlobText(
        await this.playersApi.extractPlayerBlobText(this.playerBlob.dataHex),
      );
      this.resetDraft(this.playerBlob);
      this.updateVisualProfile(this.draftDataBytes, this.playerBlob.dataHex);
      this.jsonPreview = this.buildJsonPreview();
      this.updateBlobSummary();
      this.updateHexDump();
    } catch (err: unknown) {
      this.errorMessage = this.describeError(err, 'Failed to load player data.');
    } finally {
      this.loading = false;
    }
  }

  async onSaveMetadata(): Promise<void> {
    if (!this.selectedPlayer || !this.playerBlob) {
      return;
    }
    this.saving = true;
    this.errorMessage = '';
    try {
      const update: PlayerDbUpdate = {
        id: this.selectedPlayer.id,
        isDead: this.draftIsDead,
        death_cause: this.draftDeathCause,
        backup: this.backupEnabled,
      };
      const updated = await this.playersApi.updatePlayerDbEntry(
        this.selectedDbPath,
        update,
        this.getTableOverride(),
      );
      this.applyUpdatedEntry(updated);
    } catch (err: unknown) {
      this.errorMessage = this.describeError(err, 'Failed to save metadata.');
    } finally {
      this.saving = false;
    }
  }

  async onSaveBlob(): Promise<void> {
    if (!this.selectedPlayer || !this.playerBlob) {
      return;
    }
    if (this.hexError) {
      return;
    }
    if (this.safePatchMode && !this.isSafeBlobMutation()) {
      this.errorMessage =
        'Safe patch mode is enabled. Blob edits are restricted to same-length string replacements.';
      return;
    }
    this.saving = true;
    this.errorMessage = '';
    try {
      const update: PlayerDbUpdate = {
        id: this.selectedPlayer.id,
        name: this.draftName,
        x: this.draftX,
        y: this.draftY,
        z: this.draftZ,
        isDead: this.draftIsDead,
        dataHex: this.draftDataHex,
        death_cause: this.draftDeathCause,
        backup: this.backupEnabled,
      };
      const updated = await this.playersApi.updatePlayerDbEntry(
        this.selectedDbPath,
        update,
        this.getTableOverride(),
      );
      this.applyUpdatedEntry(updated, true);
      this.inspect = await this.playersApi.inspectPlayerBlobHex(
        this.draftDataHex,
        this.selectedPlayer.id,
      );
      this.jsonPreview = this.buildJsonPreview();
      this.updateHexDump();
    } catch (err: unknown) {
      this.errorMessage = this.describeError(err, 'Failed to save blob data.');
    } finally {
      this.saving = false;
    }
  }

  async onApplySafePatch(): Promise<void> {
    if (!this.selectedPlayer || !this.playerBlob) {
      return;
    }
    if (this.hexError) {
      this.errorMessage = this.hexError;
      return;
    }
    if (this.metaDirty) {
      await this.onSaveMetadata();
    }
    if (this.hexDirty) {
      await this.onSaveBlob();
    }
  }

  onSearchBlob(): void {
    const bytes = this.draftDataBytes ?? this.hexToBytes(this.draftDataHex);
    if (!bytes) {
      return;
    }
    this.searchResults = [];
    const hexNeedle = this.normalizeHex(this.hexSearch);
    const asciiNeedle = (this.asciiSearch ?? '').trim();
    if (!hexNeedle && !asciiNeedle) {
      return;
    }
    let needleBytes: Uint8Array | null = null;
    if (hexNeedle) {
      if (hexNeedle.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hexNeedle)) {
        this.errorMessage = 'Hex search input is invalid.';
        return;
      }
      needleBytes = this.hexToBytes(hexNeedle);
    } else if (asciiNeedle) {
      needleBytes = new TextEncoder().encode(asciiNeedle);
    }
    if (!needleBytes || needleBytes.length === 0) {
      return;
    }
    for (let i = 0; i <= bytes.length - needleBytes.length; i += 1) {
      let match = true;
      for (let j = 0; j < needleBytes.length; j += 1) {
        if (bytes[i + j] !== needleBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        this.searchResults.push(i);
      }
      if (this.searchResults.length >= 200) {
        break;
      }
    }
  }

  jumpToSearchOffset(offset: number): void {
    this.hexDumpOffset = offset;
    this.updateHexDump();
  }

  async onReloadPlayer(): Promise<void> {
    await this.loadPlayerBlob();
  }

  async onExportJson(): Promise<void> {
    if (!this.selectedPlayer || !this.playerBlob) {
      return;
    }
    const payload: PlayerDbExportPayload = {
      dbPath: this.selectedDbPath,
      player: this.selectedPlayer,
      blobHex: this.draftDataHex,
      strings: this.inspect?.strings ?? [],
      exportedAt: new Date().toISOString(),
    };
    await this.playersApi.exportPlayerDbJson(payload);
  }

  async onImportJson(): Promise<void> {
    this.jsonImportError = '';
    const result = await openDialog({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!result || typeof result !== 'string') {
      return;
    }
    let text = '';
    try {
      text = await this.loadoutsApi.readTextFile(result);
    } catch (err: unknown) {
      this.jsonImportError = this.describeError(err, 'Failed to read JSON file.');
      return;
    }
    let parsed: PlayerDbExportPayload | null = null;
    try {
      parsed = JSON.parse(text) as PlayerDbExportPayload;
    } catch {
      this.jsonImportError = 'Invalid JSON.';
      return;
    }
    if (!parsed || !parsed.player || !parsed.blobHex) {
      this.jsonImportError = 'JSON is missing required player data.';
      return;
    }
    this.draftName = parsed.player.name ?? '';
    this.draftX = parsed.player.x;
    this.draftY = parsed.player.y;
    this.draftZ = parsed.player.z;
    this.draftIsDead = parsed.player.isDead;
    this.draftDataHex = parsed.blobHex;
    this.draftDataBytes = this.hexToBytes(parsed.blobHex);
    this.hexError = this.validateHex();
    this.metaDirty = true;
    this.hexDirty = true;
    this.blobTextFiles = this.withDecodedBlobText(
      await this.playersApi.extractPlayerBlobText(parsed.blobHex),
    );
    this.updateBlobSummary();
    this.updateHexDump();
  }

  applyStringHit(hit: PlayerDbStringHit, index: number): void {
    const key = String(index);
    const next = (this.stringEdits[key] ?? hit.value).trim();
    if (!next) {
      return;
    }
    const encoded = new TextEncoder().encode(next);
    if (encoded.length !== hit.length) {
      this.errorMessage = `String "${hit.value}" must stay ${hit.length} bytes.`;
      return;
    }
    const bytes = this.draftDataBytes ?? this.hexToBytes(this.draftDataHex);
    if (!bytes) {
      return;
    }
    const start = hit.offset + 2;
    for (let i = 0; i < encoded.length; i += 1) {
      bytes[start + i] = encoded[i];
    }
    this.draftDataHex = this.bytesToHex(bytes);
    this.draftDataBytes = bytes;
    this.onHexChanged();
    this.updateHexDump();
  }

  applyPreset(preset: string): void {
    switch (preset) {
      case 'snap':
        this.draftX = Math.round(this.draftX);
        this.draftY = Math.round(this.draftY);
        this.draftZ = Math.round(this.draftZ);
        break;
      case 'ground':
        this.draftZ = 0;
        break;
      case 'alive':
        this.draftIsDead = false;
        break;
      case 'dead':
        this.draftIsDead = true;
        break;
      case 'center':
        this.draftX = 0;
        this.draftY = 0;
        this.draftZ = 0;
        break;
      default:
        return;
    }
    this.onMetaChanged();
  }

  onMetaChanged(): void {
    this.metaDirty = this.isMetaDirty();
  }

  onHexChanged(): void {
    this.hexError = this.validateHex();
    this.hexDirty = this.isHexDirty();
    if (!this.hexError) {
      this.draftDataBytes = this.hexToBytes(this.draftDataHex);
      this.updateVisualProfile(this.draftDataBytes, this.draftDataHex);
      this.updateBlobSummary();
      this.updateHexDump();
    } else {
      this.draftDataBytes = null;
      this.hexDumpText = '';
      this.parsedBlobSummary = '';
    }
  }

  get dataByteLength(): number {
    if (this.draftDataBytes) {
      return this.draftDataBytes.length;
    }
    const normalized = this.normalizeHex(this.draftDataHex);
    return Math.floor(normalized.length / 2);
  }

  private resetDraft(blob: PlayerDbBlob): void {
    this.draftName = blob.name ?? '';
    this.draftX = blob.x;
    this.draftY = blob.y;
    this.draftZ = blob.z;
    this.draftIsDead = blob.isDead;
    this.draftDeathCause = this.selectedPlayer?.death_cause ?? '';
    this.draftDataHex = blob.dataHex;
    this.draftDataBytes = blob.dataBytes ? new Uint8Array(blob.dataBytes) : this.hexToBytes(blob.dataHex);
    this.metaDirty = false;
    this.hexDirty = false;
    this.hexError = '';
    this.stringEdits = {};
    this.hexDumpOffset = 0;
    this.updateHexDump();
  }

  private applyUpdatedEntry(updated: PlayerDbEntry, includeBlob = false): void {
    this.players = this.players.map((p) => (p.id === updated.id ? updated : p));
    if (this.selectedPlayer && this.selectedPlayer.id === updated.id) {
      this.selectedPlayer = updated;
    }
    if (this.playerBlob && this.playerBlob.id === updated.id) {
      this.playerBlob = {
        ...this.playerBlob,
        name: updated.name,
        wx: updated.wx,
        wy: updated.wy,
        x: updated.x,
        y: updated.y,
        z: updated.z,
        worldVersion: updated.worldVersion,
        isDead: updated.isDead,
        dataHex: includeBlob ? this.draftDataHex : this.playerBlob.dataHex,
      };
      if (includeBlob) {
        this.playerBlob.dataBytes = this.draftDataBytes ?? undefined;
      }
      this.updateVisualProfile(this.draftDataBytes, this.playerBlob.dataHex);
    }
    this.metaDirty = false;
    this.hexDirty = false;
  }

  private isMetaDirty(): boolean {
    if (!this.playerBlob) {
      return false;
    }
    const name = this.draftName ?? '';
    const baseName = this.playerBlob.name ?? '';
    return (
      name !== baseName ||
      this.draftX !== this.playerBlob.x ||
      this.draftY !== this.playerBlob.y ||
      this.draftZ !== this.playerBlob.z ||
      this.draftIsDead !== this.playerBlob.isDead ||
      this.draftDeathCause !== (this.selectedPlayer?.death_cause ?? '')
    );
  }

  private isHexDirty(): boolean {
    if (!this.playerBlob) {
      return false;
    }
    return (
      this.normalizeHex(this.draftDataHex) !==
      this.normalizeHex(this.playerBlob.dataHex)
    );
  }

  private normalizeHex(value: string): string {
    return (value ?? '').replace(/\s+/g, '').toLowerCase();
  }

  private updateVisualProfile(bytes: Uint8Array | null, hex: string): void {
    try {
      const worldVersion = this.getWorldVersion();
      this.visualProfile = bytes
        ? parsePlayerBlobBytes(bytes, worldVersion)
        : parsePlayerBlobHex(hex, worldVersion);
      this.visualError = '';
    } catch (err) {
      this.visualProfile = null;
      this.visualError = err instanceof Error ? err.message : String(err);
    }
    this.avatarLogs = [];
    this.syncAvatar();
  }

  private updateBlobSummary(): void {
    if (!this.draftDataBytes) {
      this.parsedBlobSummary = '';
      return;
    }
    try {
      const worldVersion = this.getWorldVersion();
      const summary = parsePlayerBlobSummary(this.draftDataBytes, worldVersion);
      this.parsedBlobSummary = JSON.stringify(summary, null, 2);
    } catch (err) {
      this.parsedBlobSummary = `Parse error: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }

  private getWorldVersion(): number {
    const value = this.playerBlob?.worldVersion ?? 0;
    return value > 0 ? value : 240;
  }

  private syncAvatar(): void {
    if (!this.avatarRenderer) {
      return;
    }
    if (this.mediaResolver?.getMediaRoots) {
      const roots = this.mediaResolver.getMediaRoots();
      const label = roots.length ? roots.join(' | ') : 'none';
      this.pushAvatarLog(`media roots: ${label}`);
    }
    this.avatarRenderer.setProfile(this.visualProfile, this.mediaResolver ?? undefined);
  }

  private pushAvatarLog(message: string): void {
    this.zone.run(() => {
      this.avatarLogs = [...this.avatarLogs, message].slice(-40);
    });
  }

  private validateHex(): string {
    const normalized = this.normalizeHex(this.draftDataHex);
    if (!normalized) {
      return '';
    }
    if (normalized.length % 2 !== 0) {
      return 'Hex length must be even.';
    }
    if (!/^[0-9a-f]+$/.test(normalized)) {
      return 'Hex contains non-hex characters.';
    }
    return '';
  }

  private hexToBytes(hex: string): Uint8Array | null {
    const normalized = this.normalizeHex(hex);
    if (normalized.length % 2 !== 0 || !/^[0-9a-f]*$/.test(normalized)) {
      this.errorMessage = 'Hex contains invalid characters.';
      return null;
    }
    const out = new Uint8Array(normalized.length / 2);
    for (let i = 0; i < normalized.length; i += 2) {
      out[i / 2] = parseInt(normalized.slice(i, i + 2), 16);
    }
    return out;
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private withDecodedBlobText(
    files: Array<{ name: string; text: string }>,
  ): Array<{ name: string; text: string; decodedText?: string }> {
    return files.map((file) => ({
      ...file,
      decodedText: this.tryBase64Decode(file.text) ?? undefined,
    }));
  }

  private tryBase64Decode(value: string): string | null {
    const trimmed = (value ?? '').trim();
    if (!trimmed || trimmed.length < 12) {
      return null;
    }
    const normalized = trimmed.replace(/\s+/g, '');
    if (!/^[a-zA-Z0-9+/=]+$/.test(normalized) || normalized.length % 4 !== 0) {
      return null;
    }
    try {
      const decoded = atob(normalized);
      const text = decoded.replace(/\r\n/g, '\n');
      const printable = [...text].filter(
        (ch) => ch === '\n' || ch === '\r' || ch === '\t' || (ch >= ' ' && ch <= '~'),
      ).length;
      const ratio = printable / Math.max(1, text.length);
      return ratio >= 0.7 ? text : null;
    } catch {
      return null;
    }
  }

  private buildJsonPreview(): string {
    if (!this.selectedPlayer || !this.playerBlob) {
      return '';
    }
    const payload: PlayerDbExportPayload = {
      dbPath: this.selectedDbPath,
      player: this.selectedPlayer,
      blobHex: this.draftDataHex,
      strings: this.inspect?.strings ?? [],
      exportedAt: new Date().toISOString(),
    };
    return JSON.stringify(payload, null, 2);
  }

  updateHexDump(): void {
    const bytes = this.draftDataBytes ?? this.hexToBytes(this.draftDataHex);
    if (!bytes) {
      this.hexDumpText = '';
      return;
    }
    const offset = Math.max(0, Math.floor(this.hexDumpOffset));
    const bytesPerRow = Math.max(8, Math.min(32, Math.floor(this.hexDumpBytesPerRow)));
    const rows = Math.max(1, Math.min(200, Math.floor(this.hexDumpRows)));
    const lines: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      const start = offset + row * bytesPerRow;
      if (start >= bytes.length) {
        break;
      }
      const slice = bytes.slice(start, start + bytesPerRow);
      const hexPart = Array.from(slice)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      const asciiPart = Array.from(slice)
        .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
        .join('');
      lines.push(
        `${start.toString(16).padStart(8, '0')}  ${hexPart.padEnd(bytesPerRow * 3)} ${asciiPart}`,
      );
    }
    this.hexDumpText = lines.join('\n');
  }

  jumpToOffset(): void {
    this.hexDumpOffset = Math.max(0, Math.floor(this.hexDumpOffset));
    this.updateHexDump();
  }

  async loadDiffFile(which: 'a' | 'b'): Promise<void> {
    const result = await openDialog({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (!result || typeof result !== 'string') {
      return;
    }
    let text = '';
    try {
      text = await this.loadoutsApi.readTextFile(result);
    } catch (err: unknown) {
      this.diffSummary = this.describeError(err, 'Failed to read JSON file.');
      return;
    }
    if (which === 'a') {
      this.diffFileA = text;
    } else {
      this.diffFileB = text;
    }
    this.computeJsonDiff();
  }

  computeJsonDiff(): void {
    if (!this.diffFileA || !this.diffFileB) {
      this.diffSummary = '';
      return;
    }
    let a: PlayerDbExportPayload | null = null;
    let b: PlayerDbExportPayload | null = null;
    try {
      a = JSON.parse(this.diffFileA) as PlayerDbExportPayload;
      b = JSON.parse(this.diffFileB) as PlayerDbExportPayload;
    } catch {
      this.diffSummary = 'Invalid JSON in one of the diff files.';
      return;
    }
    if (!a?.player || !b?.player) {
      this.diffSummary = 'JSON payload missing player data.';
      return;
    }
    this.diffPayloadA = a;
    this.diffPayloadB = b;
    const diffs: string[] = [];
    const fields: Array<keyof PlayerDbEntry> = [
      'name',
      'x',
      'y',
      'z',
      'isDead',
      'worldVersion',
      'dataLen',
    ];
    for (const key of fields) {
      const left = a.player[key];
      const right = b.player[key];
      if (left !== right) {
        diffs.push(`${key}: "${left}" -> "${right}"`);
      }
    }
    const blobEqual = (a.blobHex ?? '') === (b.blobHex ?? '');
    if (!blobEqual) {
      diffs.push('blobHex: differs');
    }
    const stringDiffs = this.diffStrings(a.strings ?? [], b.strings ?? []);
    diffs.push(...stringDiffs);
    this.diffSummary = diffs.length ? diffs.join('\n') : 'No differences found.';
    this.diffMetaRows = fields.map((field) => {
      const left = `${a.player[field] ?? ''}`;
      const right = `${b.player[field] ?? ''}`;
      return { field, a: left, b: right, changed: left !== right };
    });
    this.diffHashA = this.hashHex(a.blobHex ?? '');
    this.diffHashB = this.hashHex(b.blobHex ?? '');
    this.diffStringRows = this.buildStringRows(a.strings ?? [], b.strings ?? []);
  }

  private diffStrings(a: PlayerDbStringHit[], b: PlayerDbStringHit[]): string[] {
    const out: string[] = [];
    const mapA = new Map<string, string>();
    for (const hit of a) {
      mapA.set(`${hit.offset}:${hit.length}`, hit.value);
    }
    for (const hit of b) {
      const key = `${hit.offset}:${hit.length}`;
      const left = mapA.get(key);
      if (left == null) {
        out.push(`string added @${key}: "${hit.value}"`);
        continue;
      }
      if (left !== hit.value) {
        out.push(`string @${key}: "${left}" -> "${hit.value}"`);
      }
      mapA.delete(key);
    }
    for (const [key, value] of mapA.entries()) {
      out.push(`string removed @${key}: "${value}"`);
    }
    return out;
  }

  private buildStringRows(
    a: PlayerDbStringHit[],
    b: PlayerDbStringHit[],
  ): Array<{ key: string; a: string; b: string; changed: boolean }> {
    const out: Array<{ key: string; a: string; b: string; changed: boolean }> = [];
    const mapA = new Map<string, string>();
    for (const hit of a) {
      mapA.set(`${hit.offset}:${hit.length}`, hit.value);
    }
    const used = new Set<string>();
    for (const hit of b) {
      const key = `${hit.offset}:${hit.length}`;
      const left = mapA.get(key) ?? '';
      const right = hit.value ?? '';
      out.push({ key, a: left, b: right, changed: left !== right });
      used.add(key);
    }
    for (const [key, value] of mapA.entries()) {
      if (used.has(key)) {
        continue;
      }
      out.push({ key, a: value, b: '', changed: true });
    }
    return out.sort((x, y) => x.key.localeCompare(y.key));
  }

  private hashHex(hex: string): string {
    const normalized = this.normalizeHex(hex);
    let hash = 0x811c9dc5;
    for (let i = 0; i < normalized.length; i += 2) {
      const byte = parseInt(normalized.slice(i, i + 2), 16);
      hash ^= byte;
      hash = (hash * 0x01000193) >>> 0;
    }
    return `fnv1a-${hash.toString(16).padStart(8, '0')}`;
  }

  private isSafeBlobMutation(): boolean {
    if (!this.playerBlob || !this.inspect) {
      return false;
    }
    const original = this.playerBlob.dataBytes ?? this.hexToBytes(this.playerBlob.dataHex);
    const current = this.draftDataBytes ?? this.hexToBytes(this.draftDataHex);
    if (!original || !current || original.length !== current.length) {
      return false;
    }
    const allowedRanges = (this.inspect.strings ?? []).map((hit) => ({
      start: hit.offset + 2,
      end: hit.offset + 2 + hit.length,
    }));
    const isAllowed = (index: number): boolean =>
      allowedRanges.some((range) => index >= range.start && index < range.end);

    for (let i = 0; i < original.length; i += 1) {
      if (original[i] === current[i]) {
        continue;
      }
      if (!isAllowed(i)) {
        return false;
      }
    }
    return true;
  }

  private describeDbPath(path: string): string {
    const normalizedPath = (path ?? '').replace(/\//g, '\\');
    const normalizedUser = (this.userDir ?? '').trim().replace(/\//g, '\\').replace(/\\+$/, '');
    if (normalizedUser && normalizedPath.toLowerCase().startsWith(normalizedUser.toLowerCase())) {
      const rel = normalizedPath.slice(normalizedUser.length).replace(/^\\+/, '');
      return rel || normalizedPath;
    }
    return normalizedPath;
  }

  private getTableOverride(): string | undefined {
    if (this.playersTableMode === 'auto') {
      return undefined;
    }
    return this.playersTableMode;
  }

  private describeError(err: unknown, fallback: string): string {
    if (err instanceof Error) {
      return err.message;
    }
    if (typeof err === 'string') {
      return err;
    }
    return fallback;
  }
}
