import { Injectable } from "@nestjs/common";
import type { SitemapEntries, SitemapEntry } from "@coda/types";
import { PrismaService } from "../prisma/prisma.service.js";
import { SITEMAP_MAX_ALBUMS, SITEMAP_MAX_LISTS } from "./sitemap.constants.js";

interface SitemapRow {
  id: string;
  updatedAt: Date;
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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The same for every caller, so the route needs no viewer. `isPublic: true`
   * is applied in the query, so a private list never leaves Postgres, and the
   * projection is `id` + `updatedAt` only. Both queries are capped (see
   * `sitemap.constants.ts`); the `id` tiebreak keeps the cut deterministic.
   */
  async getEntries(): Promise<SitemapEntries> {
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
