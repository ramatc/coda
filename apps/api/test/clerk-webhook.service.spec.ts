import { beforeEach, describe, expect, it } from "vitest";
import type { WebhookEvent } from "@clerk/backend";
import { ClerkWebhookService } from "../src/auth/clerk-webhook.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

/**
 * Minimal in-memory stand-in for the Prisma client that honours real upsert
 * semantics (create-or-update keyed on a unique column) so we can prove webhook
 * idempotency deterministically without a live Postgres — matching PR1's
 * no-docker sandbox constraint. A genuine DB-backed integration run is deferred
 * to CI (see apply-progress).
 */
interface UserRow {
  id: string;
  clerkUserId: string;
  email: string;
}

interface ProfileRow {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

function createFakePrisma(): {
  service: PrismaService;
  users: Map<string, UserRow>;
  profiles: Map<string, ProfileRow>;
} {
  const users = new Map<string, UserRow>();
  const profiles = new Map<string, ProfileRow>();
  let seq = 0;

  const client = {
    async $transaction<T>(fn: (tx: typeof client) => Promise<T>): Promise<T> {
      return fn(client);
    },
    user: {
      async upsert(args: {
        where: { clerkUserId: string };
        create: { clerkUserId: string; email: string };
        update: { email: string };
      }): Promise<UserRow> {
        const existing = users.get(args.where.clerkUserId);
        if (existing) {
          existing.email = args.update.email;
          return existing;
        }
        const row: UserRow = {
          id: `local_${++seq}`,
          clerkUserId: args.create.clerkUserId,
          email: args.create.email,
        };
        users.set(row.clerkUserId, row);
        return row;
      },
      async deleteMany(args: {
        where: { clerkUserId: string };
      }): Promise<{ count: number }> {
        const user = users.get(args.where.clerkUserId);
        if (!user) {
          return { count: 0 };
        }
        users.delete(args.where.clerkUserId);
        profiles.delete(user.id); // cascade, per schema onDelete: Cascade
        return { count: 1 };
      },
    },
    profile: {
      async upsert(args: {
        where: { userId: string };
        create: {
          userId: string;
          username: string;
          displayName: string;
          avatarUrl: string | null;
        };
        update: { displayName: string; avatarUrl: string | null };
      }): Promise<ProfileRow> {
        const existing = profiles.get(args.where.userId);
        if (existing) {
          existing.displayName = args.update.displayName;
          existing.avatarUrl = args.update.avatarUrl;
          return existing;
        }
        const row: ProfileRow = {
          userId: args.create.userId,
          username: args.create.username,
          displayName: args.create.displayName,
          avatarUrl: args.create.avatarUrl,
        };
        profiles.set(row.userId, row);
        return row;
      },
    },
  };

  return {
    service: { client } as unknown as PrismaService,
    users,
    profiles,
  };
}

function userCreatedEvent(overrides: {
  clerkId: string;
  email: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): WebhookEvent {
  return {
    type: "user.created",
    data: {
      id: overrides.clerkId,
      username: overrides.username ?? null,
      first_name: overrides.firstName ?? null,
      last_name: overrides.lastName ?? null,
      image_url: "",
      primary_email_address_id: "idn_primary",
      email_addresses: [
        { id: "idn_primary", email_address: overrides.email },
      ],
    },
  } as unknown as WebhookEvent;
}

describe("ClerkWebhookService", () => {
  let service: ClerkWebhookService;
  let users: Map<string, UserRow>;
  let profiles: Map<string, ProfileRow>;

  beforeEach(() => {
    const fake = createFakePrisma();
    users = fake.users;
    profiles = fake.profiles;
    service = new ClerkWebhookService(fake.service);
  });

  it("creates one User + Profile for a new user.created event", async () => {
    await service.handleEvent(
      userCreatedEvent({
        clerkId: "user_1",
        email: "ada@coda.dev",
        username: "ada",
        firstName: "Ada",
        lastName: "Lovelace",
      }),
    );

    expect(users.size).toBe(1);
    expect(profiles.size).toBe(1);
    const user = users.get("user_1");
    expect(user?.email).toBe("ada@coda.dev");
    const profile = profiles.get(user!.id);
    expect(profile?.username).toBe("ada");
    expect(profile?.displayName).toBe("Ada Lovelace");
  });

  it("is idempotent: duplicate delivery yields exactly one User + Profile", async () => {
    const event = userCreatedEvent({
      clerkId: "user_1",
      email: "ada@coda.dev",
      username: "ada",
    });

    // At-least-once delivery: Clerk sends the same event twice.
    await service.handleEvent(event);
    await service.handleEvent(event);

    expect(users.size).toBe(1);
    expect(profiles.size).toBe(1);
  });

  it("falls back to the Clerk id when the user has no username", async () => {
    await service.handleEvent(
      userCreatedEvent({ clerkId: "user_2", email: "nobody@coda.dev" }),
    );

    const user = users.get("user_2");
    const profile = profiles.get(user!.id);
    expect(profile?.username).toBe("user_2");
    expect(profile?.displayName).toBe("user_2");
  });

  it("deletes the local user on user.deleted and is a no-op when repeated", async () => {
    await service.handleEvent(
      userCreatedEvent({ clerkId: "user_3", email: "gone@coda.dev" }),
    );
    expect(users.size).toBe(1);

    const deleteEvent = {
      type: "user.deleted",
      data: { id: "user_3", deleted: true },
    } as unknown as WebhookEvent;

    await service.handleEvent(deleteEvent);
    expect(users.size).toBe(0);
    expect(profiles.size).toBe(0);

    // Repeated delivery must not throw.
    await expect(service.handleEvent(deleteEvent)).resolves.toBeUndefined();
    expect(users.size).toBe(0);
  });
});
