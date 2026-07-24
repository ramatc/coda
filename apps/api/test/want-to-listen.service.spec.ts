import { beforeEach, describe, expect, it } from "vitest";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@coda/db";
import { WantToListenService } from "../src/want-to-listen/want-to-listen.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const OWNER_CLERK = "clerk_owner";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_USERNAME = "owner";
const OTHER_CLERK = "clerk_other";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ALBUM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALBUM_ID_2 = "abababab-abab-4bab-8bab-abababababab";
const ALBUM_ID_3 = "acacacac-acac-4cac-8cac-acacacacacac";
const UNKNOWN_ALBUM_ID = "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae";

interface StoredWant {
  id: string;
  userId: string;
  albumId: string;
  createdAt: Date;
}

/**
 * Builds a P2002 unique-constraint error shaped like this project's Prisma 7
 * client (the REAL `@prisma/adapter-pg` driver-adapter shape: the conflicting
 * columns live on `meta.driverAdapterError.cause.constraint.fields`, NOT the
 * classic `meta.target` this client never populates — Decision #14). The
 * `WantToListen.userId` field is `@map("user_id")`, so a `@@unique([userId,
 * albumId])` violation reports the RAW snake_case column `user_id` — NOT the
 * camelCase Prisma field name (PR2 judgment-day Round 2 gotcha) — which is what
 * {@link extractUniqueConstraintField} returns and the mark path must compare
 * against to map the duplicate to a 409 (not a 500).
 */
function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`user_id`,`album_id`)",
    {
      code: "P2002",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["user_id"] },
          },
        },
      },
    },
  );
}

/**
 * Builds a P2003 foreign-key violation shaped like this project's Prisma 7
 * client, so an `albumId` that doesn't reference a real `Album` maps to a 404
 * rather than surfacing as a raw 500 (parity with the lists `addItem` path).
 */
function foreignKeyError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Foreign key constraint failed on the field: `album_id`",
    { code: "P2003", clientVersion: "test" },
  );
}

/**
 * In-memory Prisma stand-in honouring the exact queries {@link
 * WantToListenService} issues: `user.findUnique` by clerk id, `profile.findUnique`
 * by username, `wantToListen.create` / `deleteMany` / `findMany`, and the
 * `listen.findMany` / `rating.findMany` reads that drive the read-time
 * anti-join. Proves the behavior deterministically without a live Postgres (the
 * project's no-docker sandbox convention, mirroring `lists.service.spec`).
 */
