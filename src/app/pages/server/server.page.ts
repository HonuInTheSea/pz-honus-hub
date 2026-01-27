import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { TextareaModule } from 'primeng/textarea';
import { DialogModule } from 'primeng/dialog';
import { ToastModule } from 'primeng/toast';
import { TabsModule } from 'primeng/tabs';
import { MessageService } from 'primeng/api';
import { SelectModule } from 'primeng/select';
import { ListboxModule } from 'primeng/listbox';
import { TooltipModule } from 'primeng/tooltip';
import { RadioButtonModule } from 'primeng/radiobutton';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { ModsPickerDialogComponent } from '../../components/mods-picker-dialog/mods-picker-dialog.component';
import { TauriStoreService } from '../../services/tauri-store.service';
import { LoadoutsService } from '../../services/loadouts.service';
import { LoadoutsStateService } from '../../services/loadouts-state.service';
import type { Loadout } from '../../models/loadout.models';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LocalizationService } from '../../services/localization.service';
import { firstValueFrom, switchMap, take } from 'rxjs';

interface ServerFileSet {
  iniPath: string;
  sandboxVarsPath: string;
  spawnpointsPath: string;
  spawnregionsPath: string;
}

interface IniLine {
  kind: 'entry' | 'comment' | 'blank';
  key?: string;
  value?: string;
  comment?: string;
  raw?: string;
}

@Component({
  selector: 'app-server-page',
  standalone: true,
  providers: [MessageService],
  imports: [
    CommonModule,
    FormsModule,
    CardModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    TextareaModule,
    DialogModule,
    ToastModule,
    TabsModule,
    SelectModule,
    ListboxModule,
    TooltipModule,
    RadioButtonModule,
    TranslocoModule,
    ModsPickerDialogComponent,
  ],
  templateUrl: './server.page.html',
})
export class ServerPageComponent implements OnInit, AfterViewInit {
  @ViewChild('serversCard', { read: ElementRef })
  serversCard?: ElementRef<HTMLElement>;
  @ViewChild('iniListboxHost', { read: ElementRef })
  iniListboxHost?: ElementRef<HTMLElement>;
  @ViewChild('sandboxListboxHost', { read: ElementRef })
  sandboxListboxHost?: ElementRef<HTMLElement>;
  @ViewChild('sandboxTextarea', { read: ElementRef })
  sandboxTextarea?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('spawnpointsTextarea', { read: ElementRef })
  spawnpointsTextarea?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('spawnregionsTextarea', { read: ElementRef })
  spawnregionsTextarea?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('iniActions', { read: ElementRef })
  iniActions?: ElementRef<HTMLElement>;
  @ViewChild('sandboxActions', { read: ElementRef })
  sandboxActions?: ElementRef<HTMLElement>;
  @ViewChild('spawnpointsActions', { read: ElementRef })
  spawnpointsActions?: ElementRef<HTMLElement>;
  @ViewChild('spawnregionsActions', { read: ElementRef })
  spawnregionsActions?: ElementRef<HTMLElement>;
  @ViewChild('serverSelect', { read: ElementRef })
  serverSelect?: ElementRef<HTMLElement>;

  serverNames: string[] = [];
  selectedServerName = '';
  userDir = '';

  iniText = '';
  iniLines: IniLine[] = [];
  iniOriginalValues = new Map<string, string>();
  originalSandboxVarsText = '';
  originalSpawnpointsText = '';
  originalSpawnregionsText = '';
  sandboxVarsText = '';
  spawnpointsText = '';
  spawnregionsText = '';
  sandboxLines: string[] = [];
  sandboxEntries: Array<{
    id: string;
    key: string;
    value: string;
    commentLines: string[];
    lineIndex: number;
    indent: string;
  }> = [];

  loadingServer = false;
  savingServer = false;
  savingIni = false;
  savingSandbox = false;
  savingSpawnpoints = false;
  savingSpawnregions = false;

  createDialogVisible = false;
  newServerName = '';
  copyDialogVisible = false;
  copyServerName = '';
  copySourceName = '';
  deleteDialogVisible = false;
  deletingServer = false;

  presets: Loadout[] = [];
  selectedPresetId = '';
  selectedIniKey = '';
  iniEntryOptions: Array<{ label: string; key: string }> = [];
  selectedSandboxKey = '';
  sandboxEntryOptions: Array<{
    id: string;
    key: string;
    value: string;
    lineIndex: number;
    label: string;
  }> = [];
  iniListboxHeight = 'auto';
  iniListboxScrollHeight = 'auto';
  sandboxTextareaHeight = 'auto';
  spawnpointsTextareaHeight = 'auto';
  spawnregionsTextareaHeight = 'auto';
  sandboxListboxHeight = 'auto';
  sandboxListboxScrollHeight = 'auto';
  activeTab = 'ini';
  serverSelectWidth = 320;
  private readonly cachedTabs = new Set<string>();
  private readonly loadedServerTabs = new Set<string>();
  private readonly iniEntryOptionsByLocale = new Map<
    string,
    Array<{ label: string; key: string }>
  >();
  private sandboxOriginalValues = new Map<string, string>();
  booleanOptions: Array<{ label: string; value: string }> = [];
  editIniVisible = false;
  editIniLine: IniLine | null = null;
  editIniValue = '';
  editIniNumber: number | null = null;
  editIniCommentLines: string[] = [];
  editIniUsesDecimals = false;
  editSandboxVisible = false;
  editSandboxEntry: {
    id: string;
    key: string;
    value: string;
    commentLines: string[];
    lineIndex: number;
    indent: string;
  } | null = null;
  editSandboxValue = '';
  editSandboxNumber: number | null = null;
  editSandboxUsesDecimals = false;
  modsDialogVisible = false;
  modsDialogModsValue = '';
  modsDialogWorkshopValue = '';

  constructor(
    private readonly store: TauriStoreService,
    private readonly loadoutsApi: LoadoutsService,
    private readonly loadoutsState: LoadoutsStateService,
    private readonly messageService: MessageService,
    private readonly transloco: TranslocoService,
    private readonly destroyRef: DestroyRef,
    private readonly http: HttpClient,
    private readonly localization: LocalizationService,
  ) {}

  async ngOnInit(): Promise<void> {
    const storedUserDir = await this.store.getItem<string>('pz_user_dir');
    this.userDir =
      (storedUserDir ?? '').trim() ||
      (await this.loadoutsApi.getDefaultZomboidUserDir()) ||
      '';
    this.presets = await this.loadoutsState.load();
    await this.loadServerTabTranslations(
      this.activeTab,
      this.transloco.getActiveLang() || 'en-US',
    );
    this.refreshBooleanOptions();
    await this.refreshServerList();
    this.transloco.langChanges$
      .pipe(
        switchMap((lang) => this.transloco.selectTranslation(lang).pipe(take(1))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        const lang = this.transloco.getActiveLang() || 'en-US';
        this.refreshBooleanOptions();
        this.applyCachedIniOptions(lang);
        void this.loadServerTabTranslations(this.activeTab, lang);
        this.refreshSandboxEntryOptions();
        if (this.editIniLine) {
          this.editIniCommentLines = this.getIniCommentLines(
            this.editIniLine.key,
            this.editIniLine.comment,
          );
        }
      });

  }

  ngAfterViewInit(): void {
    this.scheduleHeightRecalc();
    this.scheduleTabFocus();
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.scheduleHeightRecalc();
  }

