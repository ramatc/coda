import {
  BadRequestException,
  Controller,
  HttpCode,
  InternalServerErrorException,
  Logger,
  Post,
  Req,
  type RawBodyRequest,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request as ExpressRequest } from "express";
import type { WebhookEvent } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { Public } from "./public.decorator.js";
import { ClerkWebhookService } from "./clerk-webhook.service.js";

/**
 * Clerk webhook receiver (Decision #2). Public because it authenticates via a
 * Standard Webhooks / svix signature over the RAW request body, not a Clerk
 * session token — a webhook delivery has no user session.
 *
 * The raw body is required for signature verification, so the app is booted
 * with `rawBody: true` (see `main.ts`) and the buffer is read from
 * `req.rawBody`. A Fetch `Request` is reconstructed for `verifyWebhook`, which
 * expects the Web platform request type.
 */
@Public()
@Controller("webhooks/clerk")
export class ClerkWebhookController {
  private readonly logger = new Logger(ClerkWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly webhookService: ClerkWebhookService,
  ) {}

  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<ExpressRequest>,
  ): Promise<{ received: true }> {
    const signingSecret = this.config.get<string>("CLERK_WEBHOOK_SECRET");
    if (!signingSecret) {
      this.logger.error("CLERK_WEBHOOK_SECRET is not configured");
      throw new InternalServerErrorException("Webhook not configured");
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
      throw new BadRequestException("Missing raw request body");
    }

    let event: WebhookEvent;
    try {
      event = await verifyWebhook(this.toFetchRequest(req, rawBody), {
        signingSecret,
      });
    } catch (err) {
      this.logger.warn(
        `Clerk webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException("Invalid webhook signature");
    }

    await this.webhookService.handleEvent(event);
    return { received: true };
  }

  private toFetchRequest(
    req: RawBodyRequest<ExpressRequest>,
    rawBody: Buffer,
  ): Request {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        headers.set(key, value.join(","));
      } else if (typeof value === "string") {
        headers.set(key, value);
      }
    }
    return new Request("https://coda.local/webhooks/clerk", {
      method: "POST",
      headers,
      body: rawBody,
    });
  }
}
