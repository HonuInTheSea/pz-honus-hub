import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DashboardComponent } from '../../components/dashboard/dashboard.component';
import { ModSummary } from '../../models/mod.models';
import { ModsStateService } from '../../services/mods-state.service';
import {
  STEAM_API_TIMEOUT_CODE,
  WorkshopMetadataService,
  SteamNewsItem,
  WorkshopQueryItem,
} from '../../services/workshop-metadata.service';
import { MessageService } from 'primeng/api';

@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  imports: [
    CommonModule,
    DashboardComponent,
  ],
  providers: [MessageService],
  templateUrl: './dashboard.page.html',
})
export class DashboardPageComponent implements OnInit {
  mods: ModSummary[] = [];
  newsItems: SteamNewsItem[] = [];
  topWorkshopItems: WorkshopQueryItem[] = [];
  installedWorkshopIds: string[] = [];
  lastLocalSyncAt: string | null = null;
  lastWorkshopSyncAt: string | null = null;
  newWorkshopItemsSinceSync: WorkshopQueryItem[] = [];
  latestWorkshopItems: WorkshopQueryItem[] = [];
  latestUpdatedWorkshopItems: WorkshopQueryItem[] = [];
  popularWorkshopItemsThisWeek: WorkshopQueryItem[] = [];
  newsTimeout = false;
  topWorkshopTimeout = false;
  latestWorkshopTimeout = false;
  latestUpdatedWorkshopTimeout = false;
  popularWorkshopItemsThisWeekTimeout = false;
  modsLoading = false;
  newsLoading = false;
  topWorkshopLoading = false;
  newWorkshopItemsLoading = false;
  latestWorkshopItemsLoading = false;
  latestWorkshopItemsHasMore = true;
  latestUpdatedWorkshopItemsLoading = false;
  latestUpdatedWorkshopItemsHasMore = true;
  popularWorkshopItemsThisWeekLoading = false;
  popularWorkshopItemsThisWeekHasMore = true;
  private latestWorkshopPageSize = 20;
  private latestWorkshopLoadInFlight = false;
  private latestWorkshopCursor = '*';
  private latestUpdatedWorkshopPageSize = 20;
  private latestUpdatedWorkshopLoadInFlight = false;
  private latestUpdatedWorkshopCursor = '*';
  private popularWorkshopItemsThisWeekPageSize = 20;
  private popularWorkshopItemsThisWeekLoadInFlight = false;
  private popularWorkshopItemsThisWeekCursor = '*';
  private installedWorkshopIdsSet = new Set<string>();

  constructor(
    private readonly modsState: ModsStateService,
    private readonly workshopService: WorkshopMetadataService,
  ) {}

  async ngOnInit(): Promise<void> {
    this.modsLoading = true;
    this.newsLoading = true;
    this.topWorkshopLoading = true;
    this.newWorkshopItemsLoading = true;
    this.latestWorkshopItemsLoading = true;
    this.latestUpdatedWorkshopItemsLoading = true;
    this.popularWorkshopItemsThisWeekLoading = true;

    try {
      const persisted = await this.modsState.loadPersistedMods();
      if (persisted) {
        this.mods = persisted.local;
        this.lastLocalSyncAt = persisted.lastLocalSyncAt ?? null;
        this.lastWorkshopSyncAt = persisted.lastWorkshopSyncAt ?? null;
      } else {
        this.mods = [];
      }

      this.buildInstalledWorkshopIds();

      this.newsTimeout = false;
      try {
        const newsResponse =
          await this.workshopService.getProjectZomboidNews(5);
        this.newsItems = newsResponse?.newsitems ?? [];
      } catch (err) {
        if (this.isSteamApiTimeout(err)) {
          this.newsTimeout = true;
        } else {
          console.error('[Dashboard] Failed to load Steam news', err);
        }
      } finally {
        this.newsLoading = false;
      }

      this.topWorkshopTimeout = false;
      try {
        const topWorkshop = await this.workshopService
          .queryTopWorkshopItemsForPZ({
            sortmethod: 'lifetime_subscriptions',
            // Fetch a larger pool so we can derive
            // up to 10 installed items from it.
            numperpage: 100,
          });

        this.topWorkshopItems = topWorkshop?.items ?? [];
      } catch (err) {
        if (this.isSteamApiTimeout(err)) {
          this.topWorkshopTimeout = true;
        } else {
          console.error('[Dashboard] Failed to load top workshop items', err);
        }
      } finally {
        this.topWorkshopLoading = false;
      }

      await this.loadMoreLatestWorkshopItems();
      await this.loadMoreLatestUpdatedWorkshopItems();
      await this.loadMorePopularWorkshopItemsThisWeek();

      if (this.lastWorkshopSyncAt) {
        const since = new Date(this.lastWorkshopSyncAt);
        if (!Number.isNaN(since.getTime())) {
          try {
            const [created] = await Promise.all([
              this.workshopService.queryRecentWorkshopItemsForPZ({
                since,
                type: 'created',
                limit: 10,
              }),
            ]);

            this.newWorkshopItemsSinceSync = created ?? [];
          } catch (err) {
            if (!this.isSteamApiTimeout(err)) {
              console.error(
                '[Dashboard] Failed to load new workshop items since sync',
                err,
              );
            }
          } finally {
            this.newWorkshopItemsLoading = false;
          }
        } else {
          this.newWorkshopItemsLoading = false;
        }
      } else {
        this.newWorkshopItemsLoading = false;
      }
    } finally {
      this.modsLoading = false;
    }
  }

