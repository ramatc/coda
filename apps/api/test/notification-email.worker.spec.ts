import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationType } from "@coda/db";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  APP_URL_ENV,
  NOTIFICATION_EMAIL_QUEUE,
  REDIS_URL_ENV,
} from "../src/notifications/notifications.constants.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { ResendService } from "../src/notifications/resend.service.js";

/**
 * `notification-email.worker.ts` is a standalone bootstrap script with no
 * exported units, exactly like `catalog-worker.ts`. Same harness as
 * `catalog-worker.spec.ts`: `bullmq`'s `Worker` is mocked to CAPTURE the
 * processor and event handlers passed to it, the Nest application context is
 * a fake provider map, and `process.on` / `process.exit` are spied so the
 * signal handlers can be driven without touching the test runner's process.
 * No Redis, Postgres or Resend is involved.
 *
 * The job logic itself (row lookup, composition, escaping, retry
 * classification) is pinned by `notification-email.processor.spec.ts`; this
 * spec pins only the process wiring around it.
 */

interface FakeJob<T> {
  data: T;
  id?: string;
}

const quitMock = vi.fn().mockResolvedValue("OK");
const createBullConnectionMock = vi.fn((..._args: unknown[]) => ({ quit: quitMock }));

vi.mock("../src/catalog-import/catalog-redis.js", () => ({
  createBullConnection: (...args: unknown[]) => createBullConnectionMock(...args),
}));

const workerInstances: Array<{
  queueName: string;
  processor: (job: FakeJob<{ notificationId: string }>) => Promise<unknown>;
  options: { connection?: unknown } | undefined;
  handlers: Record<string, (...args: unknown[]) => unknown>;
  close: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("bullmq", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bullmq")>();
  class FakeWorker {
    handlers: Record<string, (...args: unknown[]) => unknown> = {};
    close = vi.fn().mockResolvedValue(undefined);

    constructor(
      queueName: string,
      processor: (job: FakeJob<{ notificationId: string }>) => Promise<unknown>,
      options?: { connection?: unknown },
    ) {
      workerInstances.push({
        queueName,
        processor,
        options,
        handlers: this.handlers,
        close: this.close,
      });
    }
    on(event: string, handler: (...args: unknown[]) => unknown): this {
      this.handlers[event] = handler;
      return this;
    }
  }
  // The processor module imports `UnrecoverableError`; keep the real one.
  return { ...actual, Worker: FakeWorker };
});

const createApplicationContextMock = vi.fn();
vi.mock("@nestjs/core", () => ({
  NestFactory: { createApplicationContext: createApplicationContextMock },
}));

vi.mock("../src/app.module.js", () => ({ AppModule: class {} }));

const NOTIFICATION_ID = "5b8c2f1e-7a4d-4c3b-9e2f-1a0b9c8d7e6f";

const fakePrisma = {
  client: {
    notification: {
      findUnique: vi.fn(),
    },
  },
};
const fakeResend = { send: vi.fn() };
const signalHandlers = new Map<string, () => void>();

/**
 * Fake Nest application context. Providers are keyed by class NAME, not class
 * identity: `bootWorker` calls `vi.resetModules()`, so the worker's freshly
 * imported `PrismaService` / `ResendService` are different class objects from
 * the ones this spec imported statically.
 */
