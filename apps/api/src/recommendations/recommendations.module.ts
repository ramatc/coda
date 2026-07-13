import { Module } from "@nestjs/common";
import { RecommendationsController } from "./recommendations.controller.js";
import { RecommendationsService } from "./recommendations.service.js";
import { RecoGenerationService } from "./reco-generation.service.js";
import { RecoQueue } from "./reco.queue.js";

/**
 * Recommendations module (PR11, design Decision #7). Wires the read/dismiss
 * surface (`GET /recommendations`, `POST /recommendations/:id/dismiss`), the
 * heuristic generation core, and the `reco-generation` BullMQ producer.
 *
 * Like the catalog-import and search modules, NO BullMQ Worker is registered
 * here: the API process only PRODUCES generation jobs (from the onboarding and
 * tracking triggers). The `reco-generation` Worker + nightly repeatable refresh
 * run in the standalone `reco-worker.ts` process. All infra connections (Redis)
 * are opened lazily, so importing this module into `AppModule` never touches
 * Redis at boot. `PrismaService` and `ConfigService` come from their global
 * modules.
 *
 * `RecoGenerationService` and `RecoQueue` are exported so the standalone worker
 * can run generations and the onboarding/tracking modules can enqueue triggers.
 */
@Module({
  controllers: [RecommendationsController],
  providers: [RecommendationsService, RecoGenerationService, RecoQueue],
  exports: [RecoGenerationService, RecoQueue],
})
export class RecommendationsModule {}
