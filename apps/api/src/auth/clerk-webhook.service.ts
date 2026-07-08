import { Injectable, Logger } from "@nestjs/common";
import type { UserJSON, WebhookEvent } from "@clerk/backend";
import { PrismaService } from "../prisma/prisma.service.js";

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
        await this.syncUser(event.data);
        break;
      case "user.deleted":
        if (event.data.id) {
          await this.deleteUser(event.data.id);
        }
        break;
      default:
        this.logger.debug(`Ignoring unhandled Clerk webhook event: ${event.type}`);
    }
  }

  private async syncUser(data: UserJSON): Promise<void> {
    const clerkUserId = data.id;
    const email = this.resolvePrimaryEmail(data);
    // Profile.username is unique + NOT NULL. Fall back to the Clerk user id
    // (globally unique) when the user has no username yet; the real username is
    // owned by the profile-edit flow (PR3), so updates never overwrite it here.
    const username = data.username ?? clerkUserId;
    const displayName =
      [data.first_name, data.last_name].filter(Boolean).join(" ").trim() ||
      username;
    const avatarUrl = data.image_url || null;

    await this.prisma.client.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { clerkUserId },
        create: { clerkUserId, email },
        update: { email },
      });

      await tx.profile.upsert({
        where: { userId: user.id },
        create: { userId: user.id, username, displayName, avatarUrl },
        update: { displayName, avatarUrl },
      });
    });

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

  private resolvePrimaryEmail(data: UserJSON): string {
    const primary = data.email_addresses.find(
      (address) => address.id === data.primary_email_address_id,
    );
    const email =
      primary?.email_address ?? data.email_addresses[0]?.email_address;
    if (!email) {
      throw new Error(`Clerk user ${data.id} has no email address to sync`);
    }
    return email;
  }
}
