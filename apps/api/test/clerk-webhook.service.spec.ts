import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookEvent } from "@clerk/backend";
import { ConflictException, Logger, UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@coda/db";
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
  client: {
    profile: { upsert: (...args: never[]) => unknown };
    user: { upsert: (...args: never[]) => unknown };
  };
} {
  const users = new Map<string, UserRow>();
  const profiles = new Map<string, ProfileRow>();
  let seq = 0;

  const client = {
    async $transaction<T>(fn: (tx: typeof client) => Promise<T>): Promise<T> {
      // Snapshot-and-restore models real Postgres rollback semantics: if the
      // callback throws partway through, mutations already applied to these
      // Maps are undone rather than silently left committed. Rows are
      // deep-cloned (not just the Map) because update branches mutate row
      // objects in place — a shallow `new Map(users)` would still share the
      // same row references and "roll back" nothing.
      const usersSnapshot = new Map(
        [...users].map(([key, value]) => [key, { ...value }]),
      );
      const profilesSnapshot = new Map(
        [...profiles].map(([key, value]) => [key, { ...value }]),
      );
      try {
        return await fn(client);
      } catch (err) {
        users.clear();
        for (const [key, value] of usersSnapshot) {
          users.set(key, value);
        }
        profiles.clear();
        for (const [key, value] of profilesSnapshot) {
          profiles.set(key, value);
        }
        throw err;
      }
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
        // Mirrors the real call site (`clerk-webhook.service.ts`), which only
        // ever passes `{ avatarUrl }` on update — `displayName` is
        // intentionally omitted so it's never touched by an update. Do NOT
        // add a `displayName` field here without also updating this comment
        // and the real service, otherwise this fake diverges from Prisma's
        // partial-update semantics (unspecified columns stay untouched).
        update: { avatarUrl: string | null };
      }): Promise<ProfileRow> {
        const existing = profiles.get(args.where.userId);
        if (existing) {
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
    client,
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

function userUpdatedEvent(overrides: {
  clerkId: string;
  email: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  avatarUrl?: string;
}): WebhookEvent {
  return {
    type: "user.updated",
    data: {
      id: overrides.clerkId,
      username: overrides.username ?? null,
      first_name: overrides.firstName ?? null,
      last_name: overrides.lastName ?? null,
      image_url: overrides.avatarUrl ?? "",
      primary_email_address_id: "idn_primary",
      email_addresses: [
        { id: "idn_primary", email_address: overrides.email },
      ],
    },
  } as unknown as WebhookEvent;
}

function userEventWithNoEmail(clerkId: string): WebhookEvent {
  return {
    type: "user.created",
    data: {
      id: clerkId,
      username: null,
      first_name: null,
      last_name: null,
      image_url: "",
      primary_email_address_id: null,
      email_addresses: [],
    },
  } as unknown as WebhookEvent;
}

describe("ClerkWebhookService", () => {
  let service: ClerkWebhookService;
  let users: Map<string, UserRow>;
  let profiles: Map<string, ProfileRow>;
  let client: {
    profile: { upsert: (...args: never[]) => unknown };
    user: { upsert: (...args: never[]) => unknown };
  };

  beforeEach(() => {
    const fake = createFakePrisma();
    users = fake.users;
    profiles = fake.profiles;
    client = fake.client;
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

  it("lowercases a mixed-case Clerk username for the username column but preserves its casing in displayName", async () => {
    await service.handleEvent(
      userCreatedEvent({ clerkId: "user_16", email: "mixed@coda.dev", username: "AdaLovelace" }),
    );

    const user = users.get("user_16");
    const profile = profiles.get(user!.id);
    // The lookup/URL key must be canonicalized...
    expect(profile?.username).toBe("adalovelace");
    // ...but the human-facing displayName fallback must NOT be case-mangled
    // (Round 2 introduced this as an unintended regression).
    expect(profile?.displayName).toBe("AdaLovelace");
  });

  it("falls back to the RAW (un-lowercased) Clerk id for displayName when there is no username", async () => {
    await service.handleEvent(
      userCreatedEvent({ clerkId: "User_Mixed_2", email: "mixedid@coda.dev" }),
    );

    const user = users.get("User_Mixed_2");
    const profile = profiles.get(user!.id);
    expect(profile?.username).toBe("user_mixed_2");
    expect(profile?.displayName).toBe("User_Mixed_2");
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

  it("rolls back the User row when a later step in the transaction throws", async () => {
    client.profile.upsert = () => {
      throw new Error("simulated failure after user.upsert committed");
    };

    await expect(
      service.handleEvent(
        userCreatedEvent({ clerkId: "user_4", email: "atomic@coda.dev" }),
      ),
    ).rejects.toThrow("simulated failure");

    // The fake's $transaction must undo the User row it already wrote,
    // matching real Postgres transaction semantics — otherwise this fake
    // proves nothing about atomicity.
    expect(users.has("user_4")).toBe(false);
    expect(profiles.size).toBe(0);
  });

  it("rolls back an in-place update (not just an insert) when a later step throws", async () => {
    await service.handleEvent(
      userCreatedEvent({
        clerkId: "user_9",
        email: "original@coda.dev",
        username: "orig",
      }),
    );
    expect(users.get("user_9")?.email).toBe("original@coda.dev");

    client.profile.upsert = () => {
      throw new Error("simulated failure after user.upsert update committed");
    };

    await expect(
      service.handleEvent(
        userUpdatedEvent({
          clerkId: "user_9",
          email: "changed@coda.dev",
          username: "orig",
        }),
      ),
    ).rejects.toThrow("simulated failure");

    // The row must be reverted to its pre-update field values, not left
    // holding the in-flight mutation from the failed transaction — a
    // shallow Map snapshot would pass this test with the wrong (mutated)
    // value still present because it shares the same row reference.
    expect(users.get("user_9")?.email).toBe("original@coda.dev");
  });

  it("preserves displayName on user.updated but still syncs avatarUrl", async () => {
    await service.handleEvent(
      userCreatedEvent({
        clerkId: "user_10",
        email: "grace@coda.dev",
        username: "grace",
        firstName: "Grace",
        lastName: "Hopper",
      }),
    );
    const user = users.get("user_10")!;
    expect(profiles.get(user.id)?.displayName).toBe("Grace Hopper");
    expect(profiles.get(user.id)?.avatarUrl).toBeNull();

    await service.handleEvent(
      userUpdatedEvent({
        clerkId: "user_10",
        email: "grace@coda.dev",
        username: "grace",
        firstName: "Changed",
        lastName: "Name",
        avatarUrl: "https://img.example.com/grace.png",
      }),
    );

    const profile = profiles.get(user.id);
    // displayName is Clerk-authoritative only at creation time (see
    // clerk-webhook.service.ts) — a later user.updated with different
    // first/last name must NOT overwrite it.
    expect(profile?.displayName).toBe("Grace Hopper");
    // avatarUrl, by contrast, is always kept in sync with Clerk.
    expect(profile?.avatarUrl).toBe("https://img.example.com/grace.png");
  });

  it("rejects with UnprocessableEntityException when the Clerk user has no email address", async () => {
    await expect(
      service.handleEvent(userEventWithNoEmail("user_11")),
    ).rejects.toThrow(UnprocessableEntityException);

    expect(users.size).toBe(0);
  });

  /**
   * Builds a P2002 error using the REAL shape produced by this project's
   * Prisma 7 client, which always runs on the `@prisma/adapter-pg` driver
   * adapter: `err.meta.target` is never populated. Instead,
   * `@prisma/adapter-pg`'s `mapDriverError` builds
   * `{ kind: "UniqueConstraintViolation", constraint: { fields: [...] } }` for
   * Postgres error code `23505`, `@prisma/driver-adapter-utils`'s
   * `DriverAdapterError` stores that payload verbatim on `.cause`, and the
   * generated client re-throws it as `PrismaClientKnownRequestError` with
   * `meta: { driverAdapterError: <that error> } }` — confirmed by reading the
   * installed `@prisma/adapter-pg`/`@prisma/driver-adapter-utils` packages and
   * `packages/db/src/generated/client/runtime/client.js`.
   */
  function p2002WithFields(
    message: string,
    fields: string[] | undefined,
  ): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError(message, {
      code: "P2002",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: fields !== undefined ? { fields } : undefined,
          },
        },
      },
    });
  }

  it("attributes a P2002 conflict on Profile.username to the username field, not email", async () => {
    client.profile.upsert = () => {
      throw p2002WithFields(
        "Unique constraint failed on the fields: (`username`)",
        ["username"],
      );
    };

    await expect(
      service.handleEvent(
        userCreatedEvent({
          clerkId: "user_12",
          email: "conflict@coda.dev",
          username: "taken",
        }),
      ),
    ).rejects.toThrow(
      new ConflictException("Username taken is already in use by another account"),
    );
  });

  it("attributes a P2002 conflict on User.email to the email field", async () => {
    client.user.upsert = () => {
      throw p2002WithFields(
        "Unique constraint failed on the fields: (`email`)",
        ["email"],
      );
    };

    await expect(
      service.handleEvent(
        userCreatedEvent({
          clerkId: "user_13",
          email: "dup@coda.dev",
          username: "dup",
        }),
      ),
    ).rejects.toThrow(
      new ConflictException("Email dup@coda.dev is already in use by another account"),
    );
  });

  it("does not mislabel a P2002 conflict on an unrecognized field as an email conflict", async () => {
    client.user.upsert = () => {
      throw p2002WithFields(
        "Unique constraint failed on the fields: (`clerk_user_id`)",
        ["clerk_user_id"],
      );
    };

    await expect(
      service.handleEvent(
        userCreatedEvent({
          clerkId: "user_14",
          email: "unrelated@coda.dev",
          username: "unrelated",
        }),
      ),
    ).rejects.toThrow(
      new ConflictException(
        "This account could not be synced because of a conflicting field",
      ),
    );
  });

  it("does not mislabel a P2002 with a missing constraint as an email conflict", async () => {
    client.user.upsert = () => {
      throw p2002WithFields(
        "Unique constraint failed",
        undefined,
      );
    };

    await expect(
      service.handleEvent(
        userCreatedEvent({
          clerkId: "user_15",
          email: "unrelated2@coda.dev",
          username: "unrelated2",
        }),
      ),
    ).rejects.toThrow(
      new ConflictException(
        "This account could not be synced because of a conflicting field",
      ),
    );
  });

  it("logs a warning and does not throw when user.deleted has no id", async () => {
    const warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    const deleteEvent = {
      type: "user.deleted",
      data: { id: "", deleted: true },
    } as unknown as WebhookEvent;

    await expect(service.handleEvent(deleteEvent)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "Ignoring user.deleted event with no user id",
    );

    warnSpy.mockRestore();
  });
});
