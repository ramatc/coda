import { beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { Prisma } from "@coda/db";
import { ProfileService } from "../src/profile/profile.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

/**
 * In-memory Prisma stand-in honouring the exact query shapes ProfileService
 * uses (`user.findUnique`, `profile.findUnique`, `profile.update`) so profile
 * edit + avatar persistence are proven deterministically without a live
 * Postgres, matching the PR1/PR2 no-docker sandbox convention.
 */
interface UserRow {
  id: string;
  clerkUserId: string;
}

interface ProfileRow {
  userId: string;
  username: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  isPrivate: boolean;
}

/**
 * P2002 built with the REAL `@prisma/adapter-pg` driver-adapter error shape
 * (fields live on `meta.driverAdapterError.cause.constraint.fields`, NOT the
 * classic `meta.target` this client never populates — Decision #14).
 */
function usernameConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`username`)",
    {
      code: "P2002",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["username"] },
          },
        },
      },
    },
  );
}

function createFakePrisma(): {
  service: PrismaService;
  users: Map<string, UserRow>;
  profiles: Map<string, ProfileRow>;
} {
  const users = new Map<string, UserRow>();
  const profiles = new Map<string, ProfileRow>();

  const client = {
    user: {
      async findUnique(args: {
        where: { clerkUserId: string };
        include?: { profile?: boolean };
      }): Promise<unknown> {
        const user = users.get(args.where.clerkUserId);
        if (!user) {
          return null;
        }
        if (args.include?.profile) {
          return { ...user, profile: profiles.get(user.id) ?? null };
        }
        return user;
      },
    },
    profile: {
      async findUnique(args: {
        where: { username: string };
      }): Promise<unknown> {
        const profile = [...profiles.values()].find(
          (row) => row.username === args.where.username,
        );
        if (!profile) {
          return null;
        }
        const owner = [...users.values()].find((u) => u.id === profile.userId);
        return { ...profile, user: { clerkUserId: owner?.clerkUserId } };
      },
      async update(args: {
        where: { userId: string };
        data: Record<string, unknown>;
      }): Promise<ProfileRow> {
        const profile = profiles.get(args.where.userId);
        if (!profile) {
          throw new Prisma.PrismaClientKnownRequestError("Record not found", {
            code: "P2025",
            clientVersion: "test",
          });
        }
        // Enforce the unique(username) constraint like Postgres would.
        if (typeof args.data.username === "string") {
          const clash = [...profiles.values()].find(
            (row) =>
              row.username === args.data.username &&
              row.userId !== args.where.userId,
          );
          if (clash) {
            throw usernameConflict();
          }
        }
        Object.assign(profile, args.data);
        return profile;
      },
    },
  };

  return {
    service: { client } as unknown as PrismaService,
    users,
    profiles,
  };
}

function fakeConfig(): ConfigService {
  return {
    get: (key: string) =>
      key === "R2_PUBLIC_BASE" ? "https://cdn.coda.test/avatars" : undefined,
  } as unknown as ConfigService;
}

