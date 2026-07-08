import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ClerkGuard } from "./clerk.guard.js";
import { AuthController } from "./auth.controller.js";
import { ClerkWebhookController } from "./clerk-webhook.controller.js";
import { ClerkWebhookService } from "./clerk-webhook.service.js";

/**
 * Auth module. Registers {@link ClerkGuard} as a global `APP_GUARD` (Decision
 * #1) so every route across the app is fail-closed by default, and wires the
 * Clerk webhook receiver + user-sync service (Decision #2). `PrismaService` and
 * `ConfigService` are injected from their respective global modules.
 */
@Module({
  controllers: [AuthController, ClerkWebhookController],
  providers: [
    ClerkWebhookService,
    {
      provide: APP_GUARD,
      useClass: ClerkGuard,
    },
  ],
})
export class AuthModule {}
