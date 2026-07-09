import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  SPOTIFY_CLIENT_ID_ENV,
  SPOTIFY_CLIENT_SECRET_ENV,
  SPOTIFY_PAGE_LIMIT,
  SPOTIFY_SEARCH_MAX_OFFSET,
} from "./catalog-import.constants.js";
import type {
  NormalizedAlbum,
  NormalizedAlbumPage,
  SpotifyAlbum,
  SpotifyAlbumPage,
  SpotifyTokenResponse,
} from "./spotify.types.js";

/** Spotify OAuth token endpoint (client-credentials grant). */
const DEFAULT_ACCOUNTS_BASE_URL = "https://accounts.spotify.com";
/** Spotify Web API base. */
const DEFAULT_API_BASE_URL = "https://api.spotify.com";
/**
 * Broad catalog query used to page through albums. Spotify has no single "all
 * albums" endpoint, so the seed pages a wide `search` query; the exact query is
 * a seed heuristic, not load-bearing to correctness (idempotent upserts make
 * any overlap harmless).
 */
const DEFAULT_SEED_QUERY = "year:1900-2025";
/**
 * Refresh the token this many seconds BEFORE it actually expires, so a
 * long-running page fetch can't straddle the expiry boundary mid-request.
 */
const TOKEN_EXPIRY_SAFETY_SECONDS = 60;

/**
 * Shared placeholder artist for artist-less albums (judgment-day issue #10):
 * a single fixed id so every such album resolves to ONE canonical
 * "Unknown Artist" row instead of a distinct phantom row per album.
 */
const UNKNOWN_ARTIST_SPOTIFY_ID = "unknown";

interface CachedToken {
  accessToken: string;
  /** Epoch millis after which the token must be refreshed. */
  expiresAtMs: number;
}

/**
 * Thin Spotify Web API client for the bulk seed. Handles the client-credentials
 * OAuth flow (app-level token, no user context — Decision #4) with in-memory
 * token caching, and pages the album catalog into {@link NormalizedAlbum}s.
 *
 * The client is stateless w.r.t. Redis/Postgres — it only talks to Spotify — so
 * it is trivially unit-testable against a stubbed global `fetch` (no live
 * network, per the sandbox convention established in PR1-3; `avatar.service.ts`
 * likewise takes only `ConfigService` and mocks its SDK at the module boundary).
 * Endpoint hosts are optionally overridable via config for a staging proxy, but
 * default to Spotify's real hosts so no extra env vars are required.
 */
@Injectable()
export class SpotifyClient {
  private readonly logger = new Logger(SpotifyClient.name);
  private readonly accountsBaseUrl: string;
  private readonly apiBaseUrl: string;
  private readonly seedQuery: string;
  private cachedToken: CachedToken | undefined;
  /**
   * In-flight token-refresh promise (judgment-day issue #3): memoized so
   * concurrent callers on this shared DI singleton await the SAME refresh
   * instead of each firing an independent request (thundering herd).
   */
  private pendingTokenRequest: Promise<string> | undefined;

  constructor(private readonly config: ConfigService) {
    this.accountsBaseUrl =
      config.get<string>("SPOTIFY_ACCOUNTS_URL") ?? DEFAULT_ACCOUNTS_BASE_URL;
    this.apiBaseUrl =
      config.get<string>("SPOTIFY_API_URL") ?? DEFAULT_API_BASE_URL;
    this.seedQuery =
      config.get<string>("SPOTIFY_SEED_QUERY") ?? DEFAULT_SEED_QUERY;
  }

