import { Module } from "@nestjs/common";
import { SitemapController } from "./sitemap.controller.js";
import { SitemapService } from "./sitemap.service.js";

/** Public sitemap feed. `PrismaService` comes from the global PrismaModule. */
@Module({
  controllers: [SitemapController],
  providers: [SitemapService],
})
export class SitemapModule {}
