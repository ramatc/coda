import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { createBullProducerConnection } from "../catalog-import/catalog-redis.js";
import {
  NOTIFICATION_EMAIL_JOB_NAME,
  NOTIFICATION_EMAIL_JOB_OPTIONS,
  NOTIFICATION_EMAIL_QUEUE,
  REDIS_URL_ENV,
  notificationEmailJobId,
} from "./notifications.constants.js";

/** Thin payload resolved to current notification data by the worker. */
export interface NotificationEmailJobData {
  notificationId: string;
}

/**
 * BullMQ producer for immediate notification email delivery.
 *
 * Queue and Redis construction stay lazy so merely bootstrapping the API never
 * opens an infrastructure socket. The producer uses the bounded-retry Redis
 * connection because enqueue is reached from an HTTP request path.
 *
 * Unlike search and recommendation jobs, this producer intentionally does NOT
 * look up and remove a failed or completed job before adding. Their ids use
 * stable entity keys that may be enqueued throughout an entity's lifetime;
 * this id uses a freshly minted notification UUID that is enqueued once. A
 * plain add therefore provides retry deduplication without blocking a future
 * legitimate email for another notification.
 */
@Injectable()
export class NotificationEmailQueue implements OnModuleDestroy {
  private connection: Redis | undefined;
  private queue: Queue<NotificationEmailJobData> | undefined;

  constructor(private readonly config: ConfigService) {}

  async enqueue(notificationId: string): Promise<void> {
    await this.getQueue().add(
      NOTIFICATION_EMAIL_JOB_NAME,
      { notificationId },
      {
        ...NOTIFICATION_EMAIL_JOB_OPTIONS,
        jobId: notificationEmailJobId(notificationId),
      },
    );
  }

  /**
   * Releases whatever was lazily created. The Redis connection is quit in a
   * `finally` so a rejected `queue.close()` cannot leak the socket; the close
   * error still propagates so shutdown failures stay visible.
   */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.queue?.close();
    } finally {
      if (this.connection) {
        await this.connection.quit();
      }
    }
  }

  private getConnection(): Redis {
    if (!this.connection) {
      this.connection = createBullProducerConnection(
        this.config.get<string>(REDIS_URL_ENV),
      );
    }
    return this.connection;
  }

  private getQueue(): Queue<NotificationEmailJobData> {
    const queue =
      this.queue ??
      (this.queue = new Queue<NotificationEmailJobData>(NOTIFICATION_EMAIL_QUEUE, {
        connection: this.getConnection(),
      }));
    return queue;
  }
}
