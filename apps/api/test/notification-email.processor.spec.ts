import { NotificationType } from "@coda/db";
import { UnrecoverableError } from "bullmq";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNotificationEmailProcessor,
  type NotificationEmailProcessorDependencies,
} from "../src/notifications/notification-email.processor.js";
import { ResendSendError } from "../src/notifications/resend.service.js";

const APP_URL = "https://coda.test";
const NOTIFICATION_ID = "11111111-1111-4111-8111-111111111111";
const REVIEW_ID = "22222222-2222-4222-8222-222222222222";

interface ProcessorRow {
  type: NotificationType;
  recipient: { email: string };
  actor: { profile: { username: string; displayName: string } | null };
  reviewComment: { reviewId: string; body: string } | null;
}

function followRow(
  profile: ProcessorRow["actor"]["profile"] = {
    username: "ana",
    displayName: "Ana Torres",
  },
): ProcessorRow {
  return {
    type: NotificationType.FOLLOW,
    recipient: { email: "recipient@example.com" },
    actor: { profile },
    reviewComment: null,
  };
}

function commentRow(body = "A wonderful review."): ProcessorRow {
  return {
    type: NotificationType.COMMENT,
    recipient: { email: "recipient@example.com" },
    actor: { profile: { username: "ana", displayName: "Ana Torres" } },
    reviewComment: { reviewId: REVIEW_ID, body },
  };
}

function harness(row: ProcessorRow | null = followRow()) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const send = vi.fn().mockResolvedValue({ status: "sent", id: "email-1" });
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const dependencies = {
    prisma: { client: { notification: { findUnique } } },
    resend: { send },
    appUrl: APP_URL,
    logger,
  } as unknown as NotificationEmailProcessorDependencies;
  return {
    process: createNotificationEmailProcessor(dependencies),
    findUnique,
    send,
    logger,
  };
}

describe("notification email processor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("completes without sending when the notification was cascade-deleted", async () => {
    const worker = harness(null);

    await expect(worker.process({ notificationId: NOTIFICATION_ID })).resolves.toBeUndefined();

    expect(worker.findUnique).toHaveBeenCalledWith({
      where: { id: NOTIFICATION_ID },
      select: expect.objectContaining({
        recipient: expect.any(Object),
        actor: expect.any(Object),
        reviewComment: expect.any(Object),
      }),
    });
    expect(worker.send).not.toHaveBeenCalled();
    expect(worker.logger.debug).toHaveBeenCalledWith(
      `Notification ${NOTIFICATION_ID} no longer exists; skipping email.`,
    );
  });

  it("sends a FOLLOW email linking to the actor profile", async () => {
    const worker = harness();

    await worker.process({ notificationId: NOTIFICATION_ID });

    expect(worker.send).toHaveBeenCalledExactlyOnceWith(
      {
        to: "recipient@example.com",
        subject: "Ana Torres followed you on Coda",
        html: expect.stringContaining('href="https://coda.test/u/ana"'),
      },
      { idempotencyKey: `notification-email-${NOTIFICATION_ID}` },
    );
  });

  it("derives the Resend idempotency key from the notification id, so every retry reuses it", async () => {
    const worker = harness(commentRow());
    const otherId = "33333333-3333-4333-8333-333333333333";

    await worker.process({ notificationId: NOTIFICATION_ID });
    await worker.process({ notificationId: NOTIFICATION_ID });
    await worker.process({ notificationId: otherId });

    expect(worker.send.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: `notification-email-${NOTIFICATION_ID}` },
      { idempotencyKey: `notification-email-${NOTIFICATION_ID}` },
      { idempotencyKey: `notification-email-${otherId}` },
    ]);
  });

  it("sends a COMMENT email linking to the review with a bounded excerpt", async () => {
    const body = "x".repeat(180);
    const worker = harness(commentRow(body));

    await worker.process({ notificationId: NOTIFICATION_ID });

    const email = worker.send.mock.calls[0][0] as { subject: string; html: string };
    expect(email.subject).toBe("Ana Torres commented on your review");
    expect(email.html).toContain(`href="${APP_URL}/reviews/${REVIEW_ID}"`);
    expect(email.html).toContain("x".repeat(140));
    expect(email.html).not.toContain("x".repeat(141));
  });

  it("falls back to the app root when the actor has no profile", async () => {
    const worker = harness(followRow(null));

    await worker.process({ notificationId: NOTIFICATION_ID });

    const email = worker.send.mock.calls[0][0] as { html: string };
    expect(email.html).toContain('href="https://coda.test"');
    expect(email.html).not.toContain("/u/");
  });

  it("completes without retry when Resend is disabled", async () => {
    const worker = harness();
    worker.send.mockResolvedValueOnce({ status: "skipped", reason: "disabled" });

    await expect(worker.process({ notificationId: NOTIFICATION_ID })).resolves.toBeUndefined();

    expect(worker.logger.debug).toHaveBeenCalledWith(
      `Notification email ${NOTIFICATION_ID} skipped because Resend is disabled.`,
    );
  });

  it("turns a permanent Resend 4xx into an UnrecoverableError", async () => {
    const worker = harness();
    worker.send.mockRejectedValueOnce(new ResendSendError(422, "invalid recipient"));

    await expect(worker.process({ notificationId: NOTIFICATION_ID })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it("keeps a non-retryable 4xx such as 400 unrecoverable", async () => {
    const worker = harness();
    worker.send.mockRejectedValueOnce(new ResendSendError(400, "validation_error"));

    await expect(worker.process({ notificationId: NOTIFICATION_ID })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  // 408 is a request timeout and 409 is what Resend answers while an earlier
  // attempt with the same idempotency key is still in flight
  // (`concurrent_idempotent_requests`) — both are transient, so the queue's
  // backoff must apply instead of failing the job permanently.
  it.each([408, 409, 429, 503])("leaves Resend status %i retryable", async (status) => {
    const worker = harness();
    const error = new ResendSendError(status, "temporary failure");
    worker.send.mockRejectedValueOnce(error);

    await expect(worker.process({ notificationId: NOTIFICATION_ID })).rejects.toBe(error);
  });

  it("leaves network failures retryable", async () => {
    const worker = harness();
    const error = new Error("socket closed");
    worker.send.mockRejectedValueOnce(error);

    await expect(worker.process({ notificationId: NOTIFICATION_ID })).rejects.toBe(error);
  });

  it("HTML-escapes display names, usernames and comment excerpts at composition time", async () => {
    const follow = harness(
      followRow({ username: 'a<&"\'', displayName: 'Ana <Admin> & "Boss"' }),
    );
    await follow.process({ notificationId: NOTIFICATION_ID });

    const followHtml = (follow.send.mock.calls[0][0] as { html: string }).html;
    expect(followHtml).toContain("Ana &lt;Admin&gt; &amp; &quot;Boss&quot;");
    expect(followHtml).toContain("/u/a&lt;&amp;&quot;&#39;");
    expect(followHtml).not.toContain("<Admin>");

    const comment = harness(commentRow('<script>alert("x")</script> & goodbye'));
    await comment.process({ notificationId: NOTIFICATION_ID });

    const commentHtml = (comment.send.mock.calls[0][0] as { html: string }).html;
    expect(commentHtml).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; goodbye",
    );
    expect(commentHtml).not.toContain("<script>");
  });
});
