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
  const port = Number(config.get("API_PORT")) || DEFAULT_PORT;
  await app.listen(port);
  console.log(`[api] listening on http://localhost:${port}`);
}

void bootstrap();
