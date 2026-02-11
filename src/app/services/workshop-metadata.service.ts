import { Injectable } from '@angular/core';
import { fetch } from '@tauri-apps/plugin-http';
import { SteamApiKeyService } from './steam-api-key.service';

export const STEAM_API_TIMEOUT_CODE = 'STEAM_API_TIMEOUT';

export interface WorkshopMetadata {
  // Core file details (from GetDetails)
  result?: number;
  fileid: number;
  publishedfileid?: string;
  creator_id: number;
  creator?: string;
  creator_url: string;
  creator_appid?: number;
  consumer_appid?: number;
  consumer_shortcutid?: number;
  creator_name?: string | null;
  creator_realname?: string | null;
  creator_avatar?: string | null;
  appid: number;
  // Match Steam schema (these are strings in the API, but we export numbers)
  file_size?: number | null;
  preview_file_size?: string | number;
  filename: string;
  file_url?: string | null;
  preview_url?: string | null;
  title?: string | null;
  // Raw description from Steam
  file_description?: string | null;
  // Preserve raw timestamps from Steam (seconds since epoch)
  time_created?: number | null;
  time_updated?: number | null;
  // Raw tags array from Steam
  tags?: { tag?: string; display_name?: string }[] | null;
  // Convenience extracted tags and views (for UI)
  map_tags?: string[] | null;
  views?: number | null;
  map_views?: number | null;
  map_followers?: number;
  subscriptions?: number;
  url?: string | null;

  // Additional GetDetails fields
  hcontent_file?: string | null;
  hcontent_preview?: string | null;
  visibility?: number | null;
  flags?: number | null;
  workshop_file?: boolean | null;
  workshop_accepted?: boolean | null;
  show_subscribe_all?: boolean | null;
  num_comments_public?: number | null;
  banned?: boolean | null;
  ban_reason?: string | null;
  banner?: string | null;
  can_be_deleted?: boolean | null;
  app_name?: string | null;
  file_type?: number | null;
  can_subscribe?: boolean | null;
  favorited?: number | null;
  followers?: number | null;
  lifetime_subscriptions?: number | null;
  lifetime_favorited?: number | null;
  lifetime_followers?: number | null;
  // These are strings in the Steam API example
  lifetime_playtime?: string | number | null;
  lifetime_playtime_sessions?: string | number | null;
  num_children?: number | null;
  num_reports?: number | null;
  language?: number | null;
  maybe_inappropriate_sex?: boolean | null;
  maybe_inappropriate_violence?: boolean | null;
  revision_change_number?: number | null;
  revision?: number | null;
  ban_text_check_result?: number | null;

  // Raw tag objects (from GetDetails)
  raw_tags?: { tag?: string; display_name?: string }[] | null;

  // Author / player summary fields (from GetPlayerSummaries)
  creator_steamid?: string | null;
  creator_communityvisibilitystate?: number | null;
  creator_profilestate?: number | null;
  creator_commentpermission?: number | null;
  creator_profileurl?: string | null;
  creator_avatar_small?: string | null;
  creator_avatar_medium?: string | null;
  creator_avatar_hash?: string | null;
  creator_personastate?: number | null;
  creator_primaryclanid?: string | null;
  creator_timecreated?: number | null;
  creator_personastateflags?: number | null;
  creator_loccountrycode?: string | null;
  creator_locstatecode?: string | null;

  // Full raw author payload from GetPlayerSummaries (joined via creator/steamid)
  author?: any | null;

  error?: string;
}

export interface SteamNewsItem {
  gid: string;
  title: string;
  url: string;
  is_external_url: boolean;
  author: string;
  contents: string;
  feedlabel: string;
  date: number;
}

export interface SteamNewsResponse {
  appid: number;
  newsitems: SteamNewsItem[];
}

export interface WorkshopQueryItem {
  publishedfileid: string;
  title?: string;
  short_description?: string;
  file_size?: number;
  subscriptions?: number;
  lifetime_subscriptions?: number;
  favorited?: number;
  lifetime_favorited?: number;
  views?: number;
  lifetime_playtime?: number;
  lifetime_playtime_sessions?: number;
  time_created?: number;
  time_updated?: number;
  file_type?: number;
  visibility?: number;
  tags?: { tag?: string; display_name?: string }[];
  num_children?: number;
  children?: {
    publishedfileid?: string;
    sortorder?: number;
    filetype?: number;
  }[];
  preview_url?: string;
  file_description?: string;
}

export interface WorkshopQueryResult {
  total: number;
  items: WorkshopQueryItem[];
  nextCursor?: string;
}

@Injectable({
  providedIn: 'root',
})
export class WorkshopMetadataService {
  private readonly requestTimeoutMs = 15000;
  private readonly detailsEndpoint =
    'https://api.steampowered.com/IPublishedFileService/GetDetails/v1/';
  private readonly authorsEndpoint =
    'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
  private readonly newsEndpoint =
    'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';
  private readonly queryFilesEndpoint =
    'https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/';
  constructor(private readonly steamApiKeyService: SteamApiKeyService) {}

  private isTimeoutError(error: unknown): boolean {
    return error instanceof Error && error.message === STEAM_API_TIMEOUT_CODE;
  }

