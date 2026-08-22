import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  RESEND_API_KEY_ENV,
  RESEND_FROM_ENV,
} from "./notifications.constants.js";

/** Resend's transactional-send endpoint. */
const RESEND_SEND_URL = "https://api.resend.com/emails";

/** The message to hand to Resend. `html` is treated as an opaque string. */
export interface ResendEmail {
  to: string;
  subject: string;
  /**
   * Finished HTML. **Every user-controlled value interpolated into this string
   * MUST already be HTML-escaped by the caller.** Escaping happens at
   * composition time (the email worker), because that is the only layer that
   * still knows which fragments came from a display name, a username or a
   * comment body — by the time it reaches here it is one indivisible string.
   */
  html: string;
}

/** Outcome of a send: delivered to Resend, or skipped because it is disabled. */
export type ResendSendResult =
  | { status: "sent"; id: string }
  | { status: "skipped"; reason: "disabled" };

/**
 * A non-OK response from Resend, carrying the HTTP status so the caller can
 * classify it without parsing a message. The email worker (Phase 12) turns a
 * 4xx other than 429 into BullMQ's `UnrecoverableError` — retrying a permanent
 * 422 three times burns quota for a guaranteed failure — and rethrows
 * 429/5xx/network as ordinary errors so the queue's backoff applies
 * (design Decision 10).
 */
export class ResendSendError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Resend send failed: ${status} ${detail}`);
    this.name = "ResendSendError";
    this.status = status;
  }
}

/**
 * Thin Resend client for notification email (Fase 2 slice 4).
 *
 * Talks to Resend's REST API over the global `fetch` rather than adding the
 * `resend` npm package — the same call already made for {@link MeiliService},
 * `SpotifyClient` and `MusicBrainzClient`. It keeps the dependency surface
 * small and makes the whole thing unit-testable against a stubbed `fetch` with
 * no live account.
 *
 * Configuration is read ONCE at construction and constructing performs NO
 * network I/O, so importing `NotificationsModule` into `AppModule` never
 * touches Resend at boot and the full-AppModule e2e suite stays offline —
 * identical posture to {@link MeiliService}.
 *
 * **No-op fallback, and it never throws.** With {@link RESEND_API_KEY_ENV}
 * (or {@link RESEND_FROM_ENV}) missing the client is disabled and
 * {@link ResendService.send} returns `{ status: "skipped" }`. Throwing instead
 * would burn all three BullMQ attempts and dump every dev notification into the
 * failed set, for a machine that was never going to send mail. One
 * `logger.warn` at construction is what keeps that from silently masking a
 * production misconfiguration.
 */
@Injectable()
export class ResendService {
  private readonly logger = new Logger(ResendService.name);
  private readonly apiKey: string | undefined;
  private readonly from: string | undefined;
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>(RESEND_API_KEY_ENV);
    this.from = config.get<string>(RESEND_FROM_ENV);
    this.enabled = Boolean(this.apiKey) && Boolean(this.from);

    if (!this.enabled) {
      const missing = [
        this.apiKey ? undefined : RESEND_API_KEY_ENV,
        this.from ? undefined : RESEND_FROM_ENV,
      ].filter((name): name is string => name !== undefined);
      this.logger.warn(
        `Email delivery is disabled: ${missing.join(", ")} not configured. ` +
          `Notification emails will be skipped; in-app notifications are unaffected.`,
      );
    }
  }

  /**
   * Sends one email. Resolves with `{ status: "skipped" }` when the client is
   * disabled (never a throw, never a `fetch`), and throws
   * {@link ResendSendError} on any non-OK response so the caller can decide
   * whether it is worth retrying.
   */
  async send(email: ResendEmail): Promise<ResendSendResult> {
    if (!this.enabled) {
      this.logger.debug(
        `Skipping notification email to ${email.to} (Resend disabled).`,
      );
      return { status: "skipped", reason: "disabled" };
    }

    const response = await fetch(RESEND_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new ResendSendError(response.status, detail);
    }

    const body = (await response.json().catch(() => undefined)) as
      | { id?: string }
      | undefined;
    return { status: "sent", id: body?.id ?? "" };
  }
}
