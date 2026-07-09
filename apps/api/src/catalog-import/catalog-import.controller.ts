import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { CatalogQueue } from "./catalog-queue.js";
import { CatalogAdminGuard } from "./catalog-admin.guard.js";
import { SPOTIFY_PAGE_LIMIT } from "./catalog-import.constants.js";

interface SeedRequestBody {
  /** Optional page size override; defaults to {@link SPOTIFY_PAGE_LIMIT}. */
  limit?: unknown;
}

export interface SeedResponse {
  status: "enqueued";
  /** Offset the import will start (or resume) from. */
  offset: number;
  limit: number;
}

/**
 * Admin-only trigger for the Spotify bulk seed. Sits behind the global
 * {@link ClerkGuard} (authenticated) AND {@link CatalogAdminGuard} (allowlisted
 * Clerk user id — fails closed when unconfigured). The endpoint only ENQUEUES
 * the seed; the actual import runs in the separate `worker:catalog` process, so
 * the request returns immediately.
 *
 * Local/CI triggering that shouldn't mint an admin token instead uses the
 * `seed:catalog` npm script, which drives the same import in-process.
 */
@Controller("catalog-import")
@UseGuards(CatalogAdminGuard)
export class CatalogImportController {
  constructor(private readonly queue: CatalogQueue) {}

  @Post("spotify/seed")
  @HttpCode(202)
  async seedSpotify(@Body() body: SeedRequestBody): Promise<SeedResponse> {
    const limit = this.parseLimit(body?.limit);
    const { offset } = await this.queue.enqueueSeed(limit);
    return { status: "enqueued", offset, limit };
  }

  /**
   * Clamps a client-supplied page size to Spotify's 1-50 range, falling back to
   * the default for anything missing or malformed.
   */
  private parseLimit(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return SPOTIFY_PAGE_LIMIT;
    }
    return Math.min(Math.max(value, 1), SPOTIFY_PAGE_LIMIT);
  }
}
