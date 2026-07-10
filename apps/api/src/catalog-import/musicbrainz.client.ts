import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  MUSICBRAINZ_BASE_URL_ENV,
  MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS,
  MUSICBRAINZ_USER_AGENT_ENV,
} from "./catalog-import.constants.js";
import type {
  MusicBrainzEnrichment,
  MusicBrainzReleaseGroup,
  MusicBrainzReleaseGroupSearch,
  NormalizedGenre,
} from "./musicbrainz.types.js";

/** MusicBrainz Web Service v2 base host. */
const DEFAULT_BASE_URL = "https://musicbrainz.org";

/** Cap on how many release-group candidates to request per lookup (top match wins). */
const SEARCH_LIMIT = 5;

/** Cap on how many genres/tags to project onto an album (highest-voted first). */
const MAX_GENRES = 5;

/**
 * Minimum MusicBrainz search relevance score (0-100) the top candidate must
 * clear to be accepted as a match (judgment-day issue #2). Below this, a
 * generic/ambiguous album title can resolve to an unrelated release-group;
 * accepting it unconditionally would silently write a false-positive mbid as
 * authoritative data. A below-threshold top candidate is treated the same as a
 * genuinely empty result (`null`), never as an error.
 */
const MIN_MATCH_SCORE = 80;

/**
 * Thin MusicBrainz Web Service v2 client for the catalog-enrichment leg (PR6).
 * Given a seeded album's title + primary-artist name, it resolves the album's
 * MusicBrainz release-group mbid, the artist mbid, and a handful of genres/tags.
 *
 * Two hard requirements from MusicBrainz's usage policy are baked in here:
 *  1. A descriptive, contactable `User-Agent` on every request (from
 *     {@link MUSICBRAINZ_USER_AGENT_ENV}) — anonymous clients are throttled/blocked.
 *  2. ≤1 request/second. A serialized min-interval gate ({@link throttle}) spaces
 *     every outbound request by {@link MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS},
 *     CLIENT-side, so even concurrent callers on this shared DI singleton never
 *     breach the rate limit. This is defense-in-depth alongside the queue-level
 *     BullMQ limiter on the enrichment Worker.
 *
 * Like {@link SpotifyClient} it is stateless w.r.t. Redis/Postgres and unit-tested
 * against a stubbed global `fetch` (no live network, per the sandbox convention).
 */
@Injectable()
export class MusicBrainzClient {
  private readonly logger = new Logger(MusicBrainzClient.name);
  private readonly baseUrl: string;

  /** Epoch millis before which the next request must wait (the rate-limit gate). */
  private nextAvailableAtMs = 0;
  /**
   * Serialized acquisition chain: concurrent callers await this promise in
   * arrival order so exactly one request is released per interval, in sequence,
   * rather than all racing the same `nextAvailableAtMs` snapshot.
   */
  private gate: Promise<void> = Promise.resolve();

  constructor(private readonly config: ConfigService) {
    this.baseUrl =
      config.get<string>(MUSICBRAINZ_BASE_URL_ENV) ?? DEFAULT_BASE_URL;
  }

