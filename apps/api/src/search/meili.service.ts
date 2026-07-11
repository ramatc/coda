import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ALBUMS_INDEX,
  ALBUMS_INDEX_SETTINGS,
  ARTISTS_INDEX,
  ARTISTS_INDEX_SETTINGS,
  DEFAULT_MEILI_HOST,
  MEILI_HOST_ENV,
  MEILI_MASTER_KEY_ENV,
} from "./search.constants.js";
import type {
  AlbumSearchDocument,
  ArtistSearchDocument,
} from "./search-document.js";

/** A single page of Meilisearch hits plus the total-match estimate. */
export interface MeiliSearchPage<T> {
  hits: T[];
  estimatedTotalHits: number;
}

/** Pagination inputs for a Meilisearch query (offset derived by the caller). */
export interface MeiliSearchParams {
  limit: number;
  offset: number;
}

/**
 * Thin Meilisearch client for the search projection (PR7, design Decision #6).
 *
 * Deliberately talks to Meilisearch's REST API over the global `fetch` rather
 * than pulling in the `meilisearch` npm SDK — this matches how {@link SpotifyClient}
 * and {@link MusicBrainzClient} already wrap their upstream HTTP APIs, keeps the
 * dependency surface small, and makes the whole thing unit-testable against a
 * stubbed `fetch` with no live Meilisearch (sandbox convention from PR5/PR6).
 *
 * Configuration is read once at construction ({@link MEILI_HOST_ENV} /
 * {@link MEILI_MASTER_KEY_ENV}). Constructing the service performs NO network I/O,
 * so importing {@link SearchModule} into `AppModule` never touches Meili at boot
 * and the full-AppModule e2e suite stays offline — the same lazy-infra posture
 * as the catalog BullMQ producer.
 *
 * Fase 1 MVP scope note: writes fire-and-forget against Meili's async task queue
 * (this client does not poll task completion) and there is no bespoke retry or
 * failure-escalation logic here — a failed sync is retried by the enclosing
 * BullMQ `search-sync` job's standard `attempts`/`backoff`, and the whole index
 * can be rebuilt at any time with `reindex:search`. That is sufficient
 * resilience for a single-operator MVP (same lesson applied in PR5/PR6).
 */
@Injectable()
export class MeiliService {
  private readonly host: string;
  private readonly apiKey: string | undefined;

  constructor(config: ConfigService) {
    this.host = (
      config.get<string>(MEILI_HOST_ENV) ?? DEFAULT_MEILI_HOST
    ).replace(/\/+$/, "");
    this.apiKey = config.get<string>(MEILI_MASTER_KEY_ENV);
  }

  /**
   * Creates (if missing) the album/artist indexes and applies their searchable/
   * filterable/sortable attribute settings. Idempotent: Meili treats a repeated
   * `POST /indexes` for an existing uid and a repeated settings patch as no-ops,
   * so this is safe to call on every worker boot and every reindex run.
   */
  async configureIndexes(): Promise<void> {
    await this.ensureIndex(ALBUMS_INDEX);
    await this.ensureIndex(ARTISTS_INDEX);
    await this.request(
      "PATCH",
      `/indexes/${ALBUMS_INDEX}/settings`,
      ALBUMS_INDEX_SETTINGS,
    );
    await this.request(
      "PATCH",
      `/indexes/${ARTISTS_INDEX}/settings`,
      ARTISTS_INDEX_SETTINGS,
    );
  }

  /** Adds/updates album documents (upsert by pk `id`). No-op on an empty batch. */
  async indexAlbums(documents: AlbumSearchDocument[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }
    await this.request(
      "POST",
      `/indexes/${ALBUMS_INDEX}/documents`,
      documents,
    );
  }

  /** Adds/updates artist documents (upsert by pk `id`). No-op on an empty batch. */
  async indexArtists(documents: ArtistSearchDocument[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }
    await this.request(
      "POST",
      `/indexes/${ARTISTS_INDEX}/documents`,
      documents,
    );
  }

  /** Ranked album search (Meili relevance). */
  async searchAlbums(
    query: string,
    params: MeiliSearchParams,
  ): Promise<MeiliSearchPage<AlbumSearchDocument>> {
    return this.searchIndex<AlbumSearchDocument>(ALBUMS_INDEX, query, params);
  }

  /** Ranked artist search (Meili relevance). */
  async searchArtists(
    query: string,
    params: MeiliSearchParams,
  ): Promise<MeiliSearchPage<ArtistSearchDocument>> {
    return this.searchIndex<ArtistSearchDocument>(ARTISTS_INDEX, query, params);
  }

  /**
   * Drops every document from both indexes. Used at the start of a full
   * `reindex:search` rebuild so stale rows (albums deleted from Postgres since
   * the last index) don't linger in the projection.
   */
  async clearIndexes(): Promise<void> {
    await this.request("DELETE", `/indexes/${ALBUMS_INDEX}/documents`);
    await this.request("DELETE", `/indexes/${ARTISTS_INDEX}/documents`);
  }

  private async ensureIndex(uid: string): Promise<void> {
    // Meili returns 202 for a new index and 4xx (index_already_exists) for an
    // existing one — both are fine here, so a non-OK response is swallowed
    // rather than thrown. The settings PATCH that follows would auto-create the
    // index anyway; this call just makes the primary key (`id`) explicit.
    try {
      await this.request("POST", "/indexes", { uid, primaryKey: "id" });
    } catch {
      // Index already exists (or a transient blip a retry/settings-patch will
      // surface) — not fatal to configuration.
    }
  }

  private async searchIndex<T>(
    index: string,
    query: string,
    params: MeiliSearchParams,
  ): Promise<MeiliSearchPage<T>> {
    const body = await this.request<{
      hits?: T[];
      estimatedTotalHits?: number;
    }>("POST", `/indexes/${index}/search`, {
      q: query,
      limit: params.limit,
      offset: params.offset,
    });
    return {
      hits: body?.hits ?? [],
      estimatedTotalHits: body?.estimatedTotalHits ?? 0,
    };
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${this.host}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Meilisearch ${method} ${path} failed: ${response.status} ${detail}`,
      );
    }
    // DELETE/PATCH task responses and search responses are all JSON; tolerate an
    // empty body defensively.
    return (await response.json().catch(() => undefined)) as T;
  }
}