function fakeApp(env: Record<string, string>) {
  const providers = new Map<string, unknown>();
  providers.set(ConfigService.name, { get: (key: string) => env[key] });
  providers.set(PrismaService.name, fakePrisma);
  providers.set(ResendService.name, fakeResend);
  return {
    get: (token: { name: string }) => providers.get(token.name),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

/** Imports the worker entrypoint fresh and lets its `void bootstrap()` settle. */
async function bootWorker(app: ReturnType<typeof fakeApp>): Promise<void> {
  createApplicationContextMock.mockResolvedValue(app);
  vi.resetModules();
  await import("../src/notifications/notification-email.worker.js");
  await new Promise((resolve) => setImmediate(resolve));
}

describe("notification-email worker bootstrap", () => {
  const env = {
    [APP_URL_ENV]: "https://coda.test/",
    [REDIS_URL_ENV]: "redis://queue.test:6379",
  };
  let app: ReturnType<typeof fakeApp>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      handler: () => void,
    ) => {
      signalHandlers.set(event, handler);
      return process;
    }) as typeof process.on);
    vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    app = fakeApp(env);
    await bootWorker(app);
  });

  beforeEach(() => {
    fakePrisma.client.notification.findUnique.mockReset();
    fakeResend.send.mockReset();
    errorSpy = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("consumes the notification-email queue over one dedicated Worker connection built from REDIS_URL", () => {
    expect(workerInstances).toHaveLength(1);
    expect(workerInstances[0]!.queueName).toBe(NOTIFICATION_EMAIL_QUEUE);
    expect(createBullConnectionMock).toHaveBeenCalledExactlyOnceWith(
      "redis://queue.test:6379",
    );
    // `createBullConnection` defaults `maxRetriesPerRequest` to `null`, which
    // BullMQ requires for a Worker; the worker must not override it.
    expect(createBullConnectionMock.mock.calls[0]).toHaveLength(1);
    expect(workerInstances[0]!.options?.connection).toBe(
      createBullConnectionMock.mock.results[0]?.value,
    );
  });

  it("wires the processor to the app's Prisma, Resend and APP_URL", async () => {
    fakePrisma.client.notification.findUnique.mockResolvedValue({
      type: NotificationType.FOLLOW,
      recipient: { email: "recipient@example.com" },
      actor: { profile: { username: "ana", displayName: "Ana" } },
      reviewComment: null,
    });
    fakeResend.send.mockResolvedValue({ status: "sent", id: "email-1" });

    await workerInstances[0]!.processor({ data: { notificationId: NOTIFICATION_ID } });

    expect(fakePrisma.client.notification.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: NOTIFICATION_ID } }),
    );
    expect(fakeResend.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: "recipient@example.com",
        html: expect.stringContaining('href="https://coda.test/u/ana"'),
      }),
      { idempotencyKey: `notification-email-${NOTIFICATION_ID}` },
    );
  });

  it("logs a failed job with its id and error message", () => {
    workerInstances[0]!.handlers.failed!(
      { id: `notification-email-${NOTIFICATION_ID}` },
      new Error("Resend send failed: 503 upstream down"),
    );

    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      `Notification email job notification-email-${NOTIFICATION_ID} failed: ` +
        "Resend send failed: 503 upstream down",
    );
  });

  it.each(["SIGINT", "SIGTERM"])(
    "on %s closes the Worker, then its Redis connection, then the app, and exits 0",
    async (signal) => {
      const order: string[] = [];
      workerInstances[0]!.close.mockImplementationOnce(async () => {
        order.push("worker.close");
      });
      quitMock.mockImplementationOnce(async () => {
        order.push("connection.quit");
        return "OK";
      });
      app.close.mockImplementationOnce(async () => {
        order.push("app.close");
      });

      signalHandlers.get(signal)!();
      await new Promise((resolve) => setImmediate(resolve));

      expect(order).toEqual(["worker.close", "connection.quit", "app.close"]);
      expect(exitSpy).toHaveBeenCalledExactlyOnceWith(0);
    },
  );

  it("refuses to start without APP_URL: no Worker, an error naming the variable, a non-zero exit code", async () => {
    const workersBefore = workerInstances.length;
    const previousExitCode = process.exitCode;
    const noAppUrl = fakeApp({ [REDIS_URL_ENV]: "redis://queue.test:6379" });

    try {
      await bootWorker(noAppUrl);

      expect(workerInstances).toHaveLength(workersBefore);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(APP_URL_ENV));
      expect(noAppUrl.close).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});
