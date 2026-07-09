import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";

const logger = new Logger("CorsConfig");

export interface CorsConfig {
  origin: string | false;
  methods: string[];
  allowedHeaders: string[];
}

/**
 * Builds the CORS configuration passed to `app.enableCors(...)` in
 * `main.ts`. Extracted into its own function (rather than inlined in
 * `bootstrap()`) so it can be unit-tested directly — every e2e spec boots the
 * test app via `Test.createTestingModule({ imports: [AppModule] }).compile()`
 * + `createNestApplication()`, which never calls `bootstrap()` itself, so the
 * real CORS wiring was previously untested.
 *
 * The web app's client islands (e.g. the avatar-upload island) call this API
 * directly from the browser with a Clerk-issued Bearer token (never cookies —
 * see `apps/web/lib/api-client.ts` + `useAuth().getToken()`), so
 * `credentials: true` is unnecessary here. Scoped to the same `APP_URL`
 * origin already used by `ClerkGuard#getAuthorizedParties` (Decision #13)
 * rather than introducing a second config key for the same value.
 */
export function buildCorsOptions(config: ConfigService): CorsConfig {
  const appUrl = config.get<string>("APP_URL");
  if (!appUrl) {
    // `origin: false` below fails CLOSED (blocks every browser cross-origin
    // call) which is the safe default for CORS, but that failure mode has no
    // other signal pointing at the cause — log it explicitly so a missing
    // `APP_URL` doesn't look like "everything is broken" with no lead.
    logger.warn(
      "APP_URL is not configured — CORS is disabled, browser-based clients will be blocked",
    );
  }
  return {
    origin: appUrl ?? false,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  };
}
