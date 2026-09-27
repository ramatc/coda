import type { ConfigService } from "@nestjs/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface AddedJob {
  name: string;
  data: unknown;
  opts: {
    jobId?: string;
    attempts?: number;
    backoff?: unknown;
    removeOnComplete?: unknown;
    removeOnFail?: unknown;
  };
}

const registry = new Map<string, FakeQueue>();
const createConnection = vi.fn();
const quit = vi.fn().mockResolvedValue("OK");

class FakeQueue {
  readonly added: AddedJob[] = [];
  readonly getJob = vi.fn();
  readonly close = vi.fn().mockResolvedValue(undefined);

  constructor(private readonly name: string) {
    registry.set(name, this);
  }

  async add(name: string, data: unknown, opts: AddedJob["opts"]): Promise<void> {
    this.added.push({ name, data, opts });
  }
}

vi.mock("bullmq", () => ({ Queue: FakeQueue }));
vi.mock("../src/catalog-import/catalog-redis.js", () => ({
  createBullProducerConnection: createConnection,
}));

const {
  NOTIFICATION_EMAIL_JOB_NAME,
  NOTIFICATION_EMAIL_JOB_OPTIONS,
  NOTIFICATION_EMAIL_QUEUE,
  REDIS_URL_ENV,
  notificationEmailJobId,
} = await import("../src/notifications/notifications.constants.js");
const { NotificationEmailQueue } = await import(
  "../src/notifications/notification-email.queue.js"
);

function config(redisUrl = "redis://queue.test:6379"): ConfigService {
  return {
    get: vi.fn((key: string) => (key === REDIS_URL_ENV ? redisUrl : undefined)),
  } as unknown as ConfigService;
}

describe("NotificationEmailQueue", () => {
  beforeEach(() => {
    registry.clear();
    createConnection.mockReset();
    quit.mockClear();
    createConnection.mockReturnValue({ quit });
  });

  it("keeps Redis and BullMQ lazy until the first enqueue", () => {
    new NotificationEmailQueue(config());

    expect(createConnection).not.toHaveBeenCalled();
    expect(registry.size).toBe(0);
  });

  it("adds one deterministic notification email job with the bounded retry policy", async () => {
    const queue = new NotificationEmailQueue(config());
    const notificationId = "28a16c3e-f0ad-4c88-b74f-c6bc465b3bb6";

    await queue.enqueue(notificationId);

    expect(createConnection).toHaveBeenCalledOnce();
    expect(createConnection).toHaveBeenCalledWith("redis://queue.test:6379");
    expect(registry.get(NOTIFICATION_EMAIL_QUEUE)?.added).toEqual([
      {
        name: NOTIFICATION_EMAIL_JOB_NAME,
        data: { notificationId },
        opts: {
          ...NOTIFICATION_EMAIL_JOB_OPTIONS,
          jobId: "notification-email-28a16c3e-f0ad-4c88-b74f-c6bc465b3bb6",
        },
      },
    ]);
  });

  it("uses the configured attempts, backoff and bounded retention values", () => {
    expect(NOTIFICATION_EMAIL_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    });
  });

  it("uses a BullMQ-compatible deterministic job id", async () => {
    const { Job } = await vi.importActual<typeof import("bullmq")>("bullmq");
    class ValidatingJob extends Job<{ notificationId: string }> {
      validate(): void {
        this.validateOptions({ data: JSON.stringify(this.data) } as never);
      }
    }
    const keys = new Proxy<Record<string, string>>({}, {
      get: (_target, property) => String(property),
    });
    const bullQueueBoundary = {
      toKey: (key: string) => `bull:notification-email:${key}`,
      qualifiedName: "bull:notification-email",
      keys,
      client: Promise.resolve({}),
      opts: {},
      redisVersion: "7",
      databaseType: "redis",
    };
    const notificationId = "db2c4a9c-11c4-44f7-a58b-9d8f09bbc0e8";
    const jobId = notificationEmailJobId(notificationId);
    const job = new ValidatingJob(
      bullQueueBoundary as never,
      NOTIFICATION_EMAIL_JOB_NAME,
      { notificationId },
      { jobId },
      jobId,
    );

    const incompatibleJobId = `notification-email:${notificationId}`;
    const incompatibleJob = new ValidatingJob(
      bullQueueBoundary as never,
      NOTIFICATION_EMAIL_JOB_NAME,
      { notificationId },
      { jobId: incompatibleJobId },
      incompatibleJobId,
    );

    expect(() => job.validate()).not.toThrow();
    expect(() => incompatibleJob.validate()).toThrow("Custom Id cannot contain :");
    expect(jobId).toBe(`notification-email-${notificationId}`);
  });

  it("never looks up or removes an existing job before adding", async () => {
    const queue = new NotificationEmailQueue(config());
    const existingJob = {
      isFailed: vi.fn().mockResolvedValue(true),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    await queue.enqueue("60efb996-d9ca-43f4-9153-653537a581d7");

    const bullQueue = registry.get(NOTIFICATION_EMAIL_QUEUE);
    bullQueue?.getJob.mockResolvedValue(existingJob);
    await queue.enqueue("bf0cdca0-738b-447b-a80c-fb228876dce5");

    expect(bullQueue?.getJob).not.toHaveBeenCalled();
    expect(existingJob.remove).not.toHaveBeenCalled();
  });

  it("closes only resources that were lazily created", async () => {
    const unusedQueue = new NotificationEmailQueue(config());
    await unusedQueue.onModuleDestroy();
    expect(quit).not.toHaveBeenCalled();

    const usedQueue = new NotificationEmailQueue(config());
    await usedQueue.enqueue("4a711ced-38c7-485f-8547-7c07af4f68f0");
    const bullQueue = registry.get(NOTIFICATION_EMAIL_QUEUE);
    await usedQueue.onModuleDestroy();

    expect(bullQueue?.close).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it("still quits the Redis connection when closing the queue rejects, then surfaces the close error", async () => {
    const queue = new NotificationEmailQueue(config());
    await queue.enqueue("0d7c5a8e-5f0b-4a57-9d8e-3c2b1a0f9e71");
    const closeError = new Error("queue close failed");
    registry.get(NOTIFICATION_EMAIL_QUEUE)?.close.mockRejectedValueOnce(closeError);

    await expect(queue.onModuleDestroy()).rejects.toBe(closeError);

    expect(quit).toHaveBeenCalledOnce();
  });
});