  private buildTimeoutError(): Error {
    const err = new Error(STEAM_API_TIMEOUT_CODE);
    err.name = 'SteamApiTimeout';
    return err;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    context: string,
  ): Promise<Response> {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const finalOptions = controller
      ? { ...options, signal: controller.signal }
      : options;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        if (controller) {
          controller.abort();
        }
        this.debugLog('[WorkshopMetadataService] Request timeout', {
          context,
          timeoutMs: this.requestTimeoutMs,
          url,
        });
        reject(this.buildTimeoutError());
      }, this.requestTimeoutMs);
    });

    try {
      return (await Promise.race([
        fetch(url, finalOptions),
        timeoutPromise,
      ])) as Response;
    } catch (err) {
      if (this.isTimeoutError(err)) {
        throw err;
      }
      if (controller?.signal.aborted) {
        throw this.buildTimeoutError();
      }
      throw err;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private buildDebugDetails(input: {
    context: string;
    request: { method: string; url: string; headers?: Record<string, string> };
    response?: { status?: number; statusText?: string; headers?: any; body?: string };
    error?: unknown;
  }): string {
    if (!this.isDebugEnabled()) {
      return '';
    }
    const parts: string[] = [];
    parts.push(`${input.context}`);
    parts.push(`${input.request.method} ${input.request.url}`);

    if (input.response) {
      const status = input.response.status ?? 'n/a';
      const statusText = input.response.statusText ?? '';
      parts.push(`status=${status}${statusText ? ` ${statusText}` : ''}`);
    }

    if (input.response?.body) {
      const body = input.response.body.trim();
      if (body) {
        const trimmed = body.length > 800 ? `${body.slice(0, 800)}...` : body;
        parts.push(`body=${trimmed}`);
      }
    }

    if (input.error) {
      const message =
        input.error instanceof Error
          ? input.error.message
          : typeof input.error === 'string'
            ? input.error
            : String(input.error);
      parts.push(`error=${message}`);
    }

    return ` Debug: ${parts.join(' | ')}`;
  }

  private async buildApiError(
    response: { status: number; statusText?: string; text?: () => Promise<string>; headers?: any },
    context: string,
    request: { method: string; url: string; headers?: Record<string, string> },
  ): Promise<Error> {
    let body = '';
    try {
      if (typeof response.text === 'function') {
        body = (await response.text()).trim();
      }
    } catch {
      body = '';
    }
    const status = response.status;
    const statusText = response.statusText ? ` ${response.statusText}` : '';
    const suffix = body ? ` - ${body.slice(0, 500)}` : '';
    const debug = this.buildDebugDetails({
      context,
      request,
      response: {
        status,
        statusText: response.statusText,
        headers: response.headers,
        body,
      },
    });
    if (debug) {
      this.debugLog('[WorkshopMetadataService] API error', {
        context,
        request,
        status,
        statusText: response.statusText,
        headers: response.headers,
        body,
      });
    }
    return new Error(`${context} failed (${status}${statusText})${suffix}${debug}`);
  }

  private buildFetchError(
    error: unknown,
    context: string,
    request: { method: string; url: string; headers?: Record<string, string> },
  ): Error {
    const debug = this.buildDebugDetails({ context, request, error });
    if (debug) {
      this.debugLog('[WorkshopMetadataService] Fetch error', {
        context,
        request,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : error,
      });
    }
    const baseMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Unknown error';
    return new Error(`${context} failed (${baseMessage})${debug}`);
  }

  private isDebugEnabled(): boolean {
    try {
      if (typeof window === 'undefined') {
        return false;
      }
      const raw = window.localStorage?.getItem('pz_debug_workshop') ?? '';
      return raw === '1' || raw.toLowerCase() === 'true';
    } catch {
      return false;
    }
  }

  private debugLog(message: string, payload?: any): void {
    if (!this.isDebugEnabled()) {
      return;
    }
    // eslint-disable-next-line no-console
    console.log(message, payload ?? '');
  }

  private normalizeDescription(description: unknown): string | null {
    if (typeof description !== 'string') {
      return null;
    }
    const maxChars = 10_000;
    return description.length <= maxChars
      ? description
      : description.slice(0, maxChars);
  }

  /**
   * Fetch workshop metadata for a batch of Workshop item ids.
   * The Steam Web API key is loaded from application storage (or LocalStorage)
   * under the key "steam_api_key".
   */
  async getBatchMetadata(ids: string[]): Promise<WorkshopMetadata[]> {
    if (!ids.length) {
      return [];
    }

    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return [
        {
          fileid: 0,
          creator_id: 0,
          creator_url: '',
          appid: 0,
          file_size: 0,
          filename: '',
          map_views: 0,
          map_followers: 0,
          subscriptions: 0,
          error:
            'Steam Web API Key is not set. Please add your key via "Set Steam API Key" before syncing with the Steam Workshop.',
        },
      ];
    }

    const normalizedIds = Array.from(
      new Set(
        ids
          .map((id) => String(id || '').trim())
          .filter((id) => id.length > 0),
      ),
    );

    if (!normalizedIds.length) {
      return [];
    }

    if (!this.isTauri()) {
      throw new Error(
        'Steam Workshop sync via Tauri HTTP is only available in the Tauri app runtime.',
      );
    }

    const batchSize = 100;
    const results: WorkshopMetadata[] = [];
    const statuses: {
      chunkIndex: number;
      ids: string[];
      success: boolean;
      error?: string;
    }[] = [];

    for (let i = 0; i < normalizedIds.length; i += batchSize) {
      const chunk = normalizedIds.slice(i, i + batchSize);
      const chunkIndex = i / batchSize;

      try {
        const chunkResults = await this.fetchBatchForIds(chunk, apiKey);
        results.push(...chunkResults);
        statuses.push({
          chunkIndex,
          ids: chunk,
          success: true,
        });
      } catch (err: any) {
        statuses.push({
          chunkIndex,
          ids: chunk,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    return results;
  }

  private isTauri(): boolean {
    return (
      typeof window !== 'undefined' &&
      (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window))
    );
  }

  private async fetchBatchForIds(
    ids: string[],
    apiKey: string,
  ): Promise<WorkshopMetadata[]> {
    if (!ids.length) {
      // Debug: no ids to fetch
      this.debugLog('[WorkshopMetadataService] fetchBatchForIds: no ids provided');
      return [];
    }

    const detailsParams: Record<string, string> = { key: apiKey };
    ids.forEach((id, index) => {
      detailsParams[`publishedfileids[${index}]`] = id;
    });

    const detailsQuery = new URLSearchParams(detailsParams).toString();
    const detailsUrl = `${this.detailsEndpoint}?${detailsQuery}`;

    this.debugLog('[WorkshopMetadataService] Fetching GetDetails', {
      url: this.detailsEndpoint,
      ids,
      detailsUrl,
    });

    let detailsResp;
    try {
      detailsResp = await fetch(detailsUrl, {
        method: 'GET',
      });
    } catch (err) {
      throw this.buildFetchError(err, 'GetDetails', {
        method: 'GET',
        url: detailsUrl,
      });
    }
    if (detailsResp.status === 401) {
      console.error('[WorkshopMetadataService] GetDetails returned 401');
      throw new Error('STEAM_API_UNAUTHORIZED');
    }
    if (!detailsResp.ok) {
      throw await this.buildApiError(detailsResp, 'GetDetails', {
        method: 'GET',
        url: detailsUrl,
      });
    }

    const detailsData: any = await detailsResp.json();
    this.debugLog('[WorkshopMetadataService] GetDetails raw response', {
      ids,
      response: detailsData,
    });
    const detailsList = detailsData?.response?.publishedfiledetails ?? [];

    const detailsById: Record<string, any> = {};
    const creatorIds: string[] = [];

    for (const details of detailsList) {
      const fid = String(details?.publishedfileid ?? '');
      if (!fid) {
        continue;
      }
      detailsById[fid] = details;
      const creator = details?.creator;
      if (creator) {
        creatorIds.push(String(creator));
      }
    }

    this.debugLog('[WorkshopMetadataService] Parsed GetDetails', {
      ids,
      creatorIds,
      detailsById,
    });

    let authorsById: Record<string, any> = {};

    if (creatorIds.length) {
      const uniqueCreatorIds = Array.from(new Set(creatorIds));

      const authorsParams = new URLSearchParams({
        key: apiKey,
        steamids: uniqueCreatorIds.join(','),
      }).toString();
      const authorsUrl = `${this.authorsEndpoint}?${authorsParams}`;

      this.debugLog('[WorkshopMetadataService] Fetching GetPlayerSummaries', {
        url: this.authorsEndpoint,
        uniqueCreatorIds,
        authorsUrl,
      });

      let authorsResp;
      try {
        authorsResp = await fetch(authorsUrl, {
          method: 'GET',
        });
      } catch (err) {
        throw this.buildFetchError(err, 'GetPlayerSummaries', {
          method: 'GET',
          url: authorsUrl,
        });
      }
      if (authorsResp.status === 401) {
        console.error('[WorkshopMetadataService] GetPlayerSummaries returned 401');
        throw new Error('STEAM_API_UNAUTHORIZED');
      }
      if (!authorsResp.ok) {
        throw await this.buildApiError(authorsResp, 'GetPlayerSummaries', {
          method: 'GET',
          url: authorsUrl,
        });
      }

      const authorsData: any = await authorsResp.json();
      this.debugLog(
        '[WorkshopMetadataService] GetPlayerSummaries raw response',
        authorsData,
      );
      const players = authorsData?.response?.players ?? [];
      authorsById = {};
      for (const player of players) {
        const sid = String(player?.steamid ?? '');
        if (sid) {
          authorsById[sid] = player;
        }
      }

      this.debugLog('[WorkshopMetadataService] Parsed GetPlayerSummaries', {
        uniqueCreatorIds,
        playerCount: players.length,
        authorsById,
      });
    }

    return this.buildResults(ids, detailsById, authorsById);
  }

  async getProjectZomboidNews(
    count = 5,
  ): Promise<SteamNewsResponse | null> {
    if (!this.isTauri()) {
      return null;
    }

    const params = new URLSearchParams({
      appid: '108600',
      count: String(count),
      feeds: 'steam_community_announcements',
    }).toString();

    const url = `${this.newsEndpoint}?${params}`;

    let response;
    try {
      response = await this.fetchWithTimeout(
        url,
        { method: 'GET' },
        'GetNewsForApp',
      );
    } catch (err) {
      if (this.isTimeoutError(err)) {
        throw err;
      }
      throw this.buildFetchError(err, 'GetNewsForApp', {
        method: 'GET',
        url,
      });
    }
    if (!response.ok) {
      throw await this.buildApiError(response, 'GetNewsForApp', {
        method: 'GET',
        url,
      });
    }

    const data: any = await response.json();
    const appnews = data?.appnews;

    if (!appnews || !Array.isArray(appnews.newsitems)) {
      return null;
    }

    return {
      appid: Number(appnews.appid ?? 108600) || 108600,
      newsitems: appnews.newsitems as SteamNewsItem[],
    };
  }

  async queryTopWorkshopItemsForPZ(options?: {
    sortmethod?:
      | 'trend'
      | 'lifetime_subscriptions'
      | 'lifetime_playtime'
      | 'total_unique_subscriptions';
    numperpage?: number;
    page?: number;
    requiredtags?: string[];
  }): Promise<WorkshopQueryResult | null> {
    if (!this.isTauri()) {
      return null;
    }

    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return null;
    }

    const sortmethod =
      options?.sortmethod ?? 'lifetime_subscriptions';
    const numperpage = options?.numperpage ?? 20;
    const page = options?.page ?? 1;

    const params: Record<string, string> = {
      key: apiKey,
      appid: '108600',
      return_short_description: 'true',
      query_type: '9',
      sortmethod,
      numperpage: String(numperpage),
      page: String(page),
    };

    (options?.requiredtags ?? []).forEach((tag, index) => {
      params[`requiredtags[${index}]`] = tag;
    });

    const query = new URLSearchParams(params).toString();
    const url = `${this.queryFilesEndpoint}?${query}`;

    let response;
    try {
      response = await this.fetchWithTimeout(
        url,
        { method: 'GET' },
        'QueryFiles',
      );
    } catch (err) {
      if (this.isTimeoutError(err)) {
        throw err;
      }
      throw this.buildFetchError(err, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }
    if (response.status === 401) {
      throw new Error('STEAM_API_UNAUTHORIZED');
    }
    if (!response.ok) {
      throw await this.buildApiError(response, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }

    const data: any = await response.json();
    const resp = data?.response;
    if (!resp || !Array.isArray(resp.publishedfiledetails)) {
      return null;
    }

    const items: WorkshopQueryItem[] = resp.publishedfiledetails.map(
      (item: any) => ({
        publishedfileid: String(item.publishedfileid ?? ''),
        title: item.title,
        short_description:
          typeof item.short_description === 'string'
            ? item.short_description
            : undefined,
        file_size:
          typeof item.file_size === 'number'
            ? item.file_size
            : Number(item.file_size) || undefined,
        subscriptions:
          typeof item.subscriptions === 'number'
            ? item.subscriptions
            : Number(item.subscriptions) || undefined,
        lifetime_subscriptions:
          typeof item.lifetime_subscriptions === 'number'
            ? item.lifetime_subscriptions
            : Number(item.lifetime_subscriptions) || undefined,
        favorited:
          typeof item.favorited === 'number'
            ? item.favorited
            : Number(item.favorited) || undefined,
        lifetime_favorited:
          typeof item.lifetime_favorited === 'number'
            ? item.lifetime_favorited
            : Number(item.lifetime_favorited) || undefined,
        views:
          typeof item.views === 'number'
            ? item.views
            : Number(item.views) || undefined,
        lifetime_playtime:
          typeof item.lifetime_playtime === 'number'
            ? item.lifetime_playtime
            : Number(item.lifetime_playtime) || undefined,
        lifetime_playtime_sessions:
          typeof item.lifetime_playtime_sessions === 'number'
            ? item.lifetime_playtime_sessions
            : Number(item.lifetime_playtime_sessions) || undefined,
        time_created:
          typeof item.time_created === 'number'
            ? item.time_created
            : Number(item.time_created) || undefined,
        time_updated:
          typeof item.time_updated === 'number'
            ? item.time_updated
            : Number(item.time_updated) || undefined,
        tags: Array.isArray(item.tags) ? item.tags : undefined,
      }),
    );

    return {
      total: Number(resp.total ?? items.length) || items.length,
      items,
    };
  }

  async queryCollectionsForPZ(options?: {
    numperpage?: number;
    cursor?: string;
    searchText?: string;
    sort?: 'trend' | 'mostrecent' | 'lastupdated';
    days?: number;
    requiredtags?: string[];
  }): Promise<WorkshopQueryResult | null> {
    if (!this.isTauri()) {
      return null;
    }

    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return null;
    }

    const numperpage = options?.numperpage ?? 50;
    const cursor = options?.cursor ?? '*';
    const searchText = (options?.searchText ?? '').trim();
    const sort = options?.sort ?? 'trend';
    const days = options?.days ?? 7;
    const requiredtags = options?.requiredtags ?? [];

      const params: Record<string, string> = {
        key: apiKey,
        appid: '108600',
        return_short_description: 'true',
        return_previews: 'true',
        return_children: 'true',
        return_tags: 'true',
        filetype: '1',
        cursor,
        numperpage: String(numperpage),
      };

    if (searchText) {
      params['query_type'] = '12';
      params['search_text'] = searchText;
    } else if (sort === 'trend') {
      params['query_type'] = '3';
      params['days'] = String(days);
      params['include_recent_votes_only'] = 'true';
    } else if (sort === 'lastupdated') {
      params['query_type'] = '21';
    } else {
      params['query_type'] = '1';
    }

    requiredtags.forEach((tag, index) => {
      const trimmed = (tag ?? '').trim();
      if (trimmed) {
        params[`requiredtags[${index}]`] = trimmed;
      }
    });

    const query = new URLSearchParams(params).toString();
    const url = `${this.queryFilesEndpoint}?${query}`;

    let response;
    try {
      response = await this.fetchWithTimeout(
        url,
        { method: 'GET' },
        'QueryFiles',
      );
    } catch (err) {
      if (this.isTimeoutError(err)) {
        throw err;
      }
      throw this.buildFetchError(err, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }
    if (response.status === 401) {
      throw new Error('STEAM_API_UNAUTHORIZED');
    }
    if (!response.ok) {
      throw await this.buildApiError(response, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }

    const data: any = await response.json();
    const resp = data?.response;
    if (!resp || !Array.isArray(resp.publishedfiledetails)) {
      return null;
    }

    const items: WorkshopQueryItem[] = resp.publishedfiledetails.map(
      (item: any) => ({
        publishedfileid: String(item.publishedfileid ?? ''),
        title: item.title,
        short_description:
          typeof item.short_description === 'string'
            ? item.short_description
            : undefined,
        file_size:
          typeof item.file_size === 'number'
            ? item.file_size
            : Number(item.file_size) || undefined,
        subscriptions:
          typeof item.subscriptions === 'number'
            ? item.subscriptions
            : Number(item.subscriptions) || undefined,
        lifetime_subscriptions:
          typeof item.lifetime_subscriptions === 'number'
            ? item.lifetime_subscriptions
            : Number(item.lifetime_subscriptions) || undefined,
        favorited:
          typeof item.favorited === 'number'
            ? item.favorited
            : Number(item.favorited) || undefined,
        lifetime_favorited:
          typeof item.lifetime_favorited === 'number'
            ? item.lifetime_favorited
            : Number(item.lifetime_favorited) || undefined,
        views:
          typeof item.views === 'number'
            ? item.views
            : Number(item.views) || undefined,
        lifetime_playtime:
          typeof item.lifetime_playtime === 'number'
            ? item.lifetime_playtime
            : Number(item.lifetime_playtime) || undefined,
        lifetime_playtime_sessions:
          typeof item.lifetime_playtime_sessions === 'number'
            ? item.lifetime_playtime_sessions
            : Number(item.lifetime_playtime_sessions) || undefined,
        time_created:
          typeof item.time_created === 'number'
            ? item.time_created
            : Number(item.time_created) || undefined,
        time_updated:
          typeof item.time_updated === 'number'
            ? item.time_updated
            : Number(item.time_updated) || undefined,
        file_type:
          typeof item.file_type === 'number'
            ? item.file_type
            : Number(item.file_type) || undefined,
        visibility:
          typeof item.visibility === 'number'
            ? item.visibility
            : Number(item.visibility) || undefined,
        tags: Array.isArray(item.tags) ? item.tags : undefined,
        num_children:
          typeof item.num_children === 'number'
            ? item.num_children
            : Number(item.num_children) || undefined,
        children: Array.isArray(item.children) ? item.children : undefined,
        preview_url:
          typeof item.preview_url === 'string' ? item.preview_url : undefined,
        file_description:
          typeof item.file_description === 'string'
            ? item.file_description
            : undefined,
      }),
    );

    return {
      total: Number(resp.total ?? items.length) || items.length,
      items,
      nextCursor: typeof resp.next_cursor === 'string' ? resp.next_cursor : undefined,
    };
  }

  async queryCollectionsTotalForPZ(options?: {
    searchText?: string;
    sort?: 'trend' | 'mostrecent' | 'lastupdated';
    days?: number;
    requiredtags?: string[];
  }): Promise<number | null> {
    if (!this.isTauri()) {
      return null;
    }

    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return null;
    }

    const searchText = (options?.searchText ?? '').trim();
    const sort = options?.sort ?? 'trend';
    const days = options?.days ?? 7;
    const requiredtags = options?.requiredtags ?? [];

      const params: Record<string, string> = {
        key: apiKey,
        appid: '108600',
        totalonly: 'true',
        filetype: '1',
      };

    if (searchText) {
      params['query_type'] = '12';
      params['search_text'] = searchText;
    } else if (sort === 'trend') {
      params['query_type'] = '3';
      params['days'] = String(days);
      params['include_recent_votes_only'] = 'true';
    } else if (sort === 'lastupdated') {
      params['query_type'] = '21';
    } else {
      params['query_type'] = '1';
    }

    requiredtags.forEach((tag, index) => {
      const trimmed = (tag ?? '').trim();
      if (trimmed) {
        params[`requiredtags[${index}]`] = trimmed;
      }
    });

    const query = new URLSearchParams(params).toString();
    const url = `${this.queryFilesEndpoint}?${query}`;

    let response;
    try {
      response = await this.fetchWithTimeout(
        url,
        { method: 'GET' },
        'QueryFiles',
      );
    } catch (err) {
      if (this.isTimeoutError(err)) {
        throw err;
      }
      throw this.buildFetchError(err, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }
    if (response.status === 401) {
      throw new Error('STEAM_API_UNAUTHORIZED');
    }
    if (!response.ok) {
      throw await this.buildApiError(response, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }

    const data: any = await response.json();
    const total = Number(data?.response?.total ?? NaN);
    return Number.isFinite(total) ? total : null;
  }

  async queryModsBySearchText(
    searchText: string,
    numperpage = 5,
  ): Promise<WorkshopQueryResult | null> {
    if (!this.isTauri()) {
      return null;
    }

    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return null;
    }

    const trimmed = (searchText ?? '').trim();
    if (!trimmed) {
      return null;
    }

    const params: Record<string, string> = {
      key: apiKey,
      appid: '108600',
      return_short_description: 'true',
      query_type: '12',
      search_text: trimmed,
      filetype: '0',
      numperpage: String(numperpage),
      page: '1',
    };

    const query = new URLSearchParams(params).toString();
    const url = `${this.queryFilesEndpoint}?${query}`;

    let response;
    try {
      response = await this.fetchWithTimeout(
        url,
        { method: 'GET' },
        'QueryFiles',
      );
    } catch (err) {
      if (this.isTimeoutError(err)) {
        throw err;
      }
      throw this.buildFetchError(err, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }
    if (response.status === 401) {
      throw new Error('STEAM_API_UNAUTHORIZED');
    }
    if (!response.ok) {
      throw await this.buildApiError(response, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }

    const data: any = await response.json();
    const resp = data?.response;
    if (!resp || !Array.isArray(resp.publishedfiledetails)) {
      return null;
    }

    const items: WorkshopQueryItem[] = resp.publishedfiledetails.map(
      (item: any) => ({
        publishedfileid: String(item.publishedfileid ?? ''),
        title: item.title,
        short_description:
          typeof item.short_description === 'string'
            ? item.short_description
            : undefined,
        file_size:
          typeof item.file_size === 'number'
            ? item.file_size
            : Number(item.file_size) || undefined,
        subscriptions:
          typeof item.subscriptions === 'number'
            ? item.subscriptions
            : Number(item.subscriptions) || undefined,
        lifetime_subscriptions:
          typeof item.lifetime_subscriptions === 'number'
            ? item.lifetime_subscriptions
            : Number(item.lifetime_subscriptions) || undefined,
        favorited:
          typeof item.favorited === 'number'
            ? item.favorited
            : Number(item.favorited) || undefined,
        lifetime_favorited:
          typeof item.lifetime_favorited === 'number'
            ? item.lifetime_favorited
            : Number(item.lifetime_favorited) || undefined,
        views:
          typeof item.views === 'number'
            ? item.views
            : Number(item.views) || undefined,
        lifetime_playtime:
          typeof item.lifetime_playtime === 'number'
            ? item.lifetime_playtime
            : Number(item.lifetime_playtime) || undefined,
        lifetime_playtime_sessions:
          typeof item.lifetime_playtime_sessions === 'number'
            ? item.lifetime_playtime_sessions
            : Number(item.lifetime_playtime_sessions) || undefined,
        time_created:
          typeof item.time_created === 'number'
            ? item.time_created
            : Number(item.time_created) || undefined,
        time_updated:
          typeof item.time_updated === 'number'
            ? item.time_updated
            : Number(item.time_updated) || undefined,
        tags: Array.isArray(item.tags) ? item.tags : undefined,
      }),
    );

    return {
      total: Number(resp.total ?? items.length) || items.length,
      items,
    };
  }

  /**
   * Fetch the latest created Project Zomboid Workshop items.
   * Uses QueryFiles ranked by publication date and ready-to-use items,
   * matching the community "Most Recent" browse view.
   */
  async queryLatestWorkshopItemsForPZ(options?: {
    numperpage?: number;
    cursor?: string;
  }): Promise<WorkshopQueryResult | null> {
    if (!this.isTauri()) {
      return null;
    }

    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return null;
    }

    const numperpage = options?.numperpage ?? 20;
    const cursor = options?.cursor ?? '*';

    const params: Record<string, string> = {
      key: apiKey,
      appid: '108600',
      return_short_description: 'true',
      // Ranked by publication date (most recent created items).
      query_type: '1',
      // "readytouseitems" section on the community browse page.
      filetype: '18',
      cursor,
      numperpage: String(numperpage),
    };

    const query = new URLSearchParams(params).toString();
    const url = `${this.queryFilesEndpoint}?${query}`;

    let response;
    try {
      response = await this.fetchWithTimeout(
        url,
        { method: 'GET' },
        'QueryFiles',
      );
    } catch (err) {
      if (this.isTimeoutError(err)) {
        throw err;
      }
      throw this.buildFetchError(err, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }
    if (response.status === 401) {
      throw new Error('STEAM_API_UNAUTHORIZED');
    }
    if (!response.ok) {
      throw await this.buildApiError(response, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }

    const data: any = await response.json();
    const resp = data?.response;
    if (!resp || !Array.isArray(resp.publishedfiledetails)) {
      return null;
    }

    const items: WorkshopQueryItem[] = resp.publishedfiledetails.map(
      (item: any) => ({
        publishedfileid: String(item.publishedfileid ?? ''),
        title: item.title,
        short_description:
          typeof item.short_description === 'string'
            ? item.short_description
            : undefined,
        file_size:
          typeof item.file_size === 'number'
            ? item.file_size
            : Number(item.file_size) || undefined,
        subscriptions:
          typeof item.subscriptions === 'number'
            ? item.subscriptions
            : Number(item.subscriptions) || undefined,
        lifetime_subscriptions:
          typeof item.lifetime_subscriptions === 'number'
            ? item.lifetime_subscriptions
            : Number(item.lifetime_subscriptions) || undefined,
        favorited:
          typeof item.favorited === 'number'
            ? item.favorited
            : Number(item.favorited) || undefined,
        lifetime_favorited:
          typeof item.lifetime_favorited === 'number'
            ? item.lifetime_favorited
            : Number(item.lifetime_favorited) || undefined,
        views:
          typeof item.views === 'number'
            ? item.views
            : Number(item.views) || undefined,
        lifetime_playtime:
          typeof item.lifetime_playtime === 'number'
            ? item.lifetime_playtime
            : Number(item.lifetime_playtime) || undefined,
        lifetime_playtime_sessions:
          typeof item.lifetime_playtime_sessions === 'number'
            ? item.lifetime_playtime_sessions
            : Number(item.lifetime_playtime_sessions) || undefined,
        time_created:
          typeof item.time_created === 'number'
            ? item.time_created
            : Number(item.time_created) || undefined,
        time_updated:
          typeof item.time_updated === 'number'
            ? item.time_updated
            : Number(item.time_updated) || undefined,
        file_type:
          typeof item.file_type === 'number'
            ? item.file_type
            : Number(item.file_type) || undefined,
        visibility:
          typeof item.visibility === 'number'
            ? item.visibility
            : Number(item.visibility) || undefined,
        tags: Array.isArray(item.tags) ? item.tags : undefined,
      }),
    );

    return {
      total: Number(resp.total ?? items.length) || items.length,
      items,
      nextCursor: typeof resp.next_cursor === 'string' ? resp.next_cursor : undefined,
    };
  }

  /**
   * Fetch the latest updated Project Zomboid Workshop items.
   * Uses QueryFiles ranked by last updated date and ready-to-use items.
   */
  async queryLatestUpdatedWorkshopItemsForPZ(options?: {
    numperpage?: number;
    cursor?: string;
  }): Promise<WorkshopQueryResult | null> {
    if (!this.isTauri()) {
      return null;
    }

    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return null;
    }

    const numperpage = options?.numperpage ?? 20;
    const cursor = options?.cursor ?? '*';

    const params: Record<string, string> = {
      key: apiKey,
      appid: '108600',
      return_short_description: 'true',
      // Ranked by last updated date.
      query_type: '21',
      // "readytouseitems" section on the community browse page.
      filetype: '18',
      cursor,
      numperpage: String(numperpage),
    };

    const query = new URLSearchParams(params).toString();
    const url = `${this.queryFilesEndpoint}?${query}`;

    let response;
    try {
      response = await fetch(url, { method: 'GET' });
    } catch (err) {
      throw this.buildFetchError(err, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }
    if (response.status === 401) {
      throw new Error('STEAM_API_UNAUTHORIZED');
    }
    if (!response.ok) {
      throw await this.buildApiError(response, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }

    const data: any = await response.json();
    const resp = data?.response;
    if (!resp || !Array.isArray(resp.publishedfiledetails)) {
      return null;
    }

    const items: WorkshopQueryItem[] = resp.publishedfiledetails.map(
      (item: any) => ({
        publishedfileid: String(item.publishedfileid ?? ''),
        title: item.title,
        short_description:
          typeof item.short_description === 'string'
            ? item.short_description
            : undefined,
        file_size:
          typeof item.file_size === 'number'
            ? item.file_size
            : Number(item.file_size) || undefined,
        subscriptions:
          typeof item.subscriptions === 'number'
            ? item.subscriptions
            : Number(item.subscriptions) || undefined,
        lifetime_subscriptions:
          typeof item.lifetime_subscriptions === 'number'
            ? item.lifetime_subscriptions
            : Number(item.lifetime_subscriptions) || undefined,
        favorited:
          typeof item.favorited === 'number'
            ? item.favorited
            : Number(item.favorited) || undefined,
        lifetime_favorited:
          typeof item.lifetime_favorited === 'number'
            ? item.lifetime_favorited
            : Number(item.lifetime_favorited) || undefined,
        views:
          typeof item.views === 'number'
            ? item.views
            : Number(item.views) || undefined,
        lifetime_playtime:
          typeof item.lifetime_playtime === 'number'
            ? item.lifetime_playtime
            : Number(item.lifetime_playtime) || undefined,
        lifetime_playtime_sessions:
          typeof item.lifetime_playtime_sessions === 'number'
            ? item.lifetime_playtime_sessions
            : Number(item.lifetime_playtime_sessions) || undefined,
        time_created:
          typeof item.time_created === 'number'
            ? item.time_created
            : Number(item.time_created) || undefined,
        time_updated:
          typeof item.time_updated === 'number'
            ? item.time_updated
            : Number(item.time_updated) || undefined,
        file_type:
          typeof item.file_type === 'number'
            ? item.file_type
            : Number(item.file_type) || undefined,
        visibility:
          typeof item.visibility === 'number'
            ? item.visibility
            : Number(item.visibility) || undefined,
        tags: Array.isArray(item.tags) ? item.tags : undefined,
      }),
    );

    return {
      total: Number(resp.total ?? items.length) || items.length,
      items,
      nextCursor:
        typeof resp.next_cursor === 'string' ? resp.next_cursor : undefined,
    };
  }

  /**
   * Fetch popular Project Zomboid Workshop items for the last 7 days.
   * Uses QueryFiles ranked by trend (votes in recent days) and ready-to-use items.
   */
  async queryPopularWorkshopItemsThisWeekForPZ(options?: {
    numperpage?: number;
    cursor?: string;
  }): Promise<WorkshopQueryResult | null> {
    if (!this.isTauri()) {
      return null;
    }

    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return null;
    }

    const numperpage = options?.numperpage ?? 20;
    const cursor = options?.cursor ?? '*';

    const params: Record<string, string> = {
      key: apiKey,
      appid: '108600',
      return_short_description: 'true',
      query_type: '3',
      days: '7',
      // "readytouseitems" section on the community browse page.
      filetype: '18',
      cursor,
      numperpage: String(numperpage),
    };

    const query = new URLSearchParams(params).toString();
    const url = `${this.queryFilesEndpoint}?${query}`;

    let response;
    try {
      response = await fetch(url, { method: 'GET' });
    } catch (err) {
      throw this.buildFetchError(err, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }
    if (response.status === 401) {
      throw new Error('STEAM_API_UNAUTHORIZED');
    }
    if (!response.ok) {
      throw await this.buildApiError(response, 'QueryFiles', {
        method: 'GET',
        url,
      });
    }

    const data: any = await response.json();
    const resp = data?.response;
    if (!resp || !Array.isArray(resp.publishedfiledetails)) {
      return null;
    }

    const items: WorkshopQueryItem[] = resp.publishedfiledetails.map(
      (item: any) => ({
        publishedfileid: String(item.publishedfileid ?? ''),
        title: item.title,
        short_description:
          typeof item.short_description === 'string'
            ? item.short_description
            : undefined,
        file_size:
          typeof item.file_size === 'number'
            ? item.file_size
            : Number(item.file_size) || undefined,
        subscriptions:
          typeof item.subscriptions === 'number'
            ? item.subscriptions
            : Number(item.subscriptions) || undefined,
        lifetime_subscriptions:
          typeof item.lifetime_subscriptions === 'number'
            ? item.lifetime_subscriptions
            : Number(item.lifetime_subscriptions) || undefined,
        favorited:
          typeof item.favorited === 'number'
            ? item.favorited
            : Number(item.favorited) || undefined,
        lifetime_favorited:
          typeof item.lifetime_favorited === 'number'
            ? item.lifetime_favorited
            : Number(item.lifetime_favorited) || undefined,
        views:
          typeof item.views === 'number'
            ? item.views
            : Number(item.views) || undefined,
        lifetime_playtime:
          typeof item.lifetime_playtime === 'number'
            ? item.lifetime_playtime
            : Number(item.lifetime_playtime) || undefined,
        lifetime_playtime_sessions:
          typeof item.lifetime_playtime_sessions === 'number'
            ? item.lifetime_playtime_sessions
            : Number(item.lifetime_playtime_sessions) || undefined,
        time_created:
          typeof item.time_created === 'number'
            ? item.time_created
            : Number(item.time_created) || undefined,
        time_updated:
          typeof item.time_updated === 'number'
            ? item.time_updated
            : Number(item.time_updated) || undefined,
        file_type:
          typeof item.file_type === 'number'
            ? item.file_type
            : Number(item.file_type) || undefined,
        visibility:
          typeof item.visibility === 'number'
            ? item.visibility
            : Number(item.visibility) || undefined,
        tags: Array.isArray(item.tags) ? item.tags : undefined,
      }),
    );

    return {
      total: Number(resp.total ?? items.length) || items.length,
      items,
      nextCursor:
        typeof resp.next_cursor === 'string' ? resp.next_cursor : undefined,
    };
  }

  async queryRecentWorkshopItemsForPZ(params: {
    since: Date;
    type: 'created' | 'updated';
    limit?: number;
  }): Promise<WorkshopQueryItem[] | null> {
    if (!this.isTauri()) {
      return null;
    }

    const apiKey = await this.loadApiKey();
    if (!apiKey) {
      return null;
    }

    const sinceSeconds = Math.floor(params.since.getTime() / 1000);
    const limit = params.limit ?? 20;
    const maxPages = 5;

    const sortmethod =
      params.type === 'created' ? 'creation_order_desc' : 'lastupdated_desc';

    const collected: WorkshopQueryItem[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const queryParams: Record<string, string> = {
        key: apiKey,
        appid: '108600',
        return_short_description: 'true',
        query_type: '9',
        sortmethod,
        numperpage: '100',
        page: String(page),
      };

      const query = new URLSearchParams(queryParams).toString();
      const url = `${this.queryFilesEndpoint}?${query}`;

      let response;
      try {
        response = await this.fetchWithTimeout(
          url,
          { method: 'GET' },
          'QueryFiles',
        );
      } catch (err) {
        if (this.isTimeoutError(err)) {
          throw err;
        }
        throw this.buildFetchError(err, 'QueryFiles', {
          method: 'GET',
          url,
        });
      }
      if (response.status === 401) {
        throw new Error('STEAM_API_UNAUTHORIZED');
      }
      if (!response.ok) {
        await this.buildApiError(response, 'QueryFiles', {
          method: 'GET',
          url,
        });
        break;
      }

      const data: any = await response.json();
      const resp = data?.response;
      const details = resp?.publishedfiledetails;
      if (!resp || !Array.isArray(details) || !details.length) {
        break;
      }

      for (const item of details) {
        const base: WorkshopQueryItem = {
          publishedfileid: String(item.publishedfileid ?? ''),
          title: item.title,
          file_size:
            typeof item.file_size === 'number'
              ? item.file_size
              : Number(item.file_size) || undefined,
          subscriptions:
            typeof item.subscriptions === 'number'
              ? item.subscriptions
              : Number(item.subscriptions) || undefined,
          lifetime_subscriptions:
            typeof item.lifetime_subscriptions === 'number'
              ? item.lifetime_subscriptions
              : Number(item.lifetime_subscriptions) || undefined,
          favorited:
            typeof item.favorited === 'number'
              ? item.favorited
              : Number(item.favorited) || undefined,
          lifetime_favorited:
            typeof item.lifetime_favorited === 'number'
              ? item.lifetime_favorited
              : Number(item.lifetime_favorited) || undefined,
          views:
            typeof item.views === 'number'
              ? item.views
              : Number(item.views) || undefined,
          lifetime_playtime:
            typeof item.lifetime_playtime === 'number'
              ? item.lifetime_playtime
              : Number(item.lifetime_playtime) || undefined,
          lifetime_playtime_sessions:
            typeof item.lifetime_playtime_sessions === 'number'
              ? item.lifetime_playtime_sessions
              : Number(item.lifetime_playtime_sessions) || undefined,
          time_created:
            typeof item.time_created === 'number'
              ? item.time_created
              : Number(item.time_created) || undefined,
          time_updated:
            typeof item.time_updated === 'number'
              ? item.time_updated
              : Number(item.time_updated) || undefined,
          tags: Array.isArray(item.tags) ? item.tags : undefined,
        };

        const timestamp =
          params.type === 'created'
            ? base.time_created ?? 0
            : base.time_updated ?? 0;

        if (timestamp > sinceSeconds) {
          collected.push(base);
        } else {
          // Because we're sorted newest-first, we can stop on first older item.
          page = maxPages + 1;
          break;
        }

        if (collected.length >= limit) {
          page = maxPages + 1;
          break;
        }
      }
    }

    return collected;
  }

  private async loadApiKey(): Promise<string | null> {
    try {
      return await this.steamApiKeyService.get();
    } catch {
      return null;
    }
  }

  private buildResults(
    ids: string[],
    detailsById: Record<string, any>,
    authorsById: Record<string, any>,
  ): WorkshopMetadata[] {
    const results: WorkshopMetadata[] = [];

    this.debugLog('[WorkshopMetadataService] buildResults start', {
      ids,
      detailsKeys: Object.keys(detailsById),
      authorIds: Object.keys(authorsById),
    });

    for (const id of ids) {
      const details = detailsById[id];

      if (!details) {
        results.push({
          fileid: Number(id) || 0,
          creator_id: 0,
          creator_url: '',
          appid: 0,
          file_size: 0,
          filename: '',
          map_views: 0,
          map_followers: 0,
          subscriptions: 0,
          url: this.buildWorkshopUrl(id),
          error: 'No details returned for this workshop id.',
        });
        continue;
      }

      if (details.result !== 1) {
        results.push({
          fileid: Number(id) || 0,
          creator_id: 0,
          creator_url: '',
          appid: 0,
          file_size: 0,
          filename: '',
          map_views: 0,
          map_followers: 0,
          subscriptions: 0,
          url: this.buildWorkshopUrl(id),
          error:
            'Steam API reported a non-success result for this workshop id.',
        });
        continue;
      }

      // Use the raw string creator value as SteamID for joining to avoid
      // precision loss when converting to Number.
      const rawCreator: string = String(details.creator ?? '').trim();
      const creatorId = Number(rawCreator || 0) || 0;
      const author =
        rawCreator && authorsById[rawCreator]
          ? authorsById[rawCreator]
          : null;

      this.debugLog('[WorkshopMetadataService] buildResults join', {
        id,
        publishedfileid: details.publishedfileid,
        rawCreator,
        creatorId,
        joinKey: rawCreator,
        authorSteamId: author?.steamid ?? null,
        hasAuthor: !!author,
      });

      const meta = this.metadataFromDetails(details, author);
      meta.url = this.buildWorkshopUrl(id);

      results.push(meta);
    }

    return results;
  }

  private buildWorkshopUrl(id: string): string {
    const trimmed = (id || '').trim();
    if (!trimmed) {
      return '';
    }
    return `https://steamcommunity.com/sharedfiles/filedetails/?id=${trimmed}`;
  }

  private metadataFromDetails(details: any, author: any | null): WorkshopMetadata {
    const creatorId = Number(details?.creator ?? 0) || 0;
    const safeAuthor = author ?? {};

    // Prefer the profile URL from GetPlayerSummaries; map to the creator's
    // Steam Workshop page (list of their workshop files).
    let creatorUrl = '';
    const rawProfileUrl: string | undefined = safeAuthor.profileurl;
    if (rawProfileUrl && typeof rawProfileUrl === 'string') {
      const base =
        rawProfileUrl.endsWith('/') ? rawProfileUrl : `${rawProfileUrl}/`;
      creatorUrl = `${base}myworkshopfiles/`;
    } else if (creatorId) {
      creatorUrl = `https://steamcommunity.com/profiles/${creatorId}/myworkshopfiles/`;
    }

    const filenameFull = String(details?.filename ?? '') || '';
    const filename = filenameFull.split('/').pop() ?? '';

    const rawTags = Array.isArray(details?.tags) ? details.tags : [];
    const tagsList: string[] = [];
    for (const item of rawTags) {
      const tag = item?.tag;
      if (typeof tag === 'string') {
        tagsList.push(tag);
      }
    }

    const authorSummary =
      safeAuthor && typeof safeAuthor === 'object' ? safeAuthor : null;

    const fileSizeRaw = details?.file_size;
    const fileSize =
      typeof fileSizeRaw === 'number'
        ? fileSizeRaw
        : Number.isFinite(Number(fileSizeRaw))
          ? Number(fileSizeRaw)
          : null;

    this.debugLog('[WorkshopMetadataService] metadataFromDetails mapping', {
      publishedfileid: details?.publishedfileid,
      creatorRaw: details?.creator,
      creatorId,
      authorSteamId: safeAuthor.steamid,
      authorProfileUrl: safeAuthor.profileurl,
      authorPersona: safeAuthor.personaname,
      creatorFieldsPreview: {
        creator_steamid: safeAuthor.steamid ?? null,
        creator_profileurl: safeAuthor.profileurl ?? null,
        creator_avatar_small: safeAuthor.avatar ?? null,
        creator_avatar_medium: safeAuthor.avatarmedium ?? null,
        creator_avatar: safeAuthor.avatarfull ?? null,
        creator_loccountrycode: safeAuthor.loccountrycode ?? null,
        creator_locstatecode: safeAuthor.locstatecode ?? null,
      },
    });

    return {
      // Core details
      result: typeof details?.result === 'number' ? details.result : undefined,
      fileid: Number(details?.publishedfileid ?? 0) || 0,
      publishedfileid: details?.publishedfileid ?? undefined,
      creator_id: creatorId,
      creator: details?.creator ?? undefined,
      creator_url: creatorUrl,
      creator_name: safeAuthor.personaname ?? null,
      creator_realname: safeAuthor.realname ?? null,
      creator_avatar: safeAuthor.avatarfull ?? null,
      appid: Number(details?.creator_appid ?? 0) || 0,
      creator_appid: details?.creator_appid,
      consumer_appid: details?.consumer_appid,
      consumer_shortcutid: details?.consumer_shortcutid,
      file_size: fileSize,
      preview_file_size: details?.preview_file_size,
      filename,
      file_url: details?.url ?? null,
      preview_url: details?.preview_url ?? null,
      title: details?.title ?? null,
      file_description: this.normalizeDescription(details?.file_description),
      time_created:
        typeof details?.time_created === 'number'
          ? details.time_created
          : Number.isFinite(Number(details?.time_created))
            ? Number(details.time_created)
            : null,
      time_updated:
        typeof details?.time_updated === 'number'
          ? details.time_updated
          : Number.isFinite(Number(details?.time_updated))
            ? Number(details.time_updated)
            : null,
      // Raw tags + convenience flattened tags
      tags: rawTags,
      map_tags: tagsList,
      views:
        typeof details?.views === 'number' ? details.views : null,
      map_views: Number(details?.views ?? 0) || 0,
      map_followers: Number(details?.followers ?? 0) || 0,
      subscriptions: Number(details?.subscriptions ?? 0) || 0,
      // Additional GetDetails fields
      hcontent_file: details?.hcontent_file ?? null,
      hcontent_preview: details?.hcontent_preview ?? null,
      visibility:
        typeof details?.visibility === 'number' ? details.visibility : null,
      flags: typeof details?.flags === 'number' ? details.flags : null,
      workshop_file:
        typeof details?.workshop_file === 'boolean'
          ? details.workshop_file
          : null,
      workshop_accepted:
        typeof details?.workshop_accepted === 'boolean'
          ? details.workshop_accepted
          : null,
      show_subscribe_all:
        typeof details?.show_subscribe_all === 'boolean'
          ? details.show_subscribe_all
          : null,
      num_comments_public:
        typeof details?.num_comments_public === 'number'
          ? details.num_comments_public
          : null,
      banned: typeof details?.banned === 'boolean' ? details.banned : null,
      ban_reason: details?.ban_reason ?? null,
      banner: details?.banner ?? null,
      can_be_deleted:
        typeof details?.can_be_deleted === 'boolean'
          ? details.can_be_deleted
          : null,
      app_name: details?.app_name ?? null,
      file_type: details?.file_type ?? null,
      can_subscribe: details?.can_subscribe ?? null,
      favorited: details?.favorited ?? null,
      followers: details?.followers ?? null,
      lifetime_subscriptions: details?.lifetime_subscriptions ?? null,
      lifetime_favorited: details?.lifetime_favorited ?? null,
      lifetime_followers: details?.lifetime_followers ?? null,
      lifetime_playtime: details?.lifetime_playtime ?? null,
      lifetime_playtime_sessions: details?.lifetime_playtime_sessions ?? null,
      num_children: details?.num_children ?? null,
      num_reports: details?.num_reports ?? null,
      language: details?.language ?? null,
      maybe_inappropriate_sex:
        typeof details?.maybe_inappropriate_sex === 'boolean'
          ? details.maybe_inappropriate_sex
          : null,
      maybe_inappropriate_violence:
        typeof details?.maybe_inappropriate_violence === 'boolean'
          ? details.maybe_inappropriate_violence
          : null,
      revision_change_number: details?.revision_change_number ?? null,
      revision: details?.revision ?? null,
      ban_text_check_result: details?.ban_text_check_result ?? null,
      raw_tags: rawTags,
      // Author / player summary fields
      creator_steamid: safeAuthor.steamid ?? null,
      creator_communityvisibilitystate:
        typeof safeAuthor.communityvisibilitystate === 'number'
          ? safeAuthor.communityvisibilitystate
          : null,
      creator_profilestate:
        typeof safeAuthor.profilestate === 'number'
          ? safeAuthor.profilestate
          : null,
      creator_commentpermission:
        typeof safeAuthor.commentpermission === 'number'
          ? safeAuthor.commentpermission
          : null,
      creator_profileurl: safeAuthor.profileurl ?? null,
      creator_avatar_small: safeAuthor.avatar ?? null,
      creator_avatar_medium: safeAuthor.avatarmedium ?? null,
      creator_avatar_hash: safeAuthor.avatarhash ?? null,
      creator_personastate:
        typeof safeAuthor.personastate === 'number'
          ? safeAuthor.personastate
          : null,
      creator_primaryclanid: safeAuthor.primaryclanid ?? null,
      creator_timecreated:
        typeof safeAuthor.timecreated === 'number'
          ? safeAuthor.timecreated
          : null,
      creator_personastateflags:
        typeof safeAuthor.personastateflags === 'number'
          ? safeAuthor.personastateflags
          : null,
      creator_loccountrycode: safeAuthor.loccountrycode ?? null,
      creator_locstatecode: safeAuthor.locstatecode ?? null,
      author: authorSummary,
    };
  }

  private serializeDate(dt: Date): string {
    return dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

