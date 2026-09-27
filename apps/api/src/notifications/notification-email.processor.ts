import { NotificationType } from "@coda/db";
import type { Logger } from "@nestjs/common";
import { UnrecoverableError } from "bullmq";
import type { PrismaService } from "../prisma/prisma.service.js";
import {
  COMMENT_EXCERPT_LENGTH,
  RESEND_INVALID_IDEMPOTENT_REQUEST_CODE,
  RETRYABLE_RESEND_4XX_STATUSES,
  notificationEmailIdempotencyKey,
} from "./notifications.constants.js";
import type { NotificationEmailJobData } from "./notification-email.queue.js";
import {
  ResendSendError,
  type ResendEmail,
  type ResendService,
} from "./resend.service.js";

const EMAIL_NOTIFICATION_SELECT = {
  type: true,
  recipient: { select: { email: true } },
  actor: {
    select: { profile: { select: { username: true, displayName: true } } },
  },
  reviewComment: { select: { reviewId: true, body: true } },
} as const;

interface EmailNotificationRow {
  type: NotificationType;
  recipient: { email: string };
  actor: { profile: { username: string; displayName: string } | null };
  reviewComment: { reviewId: string; body: string } | null;
}

export interface NotificationEmailProcessorDependencies {
  prisma: PrismaService;
  resend: ResendService;
  appUrl: string;
  logger: Pick<Logger, "debug" | "warn">;
}

/** Escapes an untrusted text fragment before interpolation into email HTML. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Builds the processor used by the standalone BullMQ worker. Dependencies are
 * explicit so the complete job path is testable without Redis, Postgres or a
 * live Resend account.
 */
export function createNotificationEmailProcessor({
  prisma,
  resend,
  appUrl,
  logger,
}: NotificationEmailProcessorDependencies) {
  const baseUrl = appUrl.replace(/\/+$/, "");

  return async ({ notificationId }: NotificationEmailJobData): Promise<void> => {
    const notification = (await prisma.client.notification.findUnique({
      where: { id: notificationId },
      select: EMAIL_NOTIFICATION_SELECT,
    })) as EmailNotificationRow | null;

    if (!notification) {
      logger.debug(`Notification ${notificationId} no longer exists; skipping email.`);
      return;
    }

    const email = composeEmail(notification, baseUrl);
    try {
      const result = await resend.send(email, {
        idempotencyKey: notificationEmailIdempotencyKey(notificationId),
      });
      if (result.status === "skipped") {
        logger.debug(
          `Notification email ${notificationId} skipped because Resend is disabled.`,
        );
      }
    } catch (err) {
      if (err instanceof ResendSendError) {
        // Checked before the retryable-status set: a 409 is normally
        // transient (`concurrent_idempotent_requests`), but this exact code
        // means the idempotency key was reused with a DIFFERENT payload,
        // which is permanent — retrying only ever reproduces it.
        const isPermanentIdempotencyConflict =
          err.status === 409 && err.code === RESEND_INVALID_IDEMPOTENT_REQUEST_CODE;
        const isPermanent4xx =
          err.status >= 400 &&
          err.status < 500 &&
          !RETRYABLE_RESEND_4XX_STATUSES.has(err.status);
        if (isPermanentIdempotencyConflict || isPermanent4xx) {
          throw new UnrecoverableError(err.message);
        }
      }
      throw err;
    }
  };
}

/**
 * The actor's name as single-line plain text, for the subject. `displayName`
 * is only trimmed and length-bounded at write time, so control characters
 * (CR/LF, tabs, bells) are collapsed to spaces here; a name that is nothing
 * but control characters falls back to "Someone". Not HTML-escaped — the
 * subject is plain text, and the body escapes this value separately.
 */
function actorName(profile: EmailNotificationRow["actor"]["profile"]): string {
  const name = (profile?.displayName ?? "")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name || "Someone";
}

function composeEmail(notification: EmailNotificationRow, appUrl: string): ResendEmail {
  const profile = notification.actor.profile;
  const name = actorName(profile);
  const displayName = escapeHtml(name);

  if (notification.type === NotificationType.FOLLOW) {
    const username = profile ? escapeHtml(profile.username) : "";
    const href = profile ? `${appUrl}/u/${username}` : appUrl;
    return {
      to: notification.recipient.email,
      subject: `${name} followed you on Coda`,
      html:
        `<p><strong>${displayName}</strong>` +
        `${profile ? ` (@${username})` : ""} followed you on Coda.</p>` +
        `<p><a href="${href}">View profile</a></p>`,
    };
  }

  const comment = notification.reviewComment;
  const href = comment ? `${appUrl}/reviews/${comment.reviewId}` : appUrl;
  const excerpt = escapeHtml(comment?.body.slice(0, COMMENT_EXCERPT_LENGTH) ?? "");
  return {
    to: notification.recipient.email,
    subject: `${name} commented on your review`,
    html:
      `<p><strong>${displayName}</strong> commented on your review:</p>` +
      `<blockquote>${excerpt}</blockquote>` +
      `<p><a href="${href}">View review</a></p>`,
  };
}