  async loadMoreLatestWorkshopItems(): Promise<void> {
    if (this.latestWorkshopLoadInFlight || !this.latestWorkshopItemsHasMore) {
      return;
    }

    this.latestWorkshopLoadInFlight = true;
    this.latestWorkshopItemsLoading = true;
    this.latestWorkshopTimeout = false;

    try {
      const result = await this.workshopService.queryLatestWorkshopItemsForPZ({
        numperpage: this.latestWorkshopPageSize,
        cursor: this.latestWorkshopCursor,
      });

      const items = result?.items ?? [];
      if (items.length) {
        // Filter to public, non-collection items to align with community browse.
        const filtered = items.filter((x) => {
          const visibility = x.visibility ?? 0;
          const fileType = x.file_type ?? 0;
          return visibility === 0 && fileType === 0;
        });

        const merged = [
          ...this.latestWorkshopItems,
          ...filtered,
        ];

        // Ensure strict descending order from "now" backwards.
        merged.sort((a, b) => (b.time_created ?? 0) - (a.time_created ?? 0));

        // Deduplicate by id in case of overlaps.
        const seen = new Set<string>();
        this.latestWorkshopItems = merged.filter((x) => {
          const id = (x.publishedfileid || '').trim();
          if (!id || seen.has(id)) {
            return false;
          }
          seen.add(id);
          return true;
        });
        if (result?.nextCursor) {
          this.latestWorkshopCursor = result.nextCursor;
        }
      }

      const total = result?.total ?? 0;
      if (
        !items.length ||
        !result?.nextCursor ||
        (total > 0 && this.latestWorkshopItems.length >= total)
      ) {
        this.latestWorkshopItemsHasMore = false;
      }
    } catch (err) {
      if (this.isSteamApiTimeout(err)) {
        this.latestWorkshopTimeout = true;
      } else {
        console.error('[Dashboard] Failed to load latest workshop items', err);
      }
    } finally {
      this.latestWorkshopItemsLoading = false;
      this.latestWorkshopLoadInFlight = false;
    }
  }