  get serverPresetOptions(): Array<{ label: string; value: string }> {
    return (this.presets ?? [])
      .filter((l) =>
        (l.targetModes ?? []).some((m) => m === 'host' || m === 'dedicated'),
      )
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ label: p.name, value: p.id }));
  }

  get iniEntryRows(): IniLine[] {
    return this.iniLines
      .filter((line) => line.kind === 'entry')
      .slice()
      .sort((a, b) => {
        const aKey = a.key ?? '';
        const bKey = b.key ?? '';
        const aChanged = this.isIniValueChanged(aKey, a.value);
        const bChanged = this.isIniValueChanged(bKey, b.value);
        if (aChanged !== bChanged) {
          return aChanged ? -1 : 1;
        }
        const locale = this.transloco.getActiveLang() || 'en-US';
        const aLabel = this.formatIniLabel(aKey);
        const bLabel = this.formatIniLabel(bKey);
        return aLabel.localeCompare(bLabel, locale, { sensitivity: 'base' });
      });
  }

  get isIniDirty(): boolean {
    return this.iniLines.some(
      (line) =>
        line.kind === 'entry' &&
        this.isIniValueChanged(line.key, line.value),
    );
  }

  get isSandboxDirty(): boolean {
    return (this.sandboxVarsText ?? '') !== (this.originalSandboxVarsText ?? '');
  }

  get isSpawnpointsDirty(): boolean {
    return (this.spawnpointsText ?? '') !== (this.originalSpawnpointsText ?? '');
  }

  get isSpawnregionsDirty(): boolean {
    return (this.spawnregionsText ?? '') !== (this.originalSpawnregionsText ?? '');
  }

  async refreshServerList(): Promise<void> {
    if (!this.userDir) {
      this.serverNames = [];
      return;
    }
    try {
      this.serverNames = await this.loadoutsApi.listServerNames(this.userDir);
      this.updateServerSelectWidth();
      if (this.serverNames.length === 1) {
        await this.selectServer(this.serverNames[0]);
      }
    } catch {
      this.serverNames = [];
    }
  }

  async selectServer(name: string): Promise<void> {
    if (!name || this.loadingServer) {
      return;
    }
    this.selectedServerName = name;
    await this.loadServerFiles();
    this.scheduleHeightRecalc();
    this.updateServerSelectWidth();
  }

  onTabChange(value?: string | number): void {
    this.activeTab = typeof value === 'string' ? value : 'ini';
    if (!this.cachedTabs.has(this.activeTab)) {
      this.cachedTabs.add(this.activeTab);
      this.localization.notifyCache({ type: 'tab', name: this.activeTab });
    }
    void this.loadServerTabTranslations(
      this.activeTab,
      this.transloco.getActiveLang() || 'en-US',
    );
    this.scheduleHeightRecalc();
    this.scheduleTabFocus();
  }

  private scheduleHeightRecalc(): void {
    requestAnimationFrame(() => {
      this.updateEditorHeights();
      requestAnimationFrame(() => this.updateEditorHeights());
    });
    setTimeout(() => this.updateEditorHeights(), 0);
  }

  private scheduleTabFocus(): void {
    requestAnimationFrame(() => {
      this.focusActiveTabControl();
      setTimeout(() => this.focusActiveTabControl(), 0);
    });
  }

  private focusActiveTabControl(): void {
    if (this.activeTab === 'ini') {
      this.focusListboxFilter(this.iniListboxHost?.nativeElement);
      return;
    }
    if (this.activeTab === 'sandbox') {
      this.focusListboxFilter(this.sandboxListboxHost?.nativeElement);
      return;
    }
    if (this.activeTab === 'spawnpoints') {
      this.spawnpointsTextarea?.nativeElement?.focus();
      return;
    }
    if (this.activeTab === 'spawnregions') {
      this.spawnregionsTextarea?.nativeElement?.focus();
    }
  }

  private focusListboxFilter(listboxHost: HTMLElement | undefined): void {
    if (!listboxHost || !this.isVisible(listboxHost)) {
      return;
    }
    const input = listboxHost.querySelector(
      'input.p-listbox-filter',
    ) as HTMLInputElement | null;
    input?.focus();
  }

  private updateServerSelectWidth(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    if (!this.serverNames.length) {
      return;
    }
    const host = this.serverSelect?.nativeElement;
    const sample = this.serverNames.reduce((longest, current) =>
      current.length > longest.length ? current : longest,
    );
    let font = '14px sans-serif';
    if (host) {
      const label =
        host.querySelector('.p-select-label') ?? host.querySelector('.p-select');
      const styles = label ? window.getComputedStyle(label) : null;
      if (styles) {
        font = `${styles.fontWeight} ${styles.fontSize} ${styles.fontFamily}`;
      }
    }
    const canvas =
      typeof document !== 'undefined'
        ? (document.createElement('canvas') as HTMLCanvasElement)
        : null;
    const ctx = canvas?.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.font = font;
    const textWidth = ctx.measureText(sample).width;
    const padding = 72;
    const width = Math.ceil(textWidth + padding);
    this.serverSelectWidth = Math.max(width, 240);
  }

  openCreateDialog(): void {
    this.closeAllDialogs();
    this.newServerName = '';
    this.createDialogVisible = true;
  }

  openCopyDialog(): void {
    if (!this.selectedServerName) {
      return;
    }
    this.closeAllDialogs();
    this.copyServerName = '';
    this.copySourceName = this.selectedServerName;
    this.copyDialogVisible = true;
  }

  openDeleteDialog(): void {
    if (!this.selectedServerName) {
      return;
    }
    this.closeAllDialogs();
    this.deleteDialogVisible = true;
  }

  async exportServerFiles(): Promise<void> {
    if (!this.selectedServerName) {
      return;
    }
    if (!this.userDir) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.missingUserFolder.summary'),
        detail: this.transloco.translate('toasts.server.missingUserFolder.detail'),
        life: 7000,
      });
      return;
    }

    const targetDir = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: this.userDir,
    });

    if (typeof targetDir !== 'string' || !targetDir.trim()) {
      return;
    }

    const files = this.buildServerFileSet(this.selectedServerName);
    const normalizedDir = targetDir.replace(/[\\/]+$/, '');
    const sources = [
      files.iniPath,
      files.sandboxVarsPath,
      files.spawnpointsPath,
      files.spawnregionsPath,
    ];

    try {
      await Promise.all(
        sources.map(async (source) => {
          const fileName = source.split(/[\\/]/).pop() ?? '';
          if (!fileName) {
            return;
          }
          const target = `${normalizedDir}/${fileName}`;
          await this.loadoutsApi.copyFile(source, target);
        }),
      );
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.saveFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.saveFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    }
  }

  async confirmDeleteServer(): Promise<void> {
    if (!this.selectedServerName || !this.userDir) {
      this.deleteDialogVisible = false;
      return;
    }
    this.deletingServer = true;
    try {
      await this.loadoutsApi.deleteServerFiles(this.userDir, this.selectedServerName);
      this.selectedServerName = '';
      this.iniText = '';
      this.iniLines = [];
      this.iniOriginalValues = new Map<string, string>();
      this.iniEntryOptions = [];
      this.sandboxVarsText = '';
      this.spawnpointsText = '';
      this.spawnregionsText = '';
      this.originalSandboxVarsText = '';
      this.sandboxOriginalValues = new Map<string, string>();
      this.originalSpawnpointsText = '';
      this.originalSpawnregionsText = '';
      await this.refreshServerList();
      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.server.saved.summary'),
        detail: this.transloco.translate('toasts.server.saved.detail'),
        life: 3000,
      });
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.saveFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.saveFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    } finally {
      this.deletingServer = false;
      this.deleteDialogVisible = false;
    }
  }

  async confirmCreateServer(): Promise<void> {
    const trimmed = this.newServerName.trim();
    const error = this.validateServerName(trimmed);
    if (error) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.invalidName.summary'),
        detail: error,
        life: 7000,
      });
      return;
    }

    const exists = this.serverNames.some(
      (n) => n.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.nameExists.summary'),
        detail: this.transloco.translate('toasts.server.nameExists.detail'),
        life: 7000,
      });
      return;
    }

    if (!this.userDir) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.missingUserFolder.summary'),
        detail: this.transloco.translate('toasts.server.missingUserFolder.detail'),
        life: 7000,
      });
      return;
    }

    const files = this.buildServerFileSet(trimmed);
    try {
      const defaults = await this.loadDefaultServerFiles();
      await this.loadoutsApi.writeTextFile(files.iniPath, defaults.ini);
      await this.loadoutsApi.writeTextFile(files.sandboxVarsPath, defaults.sandboxVars);
      await this.loadoutsApi.writeTextFile(files.spawnpointsPath, defaults.spawnpoints);
      await this.loadoutsApi.writeTextFile(files.spawnregionsPath, defaults.spawnregions);
      this.createDialogVisible = false;
      await this.refreshServerList();
      await this.selectServer(trimmed);
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.createFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.createFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    }
  }

  async confirmCopyServer(): Promise<void> {
    const trimmed = this.copyServerName.trim();
    const error = this.validateServerName(trimmed);
    if (error) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.invalidName.summary'),
        detail: error,
        life: 7000,
      });
      return;
    }

    const exists = this.serverNames.some(
      (n) => n.toLowerCase() === trimmed.toLowerCase(),
    );
    if (exists) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.nameExists.summary'),
        detail: this.transloco.translate('toasts.server.nameExists.detail'),
        life: 7000,
      });
      return;
    }

    if (!this.userDir) {
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.missingUserFolder.summary'),
        detail: this.transloco.translate('toasts.server.missingUserFolder.detail'),
        life: 7000,
      });
      return;
    }

    const sourceName = (this.copySourceName || this.selectedServerName).trim();
    if (!sourceName) {
      this.copyDialogVisible = false;
      return;
    }

    const sourceFiles = this.buildServerFileSet(sourceName);
    const targetFiles = this.buildServerFileSet(trimmed);
    const copyPairs = [
      { source: sourceFiles.iniPath, target: targetFiles.iniPath },
      { source: sourceFiles.sandboxVarsPath, target: targetFiles.sandboxVarsPath },
      { source: sourceFiles.spawnpointsPath, target: targetFiles.spawnpointsPath },
      { source: sourceFiles.spawnregionsPath, target: targetFiles.spawnregionsPath },
    ];

    try {
      await Promise.all(
        copyPairs.map(({ source, target }) => this.loadoutsApi.copyFile(source, target)),
      );
      this.copyDialogVisible = false;
      await this.refreshServerList();
      await this.selectServer(trimmed);
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.createFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.createFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    }
  }

  async loadServerFiles(): Promise<void> {
    if (!this.selectedServerName || !this.userDir) {
      return;
    }
    const files = this.buildServerFileSet(this.selectedServerName);
    this.loadingServer = true;
    try {
      this.iniText = await this.safeReadFile(files.iniPath);
      this.iniLines = this.parseIniText(this.iniText);
      this.iniOriginalValues = this.buildIniOriginalValues(this.iniLines);
      this.refreshIniEntryOptions();
      this.sandboxVarsText = await this.safeReadFile(files.sandboxVarsPath);
      const parsedSandbox = this.parseSandboxText(this.sandboxVarsText);
      const normalizedSandbox = this.normalizeSandboxDecimalValues(parsedSandbox);
      this.sandboxLines = normalizedSandbox.lines;
      this.sandboxEntries = normalizedSandbox.entries;
      this.sandboxVarsText = normalizedSandbox.text;
      this.sandboxOriginalValues = this.buildSandboxOriginalValues(
        this.sandboxEntries,
      );
      this.refreshSandboxEntryOptions();
      this.spawnpointsText = await this.safeReadFile(files.spawnpointsPath);
      this.spawnregionsText = await this.safeReadFile(files.spawnregionsPath);
      this.originalSandboxVarsText = this.sandboxVarsText;
      this.originalSpawnpointsText = this.spawnpointsText;
      this.originalSpawnregionsText = this.spawnregionsText;
    } finally {
      this.loadingServer = false;
    }
  }

  async saveServerFiles(): Promise<void> {
    if (!this.selectedServerName || !this.userDir) {
      return;
    }
    const files = this.buildServerFileSet(this.selectedServerName);
    this.savingServer = true;
    try {
      const iniPayload = this.serializeIni(this.iniLines);
      await this.loadoutsApi.writeTextFile(files.iniPath, iniPayload);
      await this.loadoutsApi.writeTextFile(
        files.sandboxVarsPath,
        this.sandboxVarsText ?? '',
      );
      await this.loadoutsApi.writeTextFile(
        files.spawnpointsPath,
        this.spawnpointsText ?? '',
      );
      await this.loadoutsApi.writeTextFile(
        files.spawnregionsPath,
        this.spawnregionsText ?? '',
      );
      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.server.saved.summary'),
        detail: this.transloco.translate('toasts.server.saved.detail'),
        life: 3000,
      });
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.saveFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.saveFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    } finally {
      this.savingServer = false;
    }
  }

  async saveIniChanges(): Promise<void> {
    if (!this.selectedServerName || !this.userDir || !this.isIniDirty) {
      return;
    }
    const files = this.buildServerFileSet(this.selectedServerName);
    this.savingIni = true;
    try {
      await this.createServerBackups(this.selectedServerName, files);
      const iniPayload = this.serializeIni(this.iniLines);
      await this.loadoutsApi.writeTextFile(files.iniPath, iniPayload);
      this.iniText = iniPayload;
      this.iniOriginalValues = this.buildIniOriginalValues(this.iniLines);
      this.refreshIniEntryOptions();
      await this.refreshServerList();
      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.server.saved.summary'),
        detail: this.transloco.translate('toasts.server.saved.detail'),
        life: 3000,
      });
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.saveFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.saveFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    } finally {
      this.savingIni = false;
    }
  }

  private async createServerBackups(
    serverName: string,
    files: ServerFileSet,
  ): Promise<void> {
    const timestamp = this.buildBackupTimestamp();
    const base = `${this.userDir}\\Server\\${serverName}`;
    const backups = [
      { source: files.iniPath, target: `${base}_${timestamp}.ini` },
      {
        source: files.sandboxVarsPath,
        target: `${base}_SandboxVars_${timestamp}.lua`,
      },
      {
        source: files.spawnregionsPath,
        target: `${base}_spawnregions_${timestamp}.lua`,
      },
      {
        source: files.spawnpointsPath,
        target: `${base}_spawnpoints_${timestamp}.lua`,
      },
    ];

    for (const entry of backups) {
      try {
        await this.loadoutsApi.copyFile(entry.source, entry.target);
      } catch {
        // Skip missing or unreadable files to avoid creating empty backups.
      }
    }
  }

  private buildBackupTimestamp(): string {
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    const yyyy = now.getFullYear();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const hh = pad(now.getHours());
    const min = pad(now.getMinutes());
    const ss = pad(now.getSeconds());
    return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
  }

  resetIniChanges(): void {
    if (!this.isIniDirty) {
      return;
    }
    for (const line of this.iniLines) {
      if (line.kind !== 'entry' || !line.key) {
        continue;
      }
      line.value = this.iniOriginalValues.get(line.key) ?? '';
    }
    this.iniText = this.serializeIni(this.iniLines);
    this.refreshIniEntryOptions();
  }

  async saveSandboxChanges(): Promise<void> {
    if (!this.selectedServerName || !this.userDir || !this.isSandboxDirty) {
      return;
    }
    const files = this.buildServerFileSet(this.selectedServerName);
    this.savingSandbox = true;
    try {
      await this.loadoutsApi.writeTextFile(
        files.sandboxVarsPath,
        this.sandboxVarsText ?? '',
      );
      this.originalSandboxVarsText = this.sandboxVarsText ?? '';
      this.sandboxOriginalValues = this.buildSandboxOriginalValues(
        this.sandboxEntries,
      );
      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.server.saved.summary'),
        detail: this.transloco.translate('toasts.server.saved.detail'),
        life: 3000,
      });
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.saveFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.saveFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    } finally {
      this.savingSandbox = false;
    }
  }

  resetSandboxChanges(): void {
    if (!this.isSandboxDirty) {
      return;
    }
    this.sandboxVarsText = this.originalSandboxVarsText ?? '';
    const parsed = this.parseSandboxText(this.sandboxVarsText);
    this.sandboxLines = parsed.lines;
    this.sandboxEntries = parsed.entries;
    this.sandboxOriginalValues = this.buildSandboxOriginalValues(
      this.sandboxEntries,
    );
    this.refreshSandboxEntryOptions();
  }

  async saveSpawnpointsChanges(): Promise<void> {
    if (!this.selectedServerName || !this.userDir || !this.isSpawnpointsDirty) {
      return;
    }
    const files = this.buildServerFileSet(this.selectedServerName);
    this.savingSpawnpoints = true;
    try {
      await this.loadoutsApi.writeTextFile(
        files.spawnpointsPath,
        this.spawnpointsText ?? '',
      );
      this.originalSpawnpointsText = this.spawnpointsText ?? '';
      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.server.saved.summary'),
        detail: this.transloco.translate('toasts.server.saved.detail'),
        life: 3000,
      });
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.saveFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.saveFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    } finally {
      this.savingSpawnpoints = false;
    }
  }

  resetSpawnpointsChanges(): void {
    if (!this.isSpawnpointsDirty) {
      return;
    }
    this.spawnpointsText = this.originalSpawnpointsText ?? '';
  }

  async saveSpawnregionsChanges(): Promise<void> {
    if (!this.selectedServerName || !this.userDir || !this.isSpawnregionsDirty) {
      return;
    }
    const files = this.buildServerFileSet(this.selectedServerName);
    this.savingSpawnregions = true;
    try {
      await this.loadoutsApi.writeTextFile(
        files.spawnregionsPath,
        this.spawnregionsText ?? '',
      );
      this.originalSpawnregionsText = this.spawnregionsText ?? '';
      this.messageService.add({
        severity: 'success',
        summary: this.transloco.translate('toasts.server.saved.summary'),
        detail: this.transloco.translate('toasts.server.saved.detail'),
        life: 3000,
      });
    } catch (err: unknown) {
      const detail =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : this.transloco.translate('toasts.server.saveFailed.detail');
      this.messageService.add({
        severity: 'error',
        summary: this.transloco.translate('toasts.server.saveFailed.summary'),
        detail,
        life: 8000,
        closable: true,
      });
    } finally {
      this.savingSpawnregions = false;
    }
  }

  resetSpawnregionsChanges(): void {
    if (!this.isSpawnregionsDirty) {
      return;
    }
    this.spawnregionsText = this.originalSpawnregionsText ?? '';
  }

  applyPresetToIni(): void {
    if (!this.selectedPresetId) {
      return;
    }
    const preset = this.presets.find((p) => p.id === this.selectedPresetId);
    if (!preset) {
      return;
    }
    const values = this.buildServerConfigValues(preset);
    this.upsertIniEntry(this.iniLines, 'Mods', values.mods);
    this.upsertIniEntry(this.iniLines, 'WorkshopItems', values.workshopItems);
    this.upsertIniEntry(this.iniLines, 'Map', values.map);
    this.iniText = this.serializeIni(this.iniLines);
    this.refreshIniEntryOptions();
  }

  onIniEntrySelect(value: unknown): void {
    const key =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object' && 'key' in value
          ? String((value as { key: string }).key)
          : '';
    this.selectedIniKey = key;
    if (!key) {
      return;
    }
    this.openIniEditDialog(key);
  }

  onIniEntryClick(event: unknown): void {
    const key =
      event && typeof event === 'object'
        ? 'value' in event
          ? String((event as { value: string }).value ?? '')
          : 'option' in event
            ? String((event as { option: { key?: string; value?: string } }).option?.key ??
                (event as { option: { key?: string; value?: string } }).option?.value ??
                '')
            : ''
        : '';
    const resolved = key || this.selectedIniKey;
    if (resolved) {
      this.openIniEditDialog(resolved);
    }
  }

  onSandboxEntrySelect(value: unknown): void {
    const id =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object' && 'id' in value
          ? String((value as { id: string }).id)
          : '';
    this.selectedSandboxKey = id;
    if (!id) {
      return;
    }
    this.openSandboxEditDialog(id);
  }

  onSandboxEntryClick(event: unknown): void {
    const id =
      event && typeof event === 'object'
        ? 'value' in event
          ? String((event as { value: string }).value ?? '')
          : 'option' in event
            ? String((event as { option: { id?: string; value?: string } }).option?.id ??
                (event as { option: { id?: string; value?: string } }).option?.value ??
                '')
            : ''
        : '';
    const resolved = id || this.selectedSandboxKey;
    if (resolved) {
      this.openSandboxEditDialog(resolved);
    }
  }

  private updateEditorHeights(): void {
    if (typeof window === 'undefined') {
      return;
    }
    this.updateIniListboxHeights();
    this.updateSandboxListboxHeights();
    this.spawnpointsTextareaHeight = `${this.getAvailableHeightPx(
      this.spawnpointsTextarea?.nativeElement,
      this.getActionsOffset(this.spawnpointsActions?.nativeElement),
    )}px`;
    this.spawnregionsTextareaHeight = `${this.getAvailableHeightPx(
      this.spawnregionsTextarea?.nativeElement,
      this.getActionsOffset(this.spawnregionsActions?.nativeElement),
    )}px`;
  }

  private updateIniListboxHeights(): void {
    const listboxHost = this.iniListboxHost?.nativeElement;
    if (!listboxHost || !this.isVisible(listboxHost)) {
      return;
    }
    const listboxHeaderHeight =
      listboxHost
        .querySelector('.p-listbox-header')
        ?.getBoundingClientRect().height ?? 0;
    const headerGap = this.getHeaderGap(listboxHost);
    const listboxHeight = this.getAvailableHeightPx(
      listboxHost,
      this.getActionsOffset(this.iniActions?.nativeElement),
    );
    const scrollHeight = Math.max(
      listboxHeight - Math.round(listboxHeaderHeight + headerGap),
      0,
    );
    this.iniListboxHeight = `${listboxHeight}px`;
    this.iniListboxScrollHeight = `${scrollHeight}px`;
  }

  private updateSandboxListboxHeights(): void {
    const listboxHost = this.sandboxListboxHost?.nativeElement;
    if (!listboxHost || !this.isVisible(listboxHost)) {
      return;
    }
    const listboxHeaderHeight =
      listboxHost
        .querySelector('.p-listbox-header')
        ?.getBoundingClientRect().height ?? 0;
    const headerGap = this.getHeaderGap(listboxHost);
    const listboxHeight = this.getAvailableHeightPx(
      listboxHost,
      this.getActionsOffset(this.sandboxActions?.nativeElement),
    );
    const scrollHeight = Math.max(
      listboxHeight - Math.round(listboxHeaderHeight + headerGap),
      0,
    );
    this.sandboxListboxHeight = `${listboxHeight}px`;
    this.sandboxListboxScrollHeight = `${scrollHeight}px`;
  }

  private getAvailableHeightPx(
    element: HTMLElement | undefined,
    extraOffset = 0,
  ): number {
    if (!element) {
      return 0;
    }
    if (!this.isVisible(element)) {
      return 0;
    }
    const container = this.getScrollContainer(element);
    const containerHeight = container?.clientHeight ?? 0;
    const padding = this.getBasePadding(containerHeight);
    const topOffset = this.getOffsetTopWithinContainer(element, container);
    const topInView = topOffset - (container?.scrollTop ?? 0);
    const heightOffset = Math.max(
      Math.round(topInView + padding + extraOffset),
      0,
    );
    return Math.max(containerHeight - heightOffset, 0);
  }

  private getBasePadding(containerHeight: number): number {
    const baseOffset = 75;
    return baseOffset + Math.min(32, Math.round(containerHeight * 0.02));
  }

  private getHeaderGap(element: HTMLElement): number {
    const container = this.getScrollContainer(element);
    const containerHeight = container?.clientHeight ?? 0;
    return Math.max(
      6,
      Math.min(12, Math.round(containerHeight * 0.01)),
    );
  }

  private getActionsOffset(element: HTMLElement | undefined): number {
    if (!element) {
      return 0;
    }
    const rect = element.getBoundingClientRect();
    return Math.max(Math.round(rect.height + 16), 0);
  }

  private isVisible(element: HTMLElement): boolean {
    return element.offsetParent !== null;
  }

  private getScrollContainer(element: HTMLElement): HTMLElement {
    let current: HTMLElement | null = element.parentElement;
    while (current && current !== document.body) {
      const styles = window.getComputedStyle(current);
      const overflowY = styles.overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') {
        return current;
      }
      current = current.parentElement;
    }
    return document.documentElement;
  }

  private getOffsetTopWithinContainer(
    element: HTMLElement,
    container: HTMLElement,
  ): number {
    let offset = 0;
    let current: HTMLElement | null = element;
    while (current && current !== container) {
      offset += current.offsetTop;
      current = current.offsetParent as HTMLElement | null;
    }
    return offset;
  }

  private buildServerFileSet(name: string): ServerFileSet {
    const base = `${this.userDir}\\Server\\${name}`;
    return {
      iniPath: `${base}.ini`,
      sandboxVarsPath: `${base}_SandboxVars.lua`,
      spawnpointsPath: `${base}_spawnpoints.lua`,
      spawnregionsPath: `${base}_spawnregions.lua`,
    };
  }

  get copyServerFileNames(): string[] {
    const source = (this.copySourceName || this.selectedServerName).trim();
    if (!source) {
      return [];
    }
    const files = this.buildServerFileSet(source);
    return [
      files.iniPath,
      files.sandboxVarsPath,
      files.spawnpointsPath,
      files.spawnregionsPath,
    ]
      .map((path) => path.split(/[\\/]/).pop() ?? '')
      .filter(Boolean);
  }

  private async safeReadFile(path: string): Promise<string> {
    try {
      return await this.loadoutsApi.readTextFile(path);
    } catch {
      return '';
    }
  }

  private validateServerName(name: string): string | null {
    if (!name) {
      return this.transloco.translate('toasts.server.invalidName.detailMissing');
    }
    if (/\s/.test(name)) {
      return this.transloco.translate('toasts.server.invalidName.detailNoSpaces');
    }
    if (/[^\x20-\x7E]/.test(name)) {
      return this.transloco.translate('toasts.server.invalidName.detailAscii');
    }
    if (/[<>:"/\\|?*]/.test(name)) {
      return this.transloco.translate('toasts.server.invalidName.detailInvalidChars');
    }
    if (name.endsWith('.') || name.endsWith(' ')) {
      return this.transloco.translate('toasts.server.invalidName.detailTrailing');
    }
    return null;
  }

  private upsertIniKey(text: string, key: string, value: string): string {
    const lines = (text ?? '').split(/\r?\n/);
    const pattern = new RegExp(`^\\s*${key}\\s*=`, 'i');
    let found = false;
    const next = lines.map((line) => {
      if (pattern.test(line)) {
        found = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!found) {
      if (next.length && next[next.length - 1].trim() !== '') {
        next.push('');
      }
      next.push(`${key}=${value}`);
    }
    return next.join('\n');
  }

  private buildServerConfigValues(loadout: Loadout): {
    mods: string;
    workshopItems: string;
    map: string;
  } {
    const disabled = new Set(this.expandModIds(loadout.disabledModIds ?? []));
    const modIds = this.expandModIds(loadout.modIds ?? []).filter(
      (id) => !disabled.has(id),
    );
    const modsValue = modIds.map((id) => `\\${id}`).join(';');
    const workshopIds: string[] = [];
    const seen = new Set<string>();
    const pushId = (id: string): void => {
      const cleaned = (id ?? '').trim();
      if (!cleaned || seen.has(cleaned)) {
        return;
      }
      seen.add(cleaned);
      workshopIds.push(cleaned);
    };
    for (const modId of modIds) {
      pushId(loadout.workshopByModId?.[modId] || '');
    }
    for (const id of loadout.workshopIds ?? []) {
      pushId(id);
    }
    const workshopValue = workshopIds.join(';');
    const mapValue = (loadout.mapEntries ?? [])
      .filter((entry) => entry?.mapFolder && modIds.includes(entry.modId))
      .map((entry) => entry.mapFolder)
      .join(';');
    return { mods: modsValue, workshopItems: workshopValue, map: mapValue };
  }

  private expandModIds(input: string[] | null | undefined): string[] {
    const out: string[] = [];
    for (const raw of input ?? []) {
      const parts = String(raw ?? '')
        .split(';')
        .map((id) => id.trim())
        .filter((id) => !!id);
      out.push(...parts);
    }
    return out;
  }

  isLongValue(value: string | undefined): boolean {
    return (value ?? '').length > 120;
  }

  isBooleanValue(value: string | undefined): boolean {
    const normalized = (value ?? '').trim().toLowerCase();
    return normalized === 'true' || normalized === 'false';
  }

  isNumericValue(value: string | undefined): boolean {
    const trimmed = (value ?? '').trim();
    if (!trimmed) {
      return false;
    }
    return /^[-+]?(?:\d+|\d*\.\d+)$/.test(trimmed);
  }

  formatIniLabel(key: string | undefined): string {
    const raw = (key ?? '').trim();
    if (!raw) {
      return '';
    }
    const translationKey = this.getIniLabelKey(raw);
    const translated = this.transloco.translate(translationKey);
    const label =
      translated && translated !== translationKey
        ? translated
        : this.formatIniLabelFallback(raw);
    return `${label} (${raw})`;
  }

  isIniValueChanged(key: string | undefined, value: string | undefined): boolean {
    const normalizedKey = (key ?? '').trim();
    if (!normalizedKey) {
      return false;
    }
    const original = this.iniOriginalValues.get(normalizedKey);
    return (original ?? '') !== (value ?? '');
  }

  fieldWrapperId(key: string | undefined): string {
    const safe = (key ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
    return `ini-field-${safe}`;
  }

  fieldInputId(key: string | undefined): string {
    const safe = (key ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
    return `ini-input-${safe}`;
  }

  getIniValueByKey(key: string | undefined): string {
    const normalizedKey = (key ?? '').trim();
    if (!normalizedKey) {
      return '';
    }
    const line = this.iniLines.find((l) => l.kind === 'entry' && l.key === normalizedKey);
    return line?.value ?? '';
  }

  async openIniEditDialog(key: string): Promise<void> {
    const normalizedKey = (key ?? '').trim();
    if (normalizedKey.toLowerCase() === 'mods') {
      this.openModsDialog();
      return;
    }
    if (normalizedKey.toLowerCase() === 'workshopitems') {
      this.openModsDialog();
      return;
    }
    this.closeAllDialogs();
    const line = this.iniLines.find(
      (l) => l.kind === 'entry' && l.key === normalizedKey,
    );
    if (!line) {
      return;
    }
    this.editIniLine = line;
    this.editIniUsesDecimals = this.shouldUseIniDecimalFormat(line.comment);
    this.editIniValue = this.editIniUsesDecimals
      ? this.formatIniDecimalValue(line.value)
      : (line.value ?? '');
    this.editIniNumber = this.isNumericValue(this.editIniValue)
      ? this.parseNumericValue(this.editIniValue)
      : null;
    this.editIniCommentLines = this.getIniCommentLines(
      this.editIniLine.key,
      this.editIniLine.comment,
    );
    this.editIniVisible = true;
  }

  cancelIniEdit(): void {
    this.editIniVisible = false;
    this.editIniLine = null;
    this.editIniValue = '';
    this.editIniNumber = null;
    this.editIniCommentLines = [];
    this.editIniUsesDecimals = false;
  }

  saveIniEdit(): void {
    if (!this.editIniLine) {
      this.cancelIniEdit();
      return;
    }
    this.editIniLine.value = this.editIniValue ?? '';
    this.editIniVisible = false;
    this.editIniLine = null;
    this.editIniValue = '';
    this.editIniNumber = null;
    this.editIniUsesDecimals = false;
    this.refreshIniEntryOptions();
  }

  openSandboxEditDialog(entryId: string): void {
    const normalizedId = (entryId ?? '').trim();
    this.closeAllDialogs();
    const entry = this.sandboxEntries.find((item) => item.id === normalizedId);
    if (!entry) {
      return;
    }
    const translatedComments = this.getSandboxCommentLines(
      entry.key,
      entry.commentLines,
    );
    this.editSandboxEntry = { ...entry, commentLines: translatedComments };
    this.editSandboxUsesDecimals = this.shouldUseSandboxDecimalFormat(
      entry.commentLines,
    );
    this.editSandboxValue = this.editSandboxUsesDecimals
      ? this.formatSandboxDecimalValue(entry.value)
      : (entry.value ?? '');
    this.editSandboxNumber = this.isNumericValue(this.editSandboxValue)
      ? this.parseNumericValue(this.editSandboxValue)
      : null;
    this.editSandboxVisible = true;
  }

  cancelSandboxEdit(): void {
    this.editSandboxVisible = false;
    this.editSandboxEntry = null;
    this.editSandboxValue = '';
    this.editSandboxNumber = null;
    this.editSandboxUsesDecimals = false;
  }

  saveSandboxEdit(): void {
    if (!this.editSandboxEntry) {
      this.cancelSandboxEdit();
      return;
    }
    const updatedValue = this.editSandboxUsesDecimals
      ? this.formatSandboxDecimalValue(this.editSandboxValue)
      : (this.editSandboxValue ?? '');
    const index = this.sandboxEntries.findIndex(
      (item) => item.id === this.editSandboxEntry?.id,
    );
    if (index >= 0) {
      const entry = this.sandboxEntries[index];
      entry.value = updatedValue;
      const line = `${entry.indent}${entry.key} = ${updatedValue},`;
      this.sandboxLines[entry.lineIndex] = line;
      this.sandboxVarsText = this.sandboxLines.join('\n');
      this.refreshSandboxEntryOptions();
    }
    this.editSandboxVisible = false;
    this.editSandboxEntry = null;
    this.editSandboxValue = '';
    this.editSandboxNumber = null;
    this.editSandboxUsesDecimals = false;
  }

  onSandboxNumberChange(value: number | null): void {
    this.editSandboxNumber = value;
    if (value === null || Number.isNaN(value)) {
      this.editSandboxValue = '';
      return;
    }
    this.editSandboxValue = this.editSandboxUsesDecimals
      ? value.toFixed(2)
      : this.formatNumericValue(value);
  }

  openModsDialog(): void {
    this.closeAllDialogs();
    const modsLine = this.iniLines.find(
      (line) => line.kind === 'entry' && (line.key ?? '').trim() === 'Mods',
    );
    const workshopLine = this.iniLines.find(
      (line) => line.kind === 'entry' && (line.key ?? '').trim() === 'WorkshopItems',
    );
    this.modsDialogModsValue = modsLine
      ? (modsLine.value ?? '')
      : (this.iniOriginalValues.get('Mods') ?? '');
    this.modsDialogWorkshopValue = workshopLine
      ? (workshopLine.value ?? '')
      : (this.iniOriginalValues.get('WorkshopItems') ?? '');
    this.modsDialogVisible = true;
  }

  onModsDialogSave(payload: { modsValue: string; workshopValue: string }): void {
    this.upsertIniEntry(this.iniLines, 'Mods', payload.modsValue ?? '');
    this.upsertIniEntry(this.iniLines, 'WorkshopItems', payload.workshopValue ?? '');
    this.modsDialogVisible = false;
    this.refreshIniEntryOptions();
  }

  onIniNumberChange(value: number | null): void {
    this.editIniNumber = value;
    if (value === null || Number.isNaN(value)) {
      this.editIniValue = '';
      return;
    }
    this.editIniValue = this.editIniUsesDecimals
      ? value.toFixed(2)
      : this.formatNumericValue(value);
  }

  private formatNumericValue(value: number): string {
    if (Number.isInteger(value)) {
      return String(value);
    }
    const fixed = value.toFixed(2);
    return fixed.replace(/\.?0+$/, '');
  }

  private parseNumericValue(value: string | undefined): number | null {
    const parsed = Number.parseFloat((value ?? '').trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  private closeAllDialogs(): void {
    if (this.editIniVisible) {
      this.cancelIniEdit();
    }
    if (this.editSandboxVisible) {
      this.cancelSandboxEdit();
    }
    this.createDialogVisible = false;
    this.copyDialogVisible = false;
    this.copyServerName = '';
    this.copySourceName = '';
    this.deleteDialogVisible = false;
    this.modsDialogVisible = false;
  }

  isWelcomeMessageKey(key: string | undefined): boolean {
    return (key ?? '').trim() === 'ServerWelcomeMessage';
  }

  isBadWordListFileKey(key: string | undefined): boolean {
    return (key ?? '').trim() === 'BadWordListFile';
  }

  isWorldItemRemovalListKey(key: string | undefined): boolean {
    return (key ?? '').trim() === 'WorldItemRemovalList';
  }

  isClientCommandFilterKey(key: string | undefined): boolean {
    return (key ?? '').trim() === 'ClientCommandFilter';
  }

  isClientActionLogsKey(key: string | undefined): boolean {
    return (key ?? '').trim() === 'ClientActionLogs';
  }

  private parseSandboxText(text: string): {
    lines: string[];
    entries: Array<{
      id: string;
      key: string;
      value: string;
      commentLines: string[];
      lineIndex: number;
      indent: string;
    }>;
  } {
    const lines = (text ?? '').split(/\r?\n/);
    const entries: Array<{
      id: string;
      key: string;
      value: string;
      commentLines: string[];
      lineIndex: number;
      indent: string;
    }> = [];
    let pendingComments: string[] = [];
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) {
        pendingComments = [];
        return;
      }
      if (trimmed.startsWith('--')) {
        const comment = trimmed.replace(/^--\s?/, '').trim();
        if (comment) {
          pendingComments.push(comment);
        }
        return;
      }
      const match = line.match(/^(\s*)([A-Za-z0-9_]+)\s*=\s*(.+)$/);
      if (!match) {
        pendingComments = [];
        return;
      }
      const indent = match[1] ?? '';
      const key = (match[2] ?? '').trim();
      if (key === 'SandboxVars') {
        pendingComments = [];
        return;
      }
      let value = (match[3] ?? '').trim();
      if (value.endsWith(',')) {
        value = value.slice(0, -1).trim();
      }
      entries.push({
        id: `${key}:${index}`,
        key,
        value,
        commentLines: pendingComments,
        lineIndex: index,
        indent,
      });
      pendingComments = [];
    });
    return { lines, entries };
  }

  private refreshSandboxEntryOptions(): void {
    const excluded = new Set([
      'Basement',
      'Map',
      'ZombieLore',
      'ZombieConfig',
      'MultiplierConfig',
    ]);
    const locale = this.transloco.getActiveLang() || 'en-US';
    this.sandboxEntryOptions = this.sandboxEntries
      .filter((entry) => !excluded.has(entry.key))
      .slice()
      .sort((a, b) => {
        const aChanged = this.isSandboxValueChanged(a.id, a.value);
        const bChanged = this.isSandboxValueChanged(b.id, b.value);
        if (aChanged !== bChanged) {
          return aChanged ? -1 : 1;
        }
        const aLabel = this.formatSandboxLabel(a.key);
        const bLabel = this.formatSandboxLabel(b.key);
        return aLabel.localeCompare(bLabel, locale, { sensitivity: 'base' });
      })
      .map((entry) => {
        const displayValue = this.shouldUseSandboxDecimalFormat(entry.commentLines)
          ? this.formatSandboxDecimalValue(entry.value)
          : (entry.value ?? '');
        return {
          id: entry.id,
          key: entry.key,
          value: entry.value ?? '',
          lineIndex: entry.lineIndex,
          label: `${this.formatSandboxLabel(entry.key)} = ${displayValue}`,
        };
      });
  }

  formatSandboxLabel(key: string): string {
    const raw = (key ?? '').trim();
    if (!raw) {
      return '';
    }
    const translationKey = this.getSandboxLabelKey(raw);
    const translated = this.transloco.translate(translationKey);
    const label =
      translated && translated !== translationKey
        ? translated
        : this.formatSandboxLabelFallback(raw);
    return `${label} (${raw})`;
  }

  private getSandboxLabelKey(raw: string): string {
    return `server.sandbox.${raw}`;
  }

  private formatSandboxLabelFallback(raw: string): string {
    const spaced = raw
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  private shouldUseSandboxDecimalFormat(commentLines: string[]): boolean {
    return (commentLines ?? []).some((line) => /\d+\.\d+/.test(line));
  }

  private formatSandboxDecimalValue(value: string | undefined): string {
    const parsed = Number.parseFloat((value ?? '').trim());
    if (!Number.isFinite(parsed)) {
      return (value ?? '').trim();
    }
    return parsed.toFixed(2);
  }

  private normalizeSandboxDecimalValues(parsed: {
    lines: string[];
    entries: Array<{
      id: string;
      key: string;
      value: string;
      commentLines: string[];
      lineIndex: number;
      indent: string;
    }>;
  }): { lines: string[]; entries: typeof parsed.entries; text: string } {
    let updated = false;
    const lines = parsed.lines.slice();
    const entries = parsed.entries.map((entry) => {
      if (!this.shouldUseSandboxDecimalFormat(entry.commentLines)) {
        return entry;
      }
      const formatted = this.formatSandboxDecimalValue(entry.value);
      if (formatted !== entry.value) {
        updated = true;
        const line = `${entry.indent}${entry.key} = ${formatted},`;
        lines[entry.lineIndex] = line;
        return { ...entry, value: formatted };
      }
      return entry;
    });
    const text = updated ? lines.join('\n') : parsed.lines.join('\n');
    return { lines: updated ? lines : parsed.lines, entries, text };
  }

  private buildSandboxOriginalValues(
    entries: Array<{ id: string; value: string }>,
  ): Map<string, string> {
    const map = new Map<string, string>();
    for (const entry of entries ?? []) {
      const id = (entry.id ?? '').trim();
      if (!id) {
        continue;
      }
      map.set(id, entry.value ?? '');
    }
    return map;
  }

  isSandboxValueChanged(
    id: string | undefined,
    value: string | undefined,
  ): boolean {
    const normalizedId = (id ?? '').trim();
    if (!normalizedId) {
      return false;
    }
    const original = this.sandboxOriginalValues.get(normalizedId);
    return (original ?? '') !== (value ?? '');
  }

  private getSandboxCommentLines(key: string, fallback: string[]): string[] {
    const normalized = (key ?? '').trim();
    if (!normalized) {
      return fallback ?? [];
    }
    const translated = this.transloco.translateObject(
      `server.sandbox.comments.${normalized}`,
    ) as unknown;
    const translationKey = `server.sandbox.comments.${normalized}`;
    if (Array.isArray(translated)) {
      return translated.filter((line) => typeof line === 'string' && line.trim());
    }
    if (typeof translated === 'string') {
      const trimmed = translated.trim();
      if (!trimmed || trimmed === translationKey) {
        return fallback ?? [];
      }
      return [trimmed];
    }
    return fallback ?? [];
  }

  private parseIniText(text: string): IniLine[] {
    const lines = (text ?? '').split(/\r?\n/);
    let pendingComment = '';
    return lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        pendingComment = '';
        return { kind: 'blank', raw: line };
      }
      if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
        const comment = trimmed.replace(/^(#|\/\/)\s?/, '');
        pendingComment = pendingComment
          ? `${pendingComment}\n${comment}`
          : comment;
        return { kind: 'comment', raw: line };
      }
      const idx = line.indexOf('=');
      if (idx >= 0) {
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1);
        const entry: IniLine = {
          kind: 'entry',
          key,
          value,
          comment: pendingComment,
        };
        pendingComment = '';
        return entry;
      }
      pendingComment = '';
      return { kind: 'comment', raw: line };
    });
  }

  private serializeIni(lines: IniLine[]): string {
    return lines
      .map((line) => {
        if (line.kind === 'entry') {
          return `${line.key ?? ''}=${line.value ?? ''}`;
        }
        return line.raw ?? '';
      })
      .join('\n');
  }

  private upsertIniEntry(lines: IniLine[], key: string, value: string): void {
    const target = key.trim();
    const entry = lines.find(
      (line) =>
        line.kind === 'entry' && (line.key ?? '').trim().toLowerCase() === target.toLowerCase(),
    );
    if (entry) {
      entry.key = target;
      entry.value = value;
      return;
    }
    lines.push({ kind: 'entry', key: target, value });
  }

  private buildIniOriginalValues(lines: IniLine[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const line of lines) {
      if (line.kind !== 'entry' || !line.key) {
        continue;
      }
      map.set(line.key, line.value ?? '');
    }
    return map;
  }

  private getIniLabelKey(raw: string): string {
    return `server.ini.${raw}`;
  }

  private formatIniLabelFallback(raw: string): string {
    const normalizedKey = raw.replace(/_/g, '').toLowerCase();
    const labelOverrides: Record<string, string> = {
      udpport: 'UDP Port',
      pvpfirearmdamagemodifier: 'PVP Firearm Damage Modifier',
      pvplogtoolchat: 'PVP Log Tool Chat',
      pvplogtoolfile: 'PVP Log Tool File',
      pvpmeleedamagemodifier: 'PVP Melee Damage Modifier',
      pvpmeleewhilehitreaction: 'PVP Melee While Hit Reaction',
      rconpassword: 'RCON Password',
      rconport: 'RCON Port',
      ultraspeeddoesnotaffecttoanimals: 'Ultra Speed Does not Affect To Animals',
      upnp: 'UPnP',
      voice3d: 'Voice 3D',
    };
    const override = labelOverrides[normalizedKey];
    if (override) {
      return override;
    }
    const spaced = raw
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  }

  private shouldUseIniDecimalFormat(comment: string | undefined): boolean {
    return this.splitCommentLines(comment ?? '').some((line) => /\d+\.\d+/.test(line));
  }

  private formatIniDecimalValue(value: string | undefined): string {
    const parsed = Number.parseFloat((value ?? '').trim());
    if (!Number.isFinite(parsed)) {
      return (value ?? '').trim();
    }
    return parsed.toFixed(2);
  }

  private getIniCommentLines(
    key: string | undefined,
    fallback: string | undefined,
  ): string[] {
    const normalized = (key ?? '').trim();
    if (!normalized) {
      return fallback ? this.splitCommentLines(fallback) : [];
    }
    const translated = this.transloco.translateObject(
      `server.ini.comments.${normalized}`,
    ) as unknown;
    const translationKey = `server.ini.comments.${normalized}`;
    if (Array.isArray(translated)) {
      return translated.filter((line) => typeof line === 'string' && line.trim());
    }
    if (typeof translated === 'string') {
      const trimmed = translated.trim();
      if (!trimmed || trimmed === translationKey) {
        return fallback ? this.splitCommentLines(fallback) : [];
      }
      return [trimmed];
    }
    return fallback ? this.splitCommentLines(fallback) : [];
  }

  private splitCommentLines(comment: string): string[] {
    return comment
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  private refreshBooleanOptions(): void {
    this.booleanOptions = [
      { label: this.transloco.translate('server.ui.trueLabel'), value: 'true' },
      { label: this.transloco.translate('server.ui.falseLabel'), value: 'false' },
    ];
  }

  private async loadServerTabTranslations(
    tab: string,
    locale: string,
  ): Promise<void> {
    const normalized = this.normalizeLocale(locale);
    const normalizedTab = tab || 'ini';
    const cacheKey = `${normalizedTab}:${normalized}`;
    if (this.loadedServerTabs.has(cacheKey)) {
      if (normalizedTab === 'ini') {
        this.refreshIniEntryOptions();
      } else if (normalizedTab === 'sandbox') {
        this.refreshSandboxEntryOptions();
      }
      return;
    }
    if (normalizedTab === 'ini') {
      const existing = this.transloco.getTranslation(normalized) as {
        server?: { ini?: Record<string, string> };
      };
      const hasIni =
        existing?.server?.ini && Object.keys(existing.server.ini).length > 0;
      if (hasIni) {
        this.loadedServerTabs.add(cacheKey);
        this.refreshIniEntryOptions();
        return;
      }
      this.localization.beginLocaleLoading();
    }
    try {
      const data = await this.fetchJsonWithTimeout(
        `/assets/i18n/server/${normalizedTab}/${normalized}.json`,
        3000,
      );
      const payload =
        normalizedTab === 'ini'
          ? { server: { ini: (data as { ini?: Record<string, string> }).ini ?? data } }
          : { server: { [normalizedTab]: data } };
      this.transloco.setTranslation(payload, normalized, { merge: true });
      this.loadedServerTabs.add(cacheKey);
      this.localization.notifyCache({
        type: 'page',
        name: `server:${normalizedTab}:${normalized}`,
      });
    } catch {
      // Ignore missing locale scope files; fallback labels handle it.
    } finally {
      if (normalizedTab === 'ini') {
        this.ensureIniTranslationsForLocale(this.iniLines, normalized);
        this.refreshIniEntryOptions();
        this.localization.endLocaleLoading();
      } else if (normalizedTab === 'sandbox') {
        this.ensureSandboxTranslationsForLocale(this.sandboxEntries, normalized);
        this.refreshSandboxEntryOptions();
      }
    }
  }

  private ensureSandboxTranslationsForLocale(
    entries: Array<{ key: string }>,
    locale: string,
  ): void {
    if ((locale || '').trim() !== 'en-US') {
      return;
    }
    const labels: Record<string, string> = {};
    for (const entry of entries) {
      const raw = (entry.key ?? '').trim();
      if (!raw) {
        continue;
      }
      labels[raw] = this.formatSandboxLabelFallback(raw);
    }
    if (!Object.keys(labels).length) {
      return;
    }
    const existing = this.transloco.getTranslation(locale) as {
      server?: { sandbox?: Record<string, string> };
    };
    const existingSandbox = existing?.server?.sandbox ?? {};
    const missing: Record<string, string> = {};
    for (const [key, label] of Object.entries(labels)) {
      if (!(key in existingSandbox)) {
        missing[key] = label;
      }
    }
    if (Object.keys(missing).length) {
      this.transloco.setTranslation(
        { server: { sandbox: missing } },
        locale,
        { merge: true },
      );
    }
  }

  private ensureIniTranslationsForLocale(lines: IniLine[], locale: string): void {
    if ((locale || '').trim() !== 'en-US') {
      return;
    }
    const labels: Record<string, string> = {};
    for (const line of lines) {
      if (line.kind !== 'entry' || !line.key) {
        continue;
      }
      const raw = line.key.trim();
      if (!raw) {
        continue;
      }
      labels[raw] = this.formatIniLabelFallback(raw);
    }
    if (!Object.keys(labels).length) {
      return;
    }
    const existing = this.transloco.getTranslation(locale) as {
      server?: { ini?: Record<string, string> };
    };
    const existingIni = existing?.server?.ini ?? {};
    const missing: Record<string, string> = {};
    for (const [key, label] of Object.entries(labels)) {
      if (!(key in existingIni)) {
        missing[key] = label;
      }
    }
    if (Object.keys(missing).length) {
      this.transloco.setTranslation(
        { server: { ini: missing } },
        locale,
        { merge: true },
      );
    }
  }

  private refreshIniEntryOptions(): void {
    const options = this.iniEntryRows.map((line) => {
      const displayValue = this.shouldUseIniDecimalFormat(line.comment)
        ? this.formatIniDecimalValue(line.value)
        : (line.value ?? '');
      return {
        label: `${this.formatIniLabel(line.key)} = ${displayValue}`,
        key: line.key ?? '',
      };
    });
    this.iniEntryOptions = options;
    const locale = this.normalizeLocale(this.transloco.getActiveLang());
    this.iniEntryOptionsByLocale.set(locale, options);
  }

  private applyCachedIniOptions(locale: string): void {
    const normalized = this.normalizeLocale(locale);
    const cached = this.iniEntryOptionsByLocale.get(normalized);
    if (!cached) {
      return;
    }
    this.iniEntryOptions = cached;
  }

  private normalizeLocale(locale: string | undefined | null): string {
    const raw = (locale ?? '').trim();
    return raw || 'en-US';
  }

  private async fetchJsonWithTimeout(
    url: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    try {
      const data = await Promise.race([
        firstValueFrom(this.http.get<Record<string, unknown>>(url)),
        new Promise<Record<string, unknown>>((resolve) =>
          setTimeout(() => resolve({}), timeoutMs),
        ),
      ]);
      return data ?? {};
    } catch {
      return {};
    }
  }

  private async fetchTextWithTimeout(
    url: string,
    timeoutMs: number,
  ): Promise<string | null> {
    try {
      const data = await Promise.race([
        firstValueFrom(this.http.get(url, { responseType: 'text' })),
        new Promise<string | null>((resolve) =>
          setTimeout(() => resolve(null), timeoutMs),
        ),
      ]);
      return typeof data === 'string' ? data : null;
    } catch {
      return null;
    }
  }

  private async loadDefaultServerFiles(): Promise<{
    ini: string;
    sandboxVars: string;
    spawnpoints: string;
    spawnregions: string;
  }> {
    const basePath = '/assets/server/defaults';
    const [ini, sandboxVars, spawnpoints, spawnregions] = await Promise.all([
      this.fetchTextWithTimeout(`${basePath}/server.ini`, 3000),
      this.fetchTextWithTimeout(`${basePath}/server_SandboxVars.lua`, 3000),
      this.fetchTextWithTimeout(`${basePath}/server_spawnpoints.lua`, 3000),
      this.fetchTextWithTimeout(`${basePath}/server_spawnregions.lua`, 3000),
    ]);
    return {
      ini: ini ?? '# Generated by PZ Honus Hub\nMods=\nWorkshopItems=\nMap=\n',
      sandboxVars: sandboxVars ?? '-- SandboxVars\nSandboxVars = {\n}\n',
      spawnpoints:
        spawnpoints ??
        '-- Spawnpoints\nfunction SpawnPoints()\n    return {\n    }\nend\n',
      spawnregions:
        spawnregions ??
        '-- Spawnregions\nfunction SpawnRegions()\n    return {\n    }\nend\n',
    };
  }

  private clearIniLocaleCache(locale: string): void {
    const normalized = this.normalizeLocale(locale);
    this.iniEntryOptionsByLocale.delete(normalized);
    const tabKey = `ini:${normalized}`;
    this.loadedServerTabs.delete(tabKey);
  }

}
