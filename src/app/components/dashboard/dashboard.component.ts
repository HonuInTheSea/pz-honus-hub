import { Component, DestroyRef, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModSummary } from '../../models/mod.models';
import {
  SteamNewsItem,
  WorkshopQueryItem,
} from '../../services/workshop-metadata.service';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { CardModule } from 'primeng/card';
import { ChartModule } from 'primeng/chart';
import { TooltipModule } from 'primeng/tooltip';
import { DialogModule } from 'primeng/dialog';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { ModDetailsComponent } from '../mod-details/mod-details.component';
import { LocalizationService } from '../../services/localization.service';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { formatLocalizedDateTime } from '../../i18n/date-time';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    FormsModule,
    CardModule,
    ChartModule,
    TooltipModule,
    DialogModule,
    ProgressSpinnerModule,
    ModDetailsComponent,
    TranslocoModule,
  ],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.css'],
})
export class DashboardComponent implements OnChanges {
  @Input() mods: ModSummary[] = [];
  @Input() showOverview = true;
  @Input() newsItems: SteamNewsItem[] = [];
  @Input() newsTimeout = false;
  @Input() topWorkshopItems: WorkshopQueryItem[] = [];
  @Input() topWorkshopTimeout = false;
  @Input() installedWorkshopIds: string[] = [];
  @Input() allMods: ModSummary[] = [];
  @Input() lastLocalSyncAt: string | null = null;
  @Input() lastWorkshopSyncAt: string | null = null;
  @Input() newWorkshopItemsSinceSync: WorkshopQueryItem[] = [];
  @Input() latestWorkshopItems: WorkshopQueryItem[] = [];
  @Input() latestWorkshopTimeout = false;
  @Input() latestUpdatedWorkshopItems: WorkshopQueryItem[] = [];
  @Input() latestUpdatedWorkshopTimeout = false;
  @Input() popularWorkshopItemsThisWeek: WorkshopQueryItem[] = [];
  @Input() popularWorkshopItemsThisWeekTimeout = false;
  @Input() modsLoading = false;
  @Input() newsLoading = false;
  @Input() topWorkshopLoading = false;
  @Input() newWorkshopItemsLoading = false;
  @Input() latestWorkshopItemsLoading = false;
  @Input() latestWorkshopItemsHasMore = true;
  @Input() latestUpdatedWorkshopItemsLoading = false;
  @Input() latestUpdatedWorkshopItemsHasMore = true;
  @Input() popularWorkshopItemsThisWeekLoading = false;
  @Input() popularWorkshopItemsThisWeekHasMore = true;

  @Output() loadMoreLatestWorkshopItems = new EventEmitter<void>();
  @Output() loadMoreLatestUpdatedWorkshopItems = new EventEmitter<void>();
  @Output() loadMorePopularWorkshopItemsThisWeek = new EventEmitter<void>();

  private currentLocale = 'en-US';
  private unknownLabel = 'Unknown';
  private neverLabel = 'Never';
  private numberFormatter = new Intl.NumberFormat('en-US');

