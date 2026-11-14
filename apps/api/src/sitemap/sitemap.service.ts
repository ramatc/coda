import { Injectable } from "@nestjs/common";
import type { SitemapEntries, SitemapEntry } from "@coda/types";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  SITEMAP_CACHE_TTL_MS,
  SITEMAP_MAX_ALBUMS,
  SITEMAP_MAX_LISTS,
} from "./sitemap.constants.js";

interface SitemapRow {
  id: string;
  updatedAt: Date;
}

interface CachedEntries {
  expiresAt: number;
  entries: Promise<SitemapEntries>;
}

const SITEMAP_SELECT = { id: true, updatedAt: true } as const;

function toEntry(row: SitemapRow): SitemapEntry {
  return { id: row.id, updatedAt: row.updatedAt.toISOString() };
}

/**
 * Feeds the web app's `sitemap.xml` with the pages anonymous visitors can
 * open: every album and every public list.
 */
@Injectable()
export class SitemapService {
  private cached: CachedEntries | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The same for every caller, so the route needs no viewer and the result is
   * kept in memory for `SITEMAP_CACHE_TTL_MS`: the route is unauthenticated and
   * reads up to tens of thousands of rows, so repeat or concurrent callers must
   * not each cost two database queries. The in-flight promise is what is
   * cached, and a failed read is dropped so the next caller retries.
   */
  getEntries(): Promise<SitemapEntries> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.entries;
    }

    const entries = this.loadEntries();
    const cached = { expiresAt: now + SITEMAP_CACHE_TTL_MS, entries };
    this.cached = cached;
    entries.catch(() => {
      if (this.cached === cached) {
        this.cached = null;
      }
    });
    return entries;
  }

  /**
   * `isPublic: true` is applied in the query, so a private list never leaves
   * Postgres, and the projection is `id` + `updatedAt` only. Both queries are
   * capped (see `sitemap.constants.ts`); the `id` tiebreak keeps the cut
   * deterministic.
   */
  private async loadEntries(): Promise<SitemapEntries> {
    const [albums, lists] = await Promise.all([
      this.prisma.client.album.findMany({
        select: SITEMAP_SELECT,
        orderBy: [{ popularityScore: "desc" }, { id: "asc" }],
        take: SITEMAP_MAX_ALBUMS,
      }),
      this.prisma.client.list.findMany({
        where: { isPublic: true },
        select: SITEMAP_SELECT,
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        take: SITEMAP_MAX_LISTS,
      }),
    ]);

    return { albums: albums.map(toEntry), lists: lists.map(toEntry) };
  }
}