  async loadMoreLatestUpdatedWorkshopItems(): Promise<void> {
    if (
      this.latestUpdatedWorkshopLoadInFlight ||
      !this.latestUpdatedWorkshopItemsHasMore
    ) {
      return;
    }

    this.latestUpdatedWorkshopLoadInFlight = true;
    this.latestUpdatedWorkshopItemsLoading = true;
    this.latestUpdatedWorkshopTimeout = false;

    try {
      const result =
        await this.workshopService.queryLatestUpdatedWorkshopItemsForPZ({
          numperpage: this.latestUpdatedWorkshopPageSize,
          cursor: this.latestUpdatedWorkshopCursor,
        });

      const items = result?.items ?? [];
      if (items.length) {
        const filtered = items.filter((x) => {
          const visibility = x.visibility ?? 0;
          const fileType = x.file_type ?? 0;
          return visibility === 0 && fileType === 0;
        });

        const merged = [
          ...this.latestUpdatedWorkshopItems,
          ...filtered,
        ];

        merged.sort((a, b) => (b.time_updated ?? 0) - (a.time_updated ?? 0));

        const seen = new Set<string>();
        this.latestUpdatedWorkshopItems = merged.filter((x) => {
          const id = (x.publishedfileid || '').trim();
          if (!id || seen.has(id)) {
            return false;
          }
          seen.add(id);
          return true;
        });

        if (result?.nextCursor) {
          this.latestUpdatedWorkshopCursor = result.nextCursor;
        }
      }

      const total = result?.total ?? 0;
      if (
        !items.length ||
        !result?.nextCursor ||
        (total > 0 && this.latestUpdatedWorkshopItems.length >= total)
      ) {
        this.latestUpdatedWorkshopItemsHasMore = false;
      }
    } catch (err) {
      if (this.isSteamApiTimeout(err)) {
        this.latestUpdatedWorkshopTimeout = true;
      } else {
        console.error(
          '[Dashboard] Failed to load latest updated workshop items',
          err,
        );
      }
    } finally {
      this.latestUpdatedWorkshopItemsLoading = false;
      this.latestUpdatedWorkshopLoadInFlight = false;
    }
  }

  async loadMorePopularWorkshopItemsThisWeek(): Promise<void> {
    if (
      this.popularWorkshopItemsThisWeekLoadInFlight ||
      !this.popularWorkshopItemsThisWeekHasMore
    ) {
      return;
    }

    this.popularWorkshopItemsThisWeekLoadInFlight = true;
    this.popularWorkshopItemsThisWeekLoading = true;
    this.popularWorkshopItemsThisWeekTimeout = false;

    try {
      const result =
        await this.workshopService.queryPopularWorkshopItemsThisWeekForPZ({
          numperpage: this.popularWorkshopItemsThisWeekPageSize,
          cursor: this.popularWorkshopItemsThisWeekCursor,
        });

      const items = result?.items ?? [];
      if (items.length) {
        const filtered = items.filter((x) => {
          const visibility = x.visibility ?? 0;
          const fileType = x.file_type ?? 0;
          return visibility === 0 && fileType === 0;
        });

        const merged = [
          ...this.popularWorkshopItemsThisWeek,
          ...filtered,
        ];

        // QueryFiles already returns trend-ranked order; keep stable order.
        const seen = new Set<string>();
        this.popularWorkshopItemsThisWeek = merged.filter((x) => {
          const id = (x.publishedfileid || '').trim();
          if (!id || seen.has(id)) {
            return false;
          }
          seen.add(id);
          return true;
        });

        if (result?.nextCursor) {
          this.popularWorkshopItemsThisWeekCursor = result.nextCursor;
        }
      }

      const total = result?.total ?? 0;
      if (
        !items.length ||
        !result?.nextCursor ||
        (total > 0 && this.popularWorkshopItemsThisWeek.length >= total)
      ) {
        this.popularWorkshopItemsThisWeekHasMore = false;
      }
    } catch (err) {
      if (this.isSteamApiTimeout(err)) {
        this.popularWorkshopItemsThisWeekTimeout = true;
      } else {
        console.error(
          '[Dashboard] Failed to load popular workshop items this week',
          err,
        );
      }
    } finally {
      this.popularWorkshopItemsThisWeekLoading = false;
      this.popularWorkshopItemsThisWeekLoadInFlight = false;
    }
  }

  isWorkshopItemInstalled(item: WorkshopQueryItem): boolean {
    const id = (item.publishedfileid || '').trim();
    return !!id && this.installedWorkshopIdsSet.has(id);
  }

  private buildInstalledWorkshopIds(): void {
    const ids = new Set<string>();

    for (const mod of this.mods) {
      const directId = (mod.workshop_id || '').trim();
      if (directId) {
        ids.add(directId);
      }

      const workshopFileId =
        mod.workshop && typeof mod.workshop.fileid === 'number'
          ? String(mod.workshop.fileid)
          : null;

      if (workshopFileId) {
        ids.add(workshopFileId);
      }
    }

    this.installedWorkshopIdsSet = ids;
    this.installedWorkshopIds = Array.from(ids);
  }

  private isSteamApiTimeout(error: unknown): boolean {
    return error instanceof Error && error.message === STEAM_API_TIMEOUT_CODE;
  }
}
