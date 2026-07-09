import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module.js";

const DEFAULT_PORT = 4000;

async function bootstrap(): Promise<void> {
  // `rawBody: true` exposes the untouched request buffer on `req.rawBody`, which
  // the Clerk webhook controller needs to verify the Standard Webhooks / svix
  // signature over the exact bytes Clerk signed.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(ConfigService);

  // The web app's client islands (e.g. the avatar-upload island) call this API
  // directly from the browser with a Clerk-issued Bearer token (never cookies —
  // see `apps/web/lib/api-client.ts` + `useAuth().getToken()`), so
  // `credentials: true` is unnecessary here. Scoped to the same `APP_URL` origin
  // already used by `ClerkGuard#getAuthorizedParties` (Decision #13) rather than
  // introducing a second config key for the same value.
  const appUrl = config.get<string>("APP_URL");
  app.enableCors({
    origin: appUrl ?? false,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  const port = Number(config.get("API_PORT")) || DEFAULT_PORT;
  await app.listen(port);
  console.log(`[api] listening on http://localhost:${port}`);
}

void bootstrap();