  constructor(
    private readonly localization: LocalizationService,
    private readonly transloco: TranslocoService,
    private readonly destroyRef: DestroyRef,
  ) {
    this.currentLocale = this.localization.locale || 'en-US';
    this.numberFormatter = new Intl.NumberFormat(this.currentLocale || 'en-US');
    this.localization.locale$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((locale) => {
        this.currentLocale = locale;
        this.numberFormatter = new Intl.NumberFormat(this.currentLocale || 'en-US');
      });
    this.updateTranslations();
    this.transloco.langChanges$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.updateTranslations();
        this.updateCharts();
      });
  }

  formatSyncDate(value: string | null): string {
    if (!value) {
      return this.neverLabel;
    }

    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      return this.neverLabel;
    }

    return formatLocalizedDateTime(d, this.currentLocale);
  }

  installsChartData: any;
  installsChartOptions: any;
  updateStatusChartData: any;
  updateStatusChartOptions: any;
  sizeChartData: any;
  sizeChartOptions: any;
  detailsDialogVisible = false;
  selectedMod: ModSummary | null = null;

  get allModsForLinks(): ModSummary[] {
    return (this.allMods?.length ? this.allMods : this.mods) ?? [];
  }

  private getThemeTextColor(): string {
    if (typeof document === 'undefined') {
      return '#495057';
    }

    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--text-color')
      .trim();
    return value || '#495057';
  }

  get totalMods(): number {
    return this.mods.length;
  }

  get outdatedMods(): ModSummary[] {
    return this.mods.filter((mod) => this.isOutdated(mod));
  }

  get outdatedCount(): number {
    return this.outdatedMods.length;
  }

  get upToDateCount(): number {
    return Math.max(this.totalMods - this.outdatedCount, 0);
  }

  get lastUpdatedMods(): ModSummary[] {
    const withUpdated = this.mods
      .map((mod) => ({
        mod,
        updatedAt: this.getWorkshopTimestamp(mod.workshop?.time_updated),
      }))
      .filter((x) => x.updatedAt != null) as { mod: ModSummary; updatedAt: number }[];

    withUpdated.sort((a, b) => b.updatedAt - a.updatedAt);
    // Show the 10 most recently updated mods
    return withUpdated.slice(0, 10).map((x) => x.mod);
  }

  get largestModsBySize(): { mod: ModSummary; sizeBytes: number }[] {
    const items: { mod: ModSummary; sizeBytes: number }[] = [];

    for (const mod of this.mods) {
      const rawSize = mod.workshop?.file_size;
      if (rawSize == null) {
        continue;
      }

      const numeric = typeof rawSize === 'number' ? rawSize : Number(rawSize);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        continue;
      }

      items.push({ mod, sizeBytes: numeric });
    }

    items.sort((a, b) => b.sizeBytes - a.sizeBytes);
    return items.slice(0, 5);
  }

  get topWorkshopItemsLimited(): WorkshopQueryItem[] {
    return (this.topWorkshopItems || []).slice(0, 10);
  }

  get topInstalledWorkshopItems(): WorkshopQueryItem[] {
    const installedSet = new Set(this.installedWorkshopIds || []);

    const installedItems = (this.topWorkshopItems || []).filter((item) =>
      installedSet.has((item.publishedfileid || '').trim()),
    );

    installedItems.sort((a, b) => {
      const aSubs = a.subscriptions ?? a.lifetime_subscriptions ?? 0;
      const bSubs = b.subscriptions ?? b.lifetime_subscriptions ?? 0;
      return bSubs - aSubs;
    });

    return installedItems.slice(0, 10);
  }

  openInstalledItemDetails(item: WorkshopQueryItem): void {
    const mod = this.findModForWorkshopItem(item);
    if (!mod) {
      return;
    }
    this.openModDetails(mod);
  }

  private findModForWorkshopItem(
    item: WorkshopQueryItem,
  ): ModSummary | null {
    const id = (item.publishedfileid || '').trim();
    if (!id) {
      return null;
    }

    const direct = this.mods.find(
      (m) => (m.workshop_id || '').trim() === id,
    );
    if (direct) {
      return direct;
    }

    const viaFileId = this.mods.find((m) => {
      const fileId =
        m.workshop && typeof m.workshop.fileid === 'number'
          ? String(m.workshop.fileid)
          : '';
      return fileId === id;
    });

    return viaFileId ?? null;
  }

  ngOnChanges(): void {
    this.updateCharts();
  }

  openModDetails(mod: ModSummary): void {
    this.selectedMod = mod;
    this.detailsDialogVisible = true;
  }

  isNumericId(id: string | undefined | null): boolean {
    if (!id) {
      return false;
    }
    return /^[0-9]+$/.test(id);
  }

  steamWorkshopUrl(id: string | undefined | null): string {
    return `https://steamcommunity.com/sharedfiles/filedetails/?id=${id ?? ''}`;
  }

  async openSteamWorkshop(id: string | undefined | null): Promise<void> {
    if (!this.isNumericId(id)) {
      return;
    }
    await openUrl(this.steamWorkshopUrl(id));
  }

  async openCreatorWorkshop(url: string | undefined | null): Promise<void> {
    if (!url) {
      return;
    }
    await openUrl(url);
  }

  async openModFolder(mod: ModSummary): Promise<void> {
    if (!mod.mod_info_path) {
      return;
    }

    await invoke('open_mod_in_explorer', { path: mod.mod_info_path });
  }

  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return this.unknownLabel;
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1000 && unitIndex < units.length - 1) {
      value /= 1000;
      unitIndex += 1;
    }

    const formatted = this.formatNumber(value, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    return `${formatted} ${units[unitIndex]}`;
  }

  formatWorkshopDate(timestamp: number | string | null | undefined): string {
    const ms = this.getWorkshopTimestamp(timestamp);
    if (ms == null) {
      return this.unknownLabel;
    }
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) {
      return this.unknownLabel;
    }
    const locale = this.currentLocale || undefined;
    return d.toLocaleDateString(locale);
  }

  isWorkshopItemInstalled(item: WorkshopQueryItem): boolean {
    const id = (item.publishedfileid || '').trim();
    if (!id || !this.installedWorkshopIds || !this.installedWorkshopIds.length) {
      return false;
    }
    return this.installedWorkshopIds.includes(id);
  }

  onLatestWorkshopScroll(event: Event): void {
    if (this.latestWorkshopItemsLoading || !this.latestWorkshopItemsHasMore) {
      return;
    }
    const el = event.target as HTMLElement | null;
    if (!el) {
      return;
    }
    const threshold = 80;
    const nearBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
    if (nearBottom) {
      this.loadMoreLatestWorkshopItems.emit();
    }
  }

  onLatestUpdatedWorkshopScroll(event: Event): void {
    if (
      this.latestUpdatedWorkshopItemsLoading ||
      !this.latestUpdatedWorkshopItemsHasMore
    ) {
      return;
    }
    const el = event.target as HTMLElement | null;
    if (!el) {
      return;
    }
    const threshold = 80;
    const nearBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
    if (nearBottom) {
      this.loadMoreLatestUpdatedWorkshopItems.emit();
    }
  }

  onPopularWorkshopItemsThisWeekScroll(event: Event): void {
    if (
      this.popularWorkshopItemsThisWeekLoading ||
      !this.popularWorkshopItemsThisWeekHasMore
    ) {
      return;
    }
    const el = event.target as HTMLElement | null;
    if (!el) {
      return;
    }
    const threshold = 80;
    const nearBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
    if (nearBottom) {
      this.loadMorePopularWorkshopItemsThisWeek.emit();
    }
  }

  private updateCharts(): void {
    this.updateInstallsChart();
    this.updateUpdateStatusChart();
    this.updateSizeChart();
  }

  private updateInstallsChart(): void {
    const textColor = this.getThemeTextColor();
    const label = this.transloco.translate('dashboard.charts.installs.label');
    const xAxis = this.transloco.translate('dashboard.charts.installs.xAxis');
    const yAxis = this.transloco.translate('dashboard.charts.installs.yAxis');
    const countsByMonth: Record<string, number> = {};

    for (const mod of this.mods) {
      if (!mod.install_date) {
        continue;
      }
      const d = new Date(mod.install_date);
      if (Number.isNaN(d.getTime())) {
        continue;
      }
      const key = `${d.getFullYear()}-${(d.getMonth() + 1)
        .toString()
        .padStart(2, '0')}`;
      countsByMonth[key] = (countsByMonth[key] || 0) + 1;
    }

    const labels = Object.keys(countsByMonth).sort();
    const data = labels.map((l) => countsByMonth[l]);

    this.installsChartData = {
      labels,
      datasets: [
        {
          label,
          data,
          borderColor: '#42A5F5',
          backgroundColor: 'rgba(66, 165, 245, 0.2)',
          fill: true,
          tension: 0.3,
        },
      ],
    };

    this.installsChartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: textColor,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: textColor,
          },
          title: {
            display: true,
            text: xAxis,
            color: textColor,
          },
        },
        y: {
          ticks: {
            color: textColor,
          },
          title: {
            display: true,
            text: yAxis,
            color: textColor,
          },
          beginAtZero: true,
        },
      },
    };
  }

  private updateUpdateStatusChart(): void {
    const textColor = this.getThemeTextColor();
    const outdated = this.outdatedCount;
    const upToDate = this.upToDateCount;
    const outdatedLabel = this.transloco.translate('dashboard.charts.status.outdated');
    const upToDateLabel = this.transloco.translate('dashboard.charts.status.upToDate');

    this.updateStatusChartData = {
      labels: [outdatedLabel, upToDateLabel],
      datasets: [
        {
          data: [outdated, upToDate],
          backgroundColor: ['#EF5350', '#66BB6A'],
        },
      ],
    };

    this.updateStatusChartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: textColor,
          },
        },
      },
    };
  }

  private updateSizeChart(): void {
    const textColor = this.getThemeTextColor();
    const largest = this.largestModsBySize;
    const formatBytes = this.formatBytes.bind(this);
    const label = this.transloco.translate('dashboard.charts.size.label');
    const yAxis = this.transloco.translate('dashboard.charts.size.yAxis');

    this.sizeChartData = {
      labels: largest.map((x) => x.mod.name),
      datasets: [
        {
          label,
          data: largest.map((x) => x.sizeBytes),
          borderColor: '#AB47BC',
          backgroundColor: 'rgba(171, 71, 188, 0.2)',
          fill: true,
          tension: 0.3,
        },
      ],
    };

    this.sizeChartOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            label(context: any): string {
              const label = context.label || '';
              const value = context.parsed?.y ?? context.parsed ?? 0;
              const formatted = formatBytes(value);
              return label ? `${label}: ${formatted}` : formatted;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: textColor,
          },
          title: {
            display: false,
          },
        },
        y: {
          ticks: {
            color: textColor,
          },
          title: {
            display: true,
            text: yAxis,
            color: textColor,
          },
          beginAtZero: true,
        },
      },
    };
  }

  private isOutdated(mod: ModSummary): boolean {
    const timeUpdatedRaw = mod.workshop?.time_updated ?? null;
    if (!mod.install_date || timeUpdatedRaw == null) {
      return false;
    }

    const installDate = new Date(mod.install_date);

    const updatedMs = this.getWorkshopTimestamp(timeUpdatedRaw);
    if (updatedMs == null) {
      return false;
    }

    const timeUpdated = new Date(updatedMs);

    if (
      Number.isNaN(installDate.getTime()) ||
      Number.isNaN(timeUpdated.getTime())
    ) {
      return false;
    }

    return installDate.getTime() < timeUpdated.getTime();
  }

  private getWorkshopTimestamp(
    value: number | string | null | undefined,
  ): number | null {
    if (value == null) {
      return null;
    }

    if (typeof value === 'number') {
      const ms = value < 1e12 ? value * 1000 : value;
      return Number.isFinite(ms) ? ms : null;
    }

    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      const ms = numeric < 1e12 ? numeric * 1000 : numeric;
      return Number.isFinite(ms) ? ms : null;
    }

    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }

  private updateTranslations(): void {
    this.unknownLabel = this.transloco.translate('dashboard.labels.unknown');
    this.neverLabel = this.transloco.translate('dashboard.labels.never');
  }

  formatNumber(
    value: number,
    options?: Intl.NumberFormatOptions,
  ): string {
    if (!Number.isFinite(value)) {
      return this.unknownLabel;
    }
    if (!options) {
      return this.numberFormatter.format(value);
    }
    return new Intl.NumberFormat(this.currentLocale || 'en-US', options).format(value);
  }
}