  /**
   * Fetches one page of albums and normalizes it. `nextOffset` is `null` on the
   * final page (Spotify's `next` is null), signalling the pager to stop.
   *
   * Spotify enforces a hard cap on `/v1/search`'s `offset` + `limit`
   * ({@link SPOTIFY_SEARCH_MAX_OFFSET}) regardless of `total` — once pagination
   * would cross it, Spotify answers with a non-OK response. That's treated
   * here as a CLEAN, expected stop (not an error): this bounds the practical
   * per-query import size to ~1000 results, so reaching the ~100k album goal
   * needs multiple distinct seed queries partitioning the catalog (out of
   * scope for this PR — see {@link SPOTIFY_SEARCH_MAX_OFFSET}).
   */
  async getAlbumPage(
    offset: number,
    limit: number = SPOTIFY_PAGE_LIMIT,
  ): Promise<NormalizedAlbumPage> {
    const token = await this.getAccessToken();
    const url = new URL("/v1/search", this.apiBaseUrl);
    url.searchParams.set("q", this.seedQuery);
    url.searchParams.set("type", "album");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const response = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      if (offset + limit > SPOTIFY_SEARCH_MAX_OFFSET) {
        this.logger.log(
          `Reached Spotify's /v1/search offset cap at offset=${offset} ` +
            `(limit=${limit}) — stopping the import cleanly rather than ` +
            `treating this as an error.`,
        );
        return { albums: [], nextOffset: null };
      }
      throw new Error(
        `Spotify album search failed: ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json()) as { albums: SpotifyAlbumPage };
    const page = body.albums;
    const albums = page.items
      .filter((item): item is SpotifyAlbum => Boolean(item?.id))
      .map((item) => this.normalizeAlbum(item));

    return { albums, nextOffset: this.resolveNextOffset(page) };
  }

  /**
   * Returns a valid app access token, refreshing via the client-credentials
   * grant when the cache is empty or within the safety window of expiry.
   *
   * Memoizes the in-flight refresh so concurrent callers await the same
   * promise instead of each firing an independent token request (judgment-day
   * issue #3) — not reachable via the current sequential page→album wiring,
   * but `SpotifyClient` is a shared DI singleton and a future concurrent
   * caller would otherwise trigger a thundering herd of refreshes.
   */
  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAtMs) {
      return this.cachedToken.accessToken;
    }
    if (this.pendingTokenRequest) {
      return this.pendingTokenRequest;
    }

    this.pendingTokenRequest = this.refreshAccessToken().finally(() => {
      this.pendingTokenRequest = undefined;
    });
    return this.pendingTokenRequest;
  }

  /** Performs the actual client-credentials token refresh (see {@link getAccessToken}). */
  private async refreshAccessToken(): Promise<string> {
    const clientId = this.requireConfig(SPOTIFY_CLIENT_ID_ENV);
    const clientSecret = this.requireConfig(SPOTIFY_CLIENT_SECRET_ENV);
    // HTTP Basic with base64(clientId:clientSecret) is the client-credentials
    // grant's app authentication — no user/redirect flow involved.
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const response = await fetch(
      new URL("/api/token", this.accountsBaseUrl).toString(),
      {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Spotify token request failed: ${response.status} ${response.statusText}`,
      );
    }

    const token = (await response.json()) as SpotifyTokenResponse;
    this.cachedToken = {
      accessToken: token.access_token,
      expiresAtMs:
        Date.now() +
        (token.expires_in - TOKEN_EXPIRY_SAFETY_SECONDS) * 1000,
    };
    return this.cachedToken.accessToken;
  }

  private resolveNextOffset(page: SpotifyAlbumPage): number | null {
    // Prefer Spotify's own `next` cursor: null means we've reached the end.
    if (page.next === null) {
      return null;
    }
    // Guard against a non-null `next` that still runs past `total` (or an empty
    // page), which would otherwise loop forever fetching empty tail pages.
    if (page.items.length === 0) {
      return null;
    }
    // Parse the offset Spotify's own `next` URL actually reports rather than
    // recomputing it (judgment-day issue #9): arithmetic (`offset + limit`)
    // only matches reality because the pager always requests a fixed `limit`
    // — it would silently diverge if Spotify's pagination ever returned a
    // different count. Fall back to arithmetic only if `next` is unparseable.
    const nextOffset = this.parseNextOffset(page.next) ?? page.offset + page.limit;
    return nextOffset >= page.total ? null : nextOffset;
  }

  /** Parses the `offset` query param from Spotify's `next` URL, if present and valid. */
  private parseNextOffset(next: string): number | null {
    try {
      const offsetParam = new URL(next).searchParams.get("offset");
      if (offsetParam === null) {
        return null;
      }
      const offset = Number.parseInt(offsetParam, 10);
      return Number.isNaN(offset) ? null : offset;
    } catch {
      return null;
    }
  }

  private normalizeAlbum(album: SpotifyAlbum): NormalizedAlbum {
    const primary = album.artists?.[0];
    // Every album has at least one artist on Spotify; if a malformed payload
    // lacks one we synthesize a placeholder so the FK stays satisfiable rather
    // than dropping the album entirely.
    const primaryArtist = primary?.id
      ? {
          spotifyId: primary.id,
          name: primary.name,
          imageUrl: primary.images?.[0]?.url ?? null,
        }
      : {
          spotifyId: UNKNOWN_ARTIST_SPOTIFY_ID,
          name: "Unknown Artist",
          imageUrl: null,
        };

    return {
      spotifyId: album.id,
      title: album.name,
      releaseDate: this.normalizeReleaseDate(album),
      coverUrl: album.images?.[0]?.url ?? null,
      trackCount: album.total_tracks ?? null,
      popularityScore: album.popularity ?? 0,
      primaryArtist,
    };
  }

  /**
   * Normalizes Spotify's partial-precision `release_date` into a full ISO date
   * so it maps onto the Prisma `@db.Date` column. `year` precision → `-01-01`,
   * `month` → `-01`.
   */
  private normalizeReleaseDate(album: SpotifyAlbum): string | null {
    const raw = album.release_date;
    if (!raw) {
      return null;
    }
    switch (album.release_date_precision) {
      case "year":
        return `${raw}-01-01`;
      case "month":
        return `${raw}-01`;
      default:
        return raw;
    }
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      this.logger.error(`${key} is not configured`);
      throw new Error(`Spotify import is not configured (${key}).`);
    }
    return value;
  }
}