  /**
   * Looks up the best-matching MusicBrainz release-group for an album and
   * normalizes its mbid, artist, and genres. Returns `null` when MusicBrainz has
   * no candidate (a legitimate "nothing to enrich" outcome, not an error).
   *
   * Rate-limited: acquires the {@link throttle} gate before issuing the request,
   * guaranteeing ≥{@link MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS} between calls.
   */
  async lookupAlbum(
    title: string,
    artistName: string | null,
  ): Promise<MusicBrainzEnrichment | null> {
    const userAgent = this.requireConfig(MUSICBRAINZ_USER_AGENT_ENV);
    const url = new URL("/ws/2/release-group", this.baseUrl);
    url.searchParams.set("query", this.buildQuery(title, artistName));
    url.searchParams.set("fmt", "json");
    url.searchParams.set("limit", String(SEARCH_LIMIT));

    await this.throttle();

    const response = await fetch(url.toString(), {
      headers: {
        // MusicBrainz REQUIRES a descriptive, contactable User-Agent.
        "user-agent": userAgent,
        accept: "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(
        `MusicBrainz lookup failed: ${response.status} ${response.statusText}`,
      );
    }

    const body = (await response.json()) as MusicBrainzReleaseGroupSearch;
    const best = body["release-groups"]?.[0];
    if (!best?.id) {
      return null;
    }
    if (best.score !== undefined && best.score < MIN_MATCH_SCORE) {
      this.logger.warn(
        `Rejecting low-confidence MusicBrainz match ${best.id} for "${title}" ` +
          `(score ${best.score} < ${MIN_MATCH_SCORE}); treating as no-match`,
      );
      return null;
    }
    // A malformed/unexpected response shape (e.g. `artist-credit` present but
    // not an array) must not escape as a plain TypeError — the enrich worker's
    // per-item error isolation only recognizes Prisma-specific error types, so
    // an uncaught shape error here would exhaust BullMQ's retry budget on a
    // deterministically-failing job instead of being skipped benignly like a
    // malformed Spotify record (judgment-day issue #7).
    try {
      return this.normalize(best);
    } catch (err) {
      this.logger.warn(
        `Skipping malformed MusicBrainz release-group ${best.id}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Serialized min-interval gate. Chains each acquisition off the previous one
   * so callers are released strictly in order, one per interval. The gate is
   * advanced (`nextAvailableAtMs`) at ACQUISITION time (before the request
   * fires), which is what spaces consecutive requests by a fixed interval
   * regardless of how long each request itself takes.
   *
   * The chain is kept alive across rejections so a failed request never wedges
   * the gate for every subsequent caller.
   */
  private async throttle(): Promise<void> {
    const acquire = this.gate.then(async () => {
      const waitMs = Math.max(0, this.nextAvailableAtMs - Date.now());
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      this.nextAvailableAtMs =
        Date.now() + MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS;
    });
    this.gate = acquire.then(
      () => undefined,
      () => undefined,
    );
    await acquire;
  }

  /** Builds a Lucene query scoping the search to the album title + artist. */
  private buildQuery(title: string, artistName: string | null): string {
    const escapedTitle = this.escapeLucene(title);
    if (!artistName) {
      return `releasegroup:"${escapedTitle}"`;
    }
    return `releasegroup:"${escapedTitle}" AND artist:"${this.escapeLucene(artistName)}"`;
  }

  /** Escapes double-quotes/backslashes so a title can't break out of the quoted term. */
  private escapeLucene(value: string): string {
    return value.replace(/([\\"])/g, "\\$1");
  }

  private normalize(group: MusicBrainzReleaseGroup): MusicBrainzEnrichment {
    const credited = group["artist-credit"]?.find((c) => c.artist?.id)?.artist;
    const artist = credited
      ? { mbid: credited.id, name: credited.name }
      : null;

    // Prefer curated `genres`; fall back to folksonomy `tags` when absent.
    const rawGenres = group.genres?.length ? group.genres : group.tags ?? [];
    // Dedupe by slug BEFORE slicing to MAX_GENRES (judgment-day issue #8): two
    // raw tags that collapse to the same slug (e.g. differing only in casing or
    // punctuation) would otherwise consume two of the limited slots instead of
    // one, and the later-processed duplicate could silently overwrite an
    // earlier higher-weight entry in the upsert loop. Keep the max weight seen
    // per slug.
    const bySlug = new Map<string, NormalizedGenre>();
    for (const g of rawGenres) {
      if (g.name.trim().length === 0) {
        continue;
      }
      const slug = this.slugify(g.name);
      if (slug.length === 0) {
        continue;
      }
      const weight = g.count && g.count > 0 ? g.count : 1;
      const existing = bySlug.get(slug);
      if (!existing || weight > existing.weight) {
        bySlug.set(slug, { slug, name: g.name, weight });
      }
    }
    const genres: NormalizedGenre[] = [...bySlug.values()]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, MAX_GENRES);

    return { mbid: group.id, artist, genres };
  }

  /** Lowercases + hyphenates a genre/tag name into a stable `Genre.slug`. */
  private slugify(name: string): string {
    return name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  private requireConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      this.logger.error(`${key} is not configured`);
      throw new Error(`MusicBrainz enrichment is not configured (${key}).`);
    }
    return value;
  }
}
