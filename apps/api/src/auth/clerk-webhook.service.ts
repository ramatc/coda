import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { UserJSON, WebhookEvent } from "@clerk/backend";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  extractUniqueConstraintField,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";

/**
 * Syncs Clerk user lifecycle events into local `User` + `Profile` records
 * (Decision #2). Keeps local rows authoritative for FKs before a user's first
 * API call.
 *
 * Idempotency: Clerk delivers webhooks at-least-once, so every write is an
 * `upsert` keyed on a unique column (`User.clerkUserId`, `Profile.userId`).
 * Replaying the same event therefore never creates a duplicate row, and delete
 * uses `deleteMany` so a repeated `user.deleted` is a no-op rather than an
 * error.
 */
@Injectable()
export class ClerkWebhookService {
  private readonly logger = new Logger(ClerkWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  async handleEvent(event: WebhookEvent): Promise<void> {
    switch (event.type) {
      case "user.created":
      case "user.updated":
        await this.syncUser(event.data, event.type);
        break;
      case "user.deleted":
        if (event.data.id) {
          await this.deleteUser(event.data.id);
        } else {
          this.logger.warn("Ignoring user.deleted event with no user id");
        }
        break;
      default:
        this.logger.debug(`Ignoring unhandled Clerk webhook event: ${event.type}`);
    }
  }

  private async syncUser(data: UserJSON, eventType: string): Promise<void> {
    const clerkUserId = data.id;
    const email = this.resolvePrimaryEmail(data, eventType);
    // Profile.username is unique + NOT NULL. Fall back to the Clerk user id
    // (globally unique) when the user has no username yet; the real username is
    // owned by the profile-edit flow (PR3), so updates never overwrite it here.
    // displayName gets the same treatment: it's only Clerk-authoritative at
    // creation time, so it's never touched by an `update` either — otherwise a
    // user's local customization (once PR3 ships) would be silently clobbered
    // by the next Clerk webhook replay.
    // Lowercased for the same reason profile.service.ts canonicalizes
    // usernames on the profile-edit path: two Clerk usernames differing only
    // in case must not become distinct public `/u/[username]` profiles.
    const username = (data.username ?? clerkUserId).toLowerCase();
    const displayName =
      [data.first_name, data.last_name].filter(Boolean).join(" ").trim() ||
      username;
    const avatarUrl = data.image_url || null;

    try {
      await this.prisma.client.$transaction(async (tx) => {
        const user = await tx.user.upsert({
          where: { clerkUserId },
          create: { clerkUserId, email },
          update: { email },
        });

        await tx.profile.upsert({
          where: { userId: user.id },
          create: { userId: user.id, username, displayName, avatarUrl },
          update: { avatarUrl },
        });
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        const conflictField = extractUniqueConstraintField(err);

        if (conflictField === "username") {
          this.logger.error(
            `Clerk user ${clerkUserId} (event ${eventType}) could not be synced: ` +
              `username ${username} is already owned by a different local Profile`,
          );
          throw new ConflictException(
            `Username ${username} is already in use by another account`,
          );
        }

        if (conflictField === "email") {
          this.logger.error(
            `Clerk user ${clerkUserId} (event ${eventType}) could not be synced: ` +
              `email ${email} is already owned by a different local User`,
          );
          throw new ConflictException(
            `Email ${email} is already in use by another account`,
          );
        }

        this.logger.error(
          `Clerk user ${clerkUserId} (event ${eventType}) could not be synced: ` +
            `unique constraint conflict on field "${conflictField ?? "unknown"}"`,
        );
        throw new ConflictException(
          "This account could not be synced because of a conflicting field",
        );
      }
      throw err;
    }

    this.logger.log(`Synced Clerk user ${clerkUserId}`);
  }

  private async deleteUser(clerkUserId: string): Promise<void> {
    // Profile rows cascade via the schema's `onDelete: Cascade` FK.
    const { count } = await this.prisma.client.user.deleteMany({
      where: { clerkUserId },
    });
    this.logger.log(
      `Deleted ${count} local user(s) for Clerk id ${clerkUserId}`,
    );
  }

  private resolvePrimaryEmail(data: UserJSON, eventType: string): string {
    const primary = data.email_addresses.find(
      (address) => address.id === data.primary_email_address_id,
    );
    const email =
      primary?.email_address ?? data.email_addresses[0]?.email_address;
    if (!email) {
      this.logger.error(
        `Clerk user ${data.id} (event ${eventType}) has no email address to ` +
          "sync — likely a phone-only sign-up config",
      );
      throw new UnprocessableEntityException(
        `Clerk user ${data.id} has no email address to sync`,
      );
    }
    return email;
  }
}
