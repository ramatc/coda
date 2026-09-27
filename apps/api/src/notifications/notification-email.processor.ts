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
  logger: Pick<Logger, "debug">;
}

/**
 * Slices `value` to at most `maxLength` UTF-16 code units, but never leaves a
 * lone high surrogate (`0xD800`–`0xDBFF`) trailing the result. `String.slice`
 * cuts by code unit and can land exactly between a surrogate pair — e.g. an
 * emoji straddling the boundary — which would hand the caller one half of a
 * character. Dropping that trailing high surrogate keeps the excerpt valid
 * UTF-16 at the cost of it sometimes being one code unit short of `maxLength`.
 */
function sliceExcerpt(value: string, maxLength: number): string {
  const sliced = value.slice(0, maxLength);
  const lastCharCode = sliced.charCodeAt(sliced.length - 1);
  const isTrailingHighSurrogate = lastCharCode >= 0xd800 && lastCharCode <= 0xdbff;
  return isTrailingHighSurrogate ? sliced.slice(0, -1) : sliced;
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

  if (notification.type === NotificationType.COMMENT) {
    const comment = notification.reviewComment;
    const href = comment ? `${appUrl}/reviews/${comment.reviewId}` : appUrl;
    const excerpt = escapeHtml(
      comment ? sliceExcerpt(comment.body, COMMENT_EXCERPT_LENGTH) : "",
    );
    return {
      to: notification.recipient.email,
      subject: `${name} commented on your review`,
      html:
        `<p><strong>${displayName}</strong> commented on your review:</p>` +
        `<blockquote>${excerpt}</blockquote>` +
        `<p><a href="${href}">View review</a></p>`,
    };
  }

  // Exhaustiveness guard: a new `NotificationType` member with no branch
  // above fails typecheck here (`notification.type` would no longer be
  // assignable to `never`) instead of silently falling through to whichever
  // branch happened to be last, which is what the previous implicit
  // COMMENT-fallthrough did.
  const unreachable: never = notification.type;
  throw new Error(`Unhandled notification type: ${unreachable as string}`);
}
