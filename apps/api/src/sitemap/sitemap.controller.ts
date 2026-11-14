import { Controller, Get } from "@nestjs/common";
import type { SitemapEntries } from "@coda/types";
import { Public } from "../auth/public.decorator.js";
import { SitemapService } from "./sitemap.service.js";

/**
 * `GET /sitemap`: the ids and last-modified times of every album and every
 * public list, read by the web app to build `sitemap.xml`.
 *
 * `@Public()` sits on the HANDLER, not the class, so a route added here later
 * stays behind the global `ClerkGuard` unless it opts out itself. No
 * `OptionalClerkGuard`: nothing in the payload depends on who is asking.
 */
@Controller()
export class SitemapController {
  constructor(private readonly sitemap: SitemapService) {}

  @Public()
  @Get("sitemap")
  getEntries(): Promise<SitemapEntries> {
    return this.sitemap.getEntries();
  }
}