describe("ProfileService", () => {
  let service: ProfileService;
  let prismaService: PrismaService;
  let users: Map<string, UserRow>;
  let profiles: Map<string, ProfileRow>;

  function seedProfile(overrides: Partial<ProfileRow> = {}): ProfileRow {
    const user: UserRow = { id: "local_1", clerkUserId: "clerk_1" };
    users.set(user.clerkUserId, user);
    const profile: ProfileRow = {
      userId: user.id,
      username: "ada",
      displayName: "Ada Lovelace",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
      isPrivate: false,
      ...overrides,
    };
    profiles.set(profile.userId, profile);
    return profile;
  }

  beforeEach(() => {
    const fake = createFakePrisma();
    users = fake.users;
    profiles = fake.profiles;
    prismaService = fake.service;
    service = new ProfileService(fake.service, fakeConfig());
  });

  it("returns the authenticated user's own profile", async () => {
    seedProfile({ bio: "hi" });

    const result = await service.getOwnProfile("clerk_1");

    expect(result.username).toBe("ada");
    expect(result.bio).toBe("hi");
  });

  it("throws NotFound when the current user has no profile", async () => {
    await expect(service.getOwnProfile("clerk_missing")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("looks a profile up by username and flags it as the caller's own profile", async () => {
    seedProfile();

    const ownResult = await service.getByUsername("ada", "clerk_1");
    expect(ownResult.username).toBe("ada");
    expect(ownResult.isOwnProfile).toBe(true);
    expect(ownResult).not.toHaveProperty("clerkUserId");

    const otherResult = await service.getByUsername("ada", "clerk_2");
    expect(otherResult.isOwnProfile).toBe(false);

    const anonymousResult = await service.getByUsername("ada");
    expect(anonymousResult.isOwnProfile).toBe(false);
  });

  it("looks a profile up case-insensitively", async () => {
    seedProfile();

    const result = await service.getByUsername("ADA");

    expect(result.username).toBe("ada");
  });

  it("edits username and bio", async () => {
    seedProfile();

    const result = await service.updateOwnProfile("clerk_1", {
      username: "ada_l",
      bio: "Analytical Engine enthusiast",
    });

    expect(result.username).toBe("ada_l");
    expect(result.bio).toBe("Analytical Engine enthusiast");
    expect(profiles.get("local_1")?.username).toBe("ada_l");
  });

  it("persists a valid avatarUrl (upload succeeds)", async () => {
    seedProfile({ avatarUrl: "https://cdn.coda.test/avatars/avatars/local_1/old" });

    const newUrl = "https://cdn.coda.test/avatars/avatars/local_1/new-uuid";
    const result = await service.updateOwnProfile("clerk_1", {
      avatarUrl: newUrl,
    });

    expect(result.avatarUrl).toBe(newUrl);
    expect(profiles.get("local_1")?.avatarUrl).toBe(newUrl);
  });

  it("leaves the prior avatar unchanged when the new avatarUrl is off-storage", async () => {
    const prior = "https://cdn.coda.test/avatars/avatars/local_1/keep";
    seedProfile({ avatarUrl: prior });

    await expect(
      service.updateOwnProfile("clerk_1", {
        avatarUrl: "https://evil.example.com/not-our-bucket.png",
      }),
    ).rejects.toBeTruthy();

    // The rejected update must not have touched the stored avatar.
    expect(profiles.get("local_1")?.avatarUrl).toBe(prior);
  });

  it("rejects a username already taken by another profile (P2002 → 409)", async () => {
    seedProfile();
    // A second profile already owns the target username.
    users.set("clerk_2", { id: "local_2", clerkUserId: "clerk_2" });
    profiles.set("local_2", {
      userId: "local_2",
      username: "taken",
      displayName: "Someone",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
      isPrivate: false,
    });

    await expect(
      service.updateOwnProfile("clerk_1", { username: "taken" }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects an out-of-spec username with a validation error", async () => {
    seedProfile();

    await expect(
      service.updateOwnProfile("clerk_1", { username: "no spaces!" }),
    ).rejects.toBeTruthy();
    expect(profiles.get("local_1")?.username).toBe("ada");
  });

  it("canonicalizes a mixed-case username to lowercase", async () => {
    seedProfile();

    const result = await service.updateOwnProfile("clerk_1", {
      username: "Ada_Lovelace",
    });

    expect(result.username).toBe("ada_lovelace");
    expect(profiles.get("local_1")?.username).toBe("ada_lovelace");
  });

  it("clears avatarUrl when set to null", async () => {
    seedProfile({ avatarUrl: "https://cdn.coda.test/avatars/avatars/local_1/old" });

    const result = await service.updateOwnProfile("clerk_1", { avatarUrl: null });

    expect(result.avatarUrl).toBeNull();
    expect(profiles.get("local_1")?.avatarUrl).toBeNull();
  });

  it("rejects an avatarUrl on a look-alike origin (not just a string-prefix match)", async () => {
    seedProfile({ avatarUrl: null });

    await expect(
      service.updateOwnProfile("clerk_1", {
        // Prefix-matches "https://cdn.coda.test" as a raw string, but is really
        // a different origin (`cdn.coda.test.evil.com`).
        avatarUrl: "https://cdn.coda.test.evil.com/avatars/x.png",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(profiles.get("local_1")?.avatarUrl).toBeNull();
  });

  it("fails closed when R2_PUBLIC_BASE is not configured", async () => {
    seedProfile({ avatarUrl: null });
    const unconfigured = new ProfileService(
      prismaService,
      { get: () => undefined } as unknown as ConfigService,
    );

    await expect(
      unconfigured.updateOwnProfile("clerk_1", {
        avatarUrl: "https://cdn.coda.test/avatars/avatars/local_1/new",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
