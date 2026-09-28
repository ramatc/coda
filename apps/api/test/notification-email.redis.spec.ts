import { randomUUID } from "node:crypto";
import type { ConfigService } from "@nestjs/config";
import { Queue, type JobType } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import { createBullProducerConnection } from "../src/catalog-import/catalog-redis.js";
import {
  NotificationEmailQueue,
  type NotificationEmailJobData,
} from "../src/notifications/notification-email.queue.js";
import {
  NOTIFICATION_EMAIL_JOB_NAME,
  NOTIFICATION_EMAIL_JOB_OPTIONS,
  NOTIFICATION_EMAIL_QUEUE,
  REDIS_URL_ENV,
  notificationEmailJobId,
} from "../src/notifications/notifications.constants.js";
import { INTEGRATION_ENABLED, INTEGRATION_ENV } from "./integration.js";

/**
 * Real-Redis enqueue receipt for the notification email producer (tasks
 * 10.1/10.2). `notification-email.queue.spec.ts` pins the same contract over a
 * fake `Queue`; this file proves the job actually lands in Redis with the
 * deterministic id and the retry options BullMQ will honour.
 *
 * OPT-IN, same switch as the Postgres spec (see `./integration.ts`):
 *
 *   docker compose up -d redis
 *   # PowerShell: $env:CODA_INTEGRATION="1"; pnpm --filter @coda/api exec vitest run test/notification-email.redis.spec.ts
 *   # bash:       CODA_INTEGRATION=1 pnpm --filter @coda/api exec vitest run test/notification-email.redis.spec.ts
 *
 * No email can be sent: the enqueued id is a random UUID with no notification
 * row, so even a `worker:notifications` process running against the same
 * Redis would find nothing and complete without calling Resend. The job is
 * removed in `afterAll` either way.
 */
/** Every state a just-enqueued job can be in, even with a worker attached. */
const JOB_STATES: JobType[] = ["waiting", "delayed", "active", "completed", "failed"];

describe.skipIf(!INTEGRATION_ENABLED)(
  `NotificationEmailQueue (real Redis; set ${INTEGRATION_ENV}=1 to run)`,
  () => {
    const redisUrl = process.env[REDIS_URL_ENV];
    const config = {
      get: (key: string) => (key === REDIS_URL_ENV ? redisUrl : undefined),
    } as unknown as ConfigService;

    const producer = new NotificationEmailQueue(config);
    const readerConnection = createBullProducerConnection(redisUrl);
    const reader = new Queue<NotificationEmailJobData>(NOTIFICATION_EMAIL_QUEUE, {
      connection: readerConnection,
    });
    const notificationId = randomUUID();
    const jobId = notificationEmailJobId(notificationId);

    // Removes by PAYLOAD, not by the expected id, so a regression that breaks
    // the id contract still leaves no stray job behind in the shared Redis.
    afterAll(async () => {
      try {
        const jobs = await reader.getJobs(JOB_STATES);
        await Promise.all(
          jobs
            .filter((job) => job.data.notificationId === notificationId)
            .map((job) => job.remove()),
        );
      } finally {
        await reader.close();
        await readerConnection.quit();
        await producer.onModuleDestroy();
      }
    });

    it("stores the job under its deterministic id with the thin payload and retry options", async () => {
      await producer.enqueue(notificationId);

      const job = await reader.getJob(jobId);

      expect(job?.id).toBe(`notification-email-${notificationId}`);
      expect(job?.name).toBe(NOTIFICATION_EMAIL_JOB_NAME);
      expect(job?.data).toEqual({ notificationId });
      expect(job?.opts).toMatchObject({
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      });
      expect(job?.opts).toMatchObject(NOTIFICATION_EMAIL_JOB_OPTIONS);
    });

    it("deduplicates a replayed enqueue for the same notification", async () => {
      await producer.enqueue(notificationId);

      const job = await reader.getJob(jobId);
      const sameIdJobs = (await reader.getJobs(JOB_STATES)).filter((candidate) => candidate.id === jobId);

      expect(sameIdJobs).toHaveLength(1);
      expect(job?.data).toEqual({ notificationId });
    });
  },
);