function createFakePrisma() {
  const usersByClerk = new Map<string, string>();
  const usersByUsername = new Map<string, string>();
  const wants: StoredWant[] = [];
  const listens: { userId: string; albumId: string }[] = [];
  const ratings: { userId: string; albumId: string }[] = [];
  // Opt-in FK strictness: when non-empty, a create for an album NOT in this set
  // throws a P2003, exercising the FK→404 mapping. Empty → all albums "exist".
  const knownAlbums = new Set<string>();
  let idSeq = 0;

  function nextId(): string {
    idSeq += 1;
    return `ffffffff-ffff-4fff-8fff-${idSeq.toString().padStart(12, "0")}`;
  }

  const client = {
    user: {
      async findUnique(args: {
        where: { clerkUserId: string };
      }): Promise<{ id: string } | null> {
        const id = usersByClerk.get(args.where.clerkUserId);
        return id ? { id } : null;
      },
    },
    profile: {
      async findUnique(args: {
        where: { username: string };
      }): Promise<{ userId: string } | null> {
        const userId = usersByUsername.get(args.where.username);
        return userId ? { userId } : null;
      },
    },
    wantToListen: {
      async create(args: {
        data: { userId: string; albumId: string };
      }): Promise<StoredWant> {
        if (knownAlbums.size > 0 && !knownAlbums.has(args.data.albumId)) {
          throw foreignKeyError();
        }
        const duplicate = wants.some(
          (w) =>
            w.userId === args.data.userId && w.albumId === args.data.albumId,
        );
        if (duplicate) {
          throw uniqueConstraintError();
        }
        const row: StoredWant = {
          id: nextId(),
          userId: args.data.userId,
          albumId: args.data.albumId,
          createdAt: new Date(`2026-07-2${wants.length + 1}T00:00:00.000Z`),
        };
        wants.push(row);
        return row;
      },
      async deleteMany(args: {
        where: { userId: string; albumId: string };
      }): Promise<{ count: number }> {
        const before = wants.length;
        for (let i = wants.length - 1; i >= 0; i -= 1) {
          if (
            wants[i].userId === args.where.userId &&
            wants[i].albumId === args.where.albumId
          ) {
            wants.splice(i, 1);
          }
        }
        return { count: before - wants.length };
      },
      async findMany(args: {
        where: { userId: string };
      }): Promise<Record<string, unknown>[]> {
        return wants
          .filter((w) => w.userId === args.where.userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((w) => ({
            id: w.id,
            albumId: w.albumId,
            createdAt: w.createdAt,
            album: {
              id: w.albumId,
              title: "OK Computer",
              coverUrl: "https://cdn.coda.test/ok.jpg",
              primaryArtist: { name: "Radiohead" },
            },
          }));
      },
    },
    listen: {
      async findMany(args: {
        where: { userId: string };
      }): Promise<{ albumId: string }[]> {
        const seen = new Set<string>();
        const out: { albumId: string }[] = [];
        for (const l of listens) {
          if (l.userId === args.where.userId && !seen.has(l.albumId)) {
            seen.add(l.albumId);
            out.push({ albumId: l.albumId });
          }
        }
        return out;
      },
    },
    rating: {
      async findMany(args: {
        where: { userId: string };
      }): Promise<{ albumId: string }[]> {
        return ratings
          .filter((r) => r.userId === args.where.userId)
          .map((r) => ({ albumId: r.albumId }));
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    usersByClerk,
    usersByUsername,
    wants,
    listens,
    ratings,
    knownAlbums,
  };
}

describe("WantToListenService", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let service: WantToListenService;

  beforeEach(() => {
    fake = createFakePrisma();
    service = new WantToListenService(fake.prisma);
    fake.usersByClerk.set(OWNER_CLERK, OWNER_ID);
    fake.usersByClerk.set(OTHER_CLERK, OTHER_ID);
    fake.usersByUsername.set(OWNER_USERNAME, OWNER_ID);
  });

  function seedWant(overrides: Partial<StoredWant> = {}): StoredWant {
    const row: StoredWant = {
      id: overrides.id ?? "seed-want-1",
      userId: overrides.userId ?? OWNER_ID,
      albumId: overrides.albumId ?? ALBUM_ID,
      createdAt: overrides.createdAt ?? new Date("2026-07-10T00:00:00.000Z"),
    };
    fake.wants.push(row);
    return row;
  }

  describe("markAlbum", () => {
    it("creates a caller-scoped row and returns it", async () => {
      const row = await service.markAlbum(OWNER_CLERK, { albumId: ALBUM_ID });

      expect(row).toMatchObject({ albumId: ALBUM_ID });
      expect(typeof row.id).toBe("string");
      expect(row.createdAt).toMatch(/^2026-/);
      expect(fake.wants).toHaveLength(1);
      expect(fake.wants[0]).toMatchObject({ userId: OWNER_ID, albumId: ALBUM_ID });
    });

    it("rejects a duplicate mark with a 409 and creates no second row", async () => {
      seedWant({ userId: OWNER_ID, albumId: ALBUM_ID });

      await expect(
        service.markAlbum(OWNER_CLERK, { albumId: ALBUM_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(fake.wants).toHaveLength(1);
    });

    it("maps a non-existent albumId (FK violation) to a 404", async () => {
      fake.knownAlbums.add(ALBUM_ID); // only this album exists
      await expect(
        service.markAlbum(OWNER_CLERK, { albumId: UNKNOWN_ALBUM_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.wants).toHaveLength(0);
    });

    it("rejects an unsynced caller with a 404", async () => {
      await expect(
        service.markAlbum("unsynced_clerk", { albumId: ALBUM_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.wants).toHaveLength(0);
    });

    it("rejects a malformed albumId with a 400", async () => {
      await expect(
        service.markAlbum(OWNER_CLERK, { albumId: "not-a-uuid" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.wants).toHaveLength(0);
    });
  });

  describe("unmarkAlbum", () => {
    it("deletes the caller's own row", async () => {
      seedWant({ userId: OWNER_ID, albumId: ALBUM_ID });

      await expect(
        service.unmarkAlbum(OWNER_CLERK, ALBUM_ID),
      ).resolves.toBeUndefined();
      expect(fake.wants).toHaveLength(0);
    });

    it("returns 404 when the caller has no row for that album", async () => {
      await expect(
        service.unmarkAlbum(OWNER_CLERK, ALBUM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("does not affect another user's row (scoped to caller) → 404", async () => {
      const foreign = seedWant({ userId: OWNER_ID, albumId: ALBUM_ID });

      await expect(
        service.unmarkAlbum(OTHER_CLERK, ALBUM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.wants.some((w) => w.id === foreign.id)).toBe(true);
    });

    it("rejects an unsynced caller with a 404", async () => {
      await expect(
        service.unmarkAlbum("unsynced_clerk", ALBUM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a malformed albumId with a 400", async () => {
      await expect(
        service.unmarkAlbum(OWNER_CLERK, "not-a-uuid"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("getUserWantToListen", () => {
    it("returns the target's unresolved rows, newest first, with album denormalized", async () => {
      seedWant({
        id: "w1",
        albumId: ALBUM_ID,
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
      });
      seedWant({
        id: "w2",
        albumId: ALBUM_ID_2,
        createdAt: new Date("2026-07-12T00:00:00.000Z"),
      });

      const entries = await service.getUserWantToListen(OWNER_USERNAME);

      expect(entries.map((e) => e.albumId)).toEqual([ALBUM_ID_2, ALBUM_ID]);
      expect(entries[0]).toMatchObject({
        id: "w2",
        albumId: ALBUM_ID_2,
        album: {
          id: ALBUM_ID_2,
          title: "OK Computer",
          coverUrl: "https://cdn.coda.test/ok.jpg",
          primaryArtistName: "Radiohead",
        },
      });
      expect(entries[0].createdAt).toBe("2026-07-12T00:00:00.000Z");
    });

    it("excludes an album the target has a Listen for, keeps unresolved ones", async () => {
      seedWant({ id: "w1", albumId: ALBUM_ID });
      seedWant({ id: "w2", albumId: ALBUM_ID_2 });
      fake.listens.push({ userId: OWNER_ID, albumId: ALBUM_ID });

      const entries = await service.getUserWantToListen(OWNER_USERNAME);

      expect(entries.map((e) => e.albumId)).toEqual([ALBUM_ID_2]);
    });

    it("excludes an album the target has only RATED (rated-without-listened)", async () => {
      seedWant({ id: "w1", albumId: ALBUM_ID });
      seedWant({ id: "w2", albumId: ALBUM_ID_2 });
      seedWant({ id: "w3", albumId: ALBUM_ID_3 });
      fake.ratings.push({ userId: OWNER_ID, albumId: ALBUM_ID_2 });

      const entries = await service.getUserWantToListen(OWNER_USERNAME);

      expect(entries.map((e) => e.albumId).sort()).toEqual(
        [ALBUM_ID, ALBUM_ID_3].sort(),
      );
    });

    it("resurfaces an album after the resolving Listen is deleted", async () => {
      seedWant({ id: "w1", albumId: ALBUM_ID });
      fake.listens.push({ userId: OWNER_ID, albumId: ALBUM_ID });

      const resolved = await service.getUserWantToListen(OWNER_USERNAME);
      expect(resolved.map((e) => e.albumId)).toEqual([]);

      // Un-listen: delete the Listen that had auto-resolved the row.
      fake.listens.length = 0;

      const resurfaced = await service.getUserWantToListen(OWNER_USERNAME);
      expect(resurfaced.map((e) => e.albumId)).toEqual([ALBUM_ID]);
    });

    it("only anti-joins against the TARGET user's own Listens/Ratings", async () => {
      seedWant({ id: "w1", userId: OWNER_ID, albumId: ALBUM_ID });
      // A DIFFERENT user listened to the same album — must not resolve OWNER's row.
      fake.listens.push({ userId: OTHER_ID, albumId: ALBUM_ID });

      const entries = await service.getUserWantToListen(OWNER_USERNAME);

      expect(entries.map((e) => e.albumId)).toEqual([ALBUM_ID]);
    });

    it("returns an empty array for a profile with no entries (not an error)", async () => {
      fake.usersByUsername.set("empty", OTHER_ID);

      const entries = await service.getUserWantToListen("empty");

      expect(entries).toEqual([]);
    });

    it("throws 404 for an unknown username", async () => {
      await expect(
        service.getUserWantToListen("ghost"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
