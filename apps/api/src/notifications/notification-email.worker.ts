import "../load-env.js";
import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { Worker } from "bullmq";
import { AppModule } from "../app.module.js";
import { createBullConnection } from "../catalog-import/catalog-redis.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { createNotificationEmailProcessor } from "./notification-email.processor.js";
import type { NotificationEmailJobData } from "./notification-email.queue.js";
import {
  APP_URL_ENV,
  NOTIFICATION_EMAIL_QUEUE,
  REDIS_URL_ENV,
} from "./notifications.constants.js";
import { ResendService } from "./resend.service.js";

/**
 * Standalone consumer process for notification email (Fase 2 slice 4), the
 * third sibling of `worker:catalog` and `worker:reco`. Run with
 * `pnpm --filter @coda/api worker:notifications`.
 *
 * Consumes the `notification-email` queue: each job carries only a
 * `notificationId` (design Decision 8), and
 * {@link createNotificationEmailProcessor} re-reads the row, composes the
 * escaped HTML and hands it to {@link ResendService} with a per-notification
 * idempotency key. Retry policy lives on the job options
 * (`NOTIFICATION_EMAIL_JOB_OPTIONS`); permanent Resend rejections become
 * `UnrecoverableError`s inside the processor.
 *
 * Environment:
 *  - `REDIS_URL` — the queue's Redis.
 *  - `APP_URL` — REQUIRED. Every deep link in the email is built off it, so
 *    the process exits with code 1 instead of mailing broken links.
 *  - `RESEND_API_KEY` / `RESEND_FROM_EMAIL` — optional. With either one unset,
 *    `ResendService` is disabled and every job completes as a logged no-op
 *    (in-app notifications are unaffected), so the worker is safe to run in
 *    dev and CI with neither configured.
 *
 * Running this process is optional: without it, in-app notifications work at
 * full fidelity and email jobs simply wait in Redis until a worker starts.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger("NotificationEmailWorker");
  const app = await NestFactory.createApplicationContext(AppModule);
  const config = app.get(ConfigService);

  const appUrl = config.get<string>(APP_URL_ENV);
  if (!appUrl) {
    logger.error(
      `${APP_URL_ENV} is not configured — notification emails cannot build links. ` +
        "The notification email worker was not started.",
    );
    await app.close();
    process.exitCode = 1;
    return;
  }

  // Worker connections need `maxRetriesPerRequest: null` (BullMQ requirement),
  // which is `createBullConnection`'s default.
  const connection = createBullConnection(config.get<string>(REDIS_URL_ENV));
  const processNotificationEmail = createNotificationEmailProcessor({
    prisma: app.get(PrismaService),
    resend: app.get(ResendService),
    appUrl,
    logger,
  });

  const worker = new Worker<NotificationEmailJobData>(
    NOTIFICATION_EMAIL_QUEUE,
    async (job) => processNotificationEmail(job.data),
    { connection },
  );

  worker.on("failed", (job, err) => {
    logger.error(`Notification email job ${job?.id} failed: ${err.message}`);
  });

  logger.log("Notification email worker running (notification-email). Ctrl-C to stop.");

  const shutdown = async (): Promise<void> => {
    logger.log("Shutting down notification email worker...");
    await worker.close();
    await connection.quit();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void bootstrap();
