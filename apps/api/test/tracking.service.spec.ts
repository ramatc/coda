import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@coda/db";
import { TrackingService } from "../src/tracking/tracking.service.js";
import { SCORE_RANGE_ERROR } from "../src/tracking/tracking.constants.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";
import type { RecoQueue } from "../src/recommendations/reco.queue.js";

/** Records the debounced recommendation trigger fired on positive tracking writes. */
function createRecoQueueStub() {
  const enqueueGeneration = vi.fn().mockResolvedValue(undefined);
  const enqueueDebouncedGeneration = vi.fn().mockResolvedValue(undefined);
  return {
    enqueueGeneration,
    enqueueDebouncedGeneration,
    queue: {
      enqueueGeneration,
      enqueueDebouncedGeneration,
    } as unknown as RecoQueue,
  };
}

/**
 * `PrismaClientKnownRequestError` builder matching the REAL driver-adapter
 * shape this project's Prisma client throws (Decision #14) — reused here for
 * the P2002/P2025/P2003 fakes below so the tests exercise the exact error
 * class `tracking.service.ts` type-guards against, not a plain `Error`.
 */
function prismaError(
  message: string,
  code: string,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "test",
  });
}

const ALBUM_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ALBUM_ID = "44444444-4444-4444-8444-444444444444";

interface ListenRow {
  id: string;
  userId: string;
  albumId: string;
  listenedAt: Date;
}
interface RatingRow {
  id: string;
  userId: string;
  albumId: string;
  score: number;
}
interface ReviewRow {
  id: string;
  userId: string;
  albumId: string;
  body: string;
}
interface ActivityRow {
  id: string;
  userId: string;
  type: string;
  albumId: string;
  listenId: string | null;
  reviewId: string | null;
  ratingId: string | null;
  payload: unknown;
}

/**
 * In-memory Prisma stand-in honouring the exact query shapes TrackingService
 * uses, so listen/rating/review writes + the delete-cleanup paths are proven
 * deterministically without a live Postgres (PR1-7 no-docker sandbox
 * convention). `$transaction` is a pass-through: TrackingService validates
 * BEFORE opening a transaction, so a rejected write never reaches these tables
 * in the ordinary (non-race) test cases.
 *
 * The `rating`/`review` model doubles enforce their real unique constraints
 * (`create` throws P2002 on a duplicate (userId, albumId), `delete`/`update`
 * throw P2025 if the row is already gone) and `rating.delete` additionally
 * simulates the real migration's `ON DELETE RESTRICT` FK from `reviews`
 * (throws P2003 if a review still references it) — this lets race-condition
 * tests monkey-patch a single model method (via the exposed `client`) to
 * simulate a concurrent writer completing between a pre-check and the write
 * it guards, and lets the ordering test below catch a reordered
 * review/rating delete (judgment-day PR8 round 2, issues #1 and #2).
 */
function createFakePrisma() {
  const users = new Map<string, string>();
  const albums = new Set<string>();
  const listens: ListenRow[] = [];
  const ratings: RatingRow[] = [];
  const reviews: ReviewRow[] = [];
  const activity: ActivityRow[] = [];
  let seq = 0;
  // Real Prisma ids are UUIDs; the service validates a `listenId` as UUID-shaped
  // before querying, so the fake must mint the same shape.
  const nextId = (): string =>
    `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

  const client = {
    async $transaction<T>(fn: (tx: typeof client) => Promise<T>): Promise<T> {
      return fn(client);
    },
    user: {
      async findUnique(args: {
        where: { clerkUserId: string };
      }): Promise<{ id: string } | null> {
        const id = users.get(args.where.clerkUserId);
        return id ? { id } : null;
      },
    },
    album: {
      async findUnique(args: {
        where: { id: string };
      }): Promise<{ id: string } | null> {
        return albums.has(args.where.id) ? { id: args.where.id } : null;
      },
    },
    listen: {
      async findFirst(args: {
        where: { userId?: string; albumId?: string; id?: string };
      }): Promise<ListenRow | null> {
        const { userId, albumId, id } = args.where;
        const matches = listens
          .filter(
            (r) =>
              (userId === undefined || r.userId === userId) &&
              (albumId === undefined || r.albumId === albumId) &&
              (id === undefined || r.id === id),
          )
          .sort((a, b) => b.listenedAt.getTime() - a.listenedAt.getTime());
        return matches[0] ?? null;
      },
      async create(args: {
        data: { userId: string; albumId: string };
      }): Promise<ListenRow> {
        const row: ListenRow = {
          id: nextId(),
          userId: args.data.userId,
          albumId: args.data.albumId,
          listenedAt: new Date(),
        };
        listens.push(row);
        return row;
      },
      async delete(args: { where: { id: string } }): Promise<ListenRow> {
        const index = listens.findIndex((r) => r.id === args.where.id);
        if (index === -1) {
          // Matches real Prisma: `delete` on a row that's already gone
          // throws P2025 ("record to delete does not exist") — the shape
          // `deleteListen`'s race-recovery catch (judgment-day PR8 round 2,
          // issue #1) must handle.
          throw prismaError(
            "An operation failed because it depends on one or more records that were required but not found.",
            "P2025",
          );
        }
        const [removed] = listens.splice(index, 1);
        return removed;
      },
    },
    rating: {
      async findUnique(args: {
        where: { userId_albumId: { userId: string; albumId: string } };
      }): Promise<RatingRow | null> {
        const { userId, albumId } = args.where.userId_albumId;
        return (
          ratings.find((r) => r.userId === userId && r.albumId === albumId) ??
          null
        );
      },
      async findUniqueOrThrow(args: {
        where: { userId_albumId: { userId: string; albumId: string } };
      }): Promise<RatingRow> {
        const { userId, albumId } = args.where.userId_albumId;
        const row = ratings.find(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        if (!row) {
          throw prismaError(
            "An operation failed because it depends on one or more records that were required but not found.",
            "P2025",
          );
        }
        return row;
      },
      async create(args: {
        data: { userId: string; albumId: string; score: number };
      }): Promise<RatingRow> {
        const { userId, albumId, score } = args.data;
        if (ratings.some((r) => r.userId === userId && r.albumId === albumId)) {
          // Matches the real composite PK `@@id([userId, albumId])`: a
          // second concurrent create for the same pair is a unique-constraint
          // violation, not a silent overwrite.
          throw prismaError(
            "Unique constraint failed on the fields: (`user_id`,`album_id`)",
            "P2002",
          );
        }
        const row: RatingRow = { id: nextId(), userId, albumId, score };
        ratings.push(row);
        return row;
      },
      async update(args: {
        where: { userId_albumId: { userId: string; albumId: string } };
        data: { score: number };
      }): Promise<RatingRow> {
        const { userId, albumId } = args.where.userId_albumId;
        const row = ratings.find(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        if (!row) {
          // Matches real Prisma: `update` on a row that's already gone
          // throws P2025 — the shape `rateAlbum`'s update-race-recovery catch
          // (judgment-day PR8 round 3, issue #1) must handle.
          throw prismaError(
            "An operation failed because it depends on one or more records that were required but not found.",
            "P2025",
          );
        }
        row.score = args.data.score;
        return row;
      },
      async delete(args: {
        where: { userId_albumId: { userId: string; albumId: string } };
      }): Promise<RatingRow> {
        const { userId, albumId } = args.where.userId_albumId;
        const index = ratings.findIndex(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        if (index === -1) {
          // Matches real Prisma: `delete` on a row that's already gone
          // throws P2025 — the shape `deleteRating`'s race-recovery catch
          // (judgment-day PR8 round 2, issue #1) must handle.
          throw prismaError(
            "An operation failed because it depends on one or more records that were required but not found.",
            "P2025",
          );
        }
        // Simulates Postgres's `reviews_user_id_album_id_fkey ... ON DELETE
        // RESTRICT` (confirmed in the migration SQL): a review row still
        // referencing this (userId, albumId) blocks the rating delete.
        // `deleteRating` relies on this — it explicitly deletes the review
        // BEFORE the rating — so a future edit that reordered those deletes
        // would hit this here instead of silently passing (judgment-day PR8
        // round 2, issue #2).
        if (reviews.some((r) => r.userId === userId && r.albumId === albumId)) {
          throw prismaError(
            "Foreign key constraint failed on the field: " +
              "reviews_user_id_album_id_fkey (index)",
            "P2003",
          );
        }
        const [removed] = ratings.splice(index, 1);
        return removed;
      },
      async aggregate(args: {
        where: { albumId: string };
      }): Promise<{
        _avg: { score: number | null };
        _count: { _all: number };
      }> {
        const scores = ratings
          .filter((r) => r.albumId === args.where.albumId)
          .map((r) => r.score);
        const avg =
          scores.length === 0
            ? null
            : scores.reduce((a, b) => a + b, 0) / scores.length;
        return { _avg: { score: avg }, _count: { _all: scores.length } };
      },
    },
    review: {
      async findUnique(args: {
        where: { userId_albumId: { userId: string; albumId: string } };
      }): Promise<ReviewRow | null> {
        const { userId, albumId } = args.where.userId_albumId;
        return (
          reviews.find((r) => r.userId === userId && r.albumId === albumId) ??
          null
        );
      },
      async findUniqueOrThrow(args: {
        where: { userId_albumId: { userId: string; albumId: string } };
      }): Promise<ReviewRow> {
        const { userId, albumId } = args.where.userId_albumId;
        const row = reviews.find(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        if (!row) {
          throw prismaError(
            "An operation failed because it depends on one or more records that were required but not found.",
            "P2025",
          );
        }
        return row;
      },
      async create(args: {
        data: { userId: string; albumId: string; body: string };
      }): Promise<ReviewRow> {
        const { userId, albumId, body } = args.data;
        if (reviews.some((r) => r.userId === userId && r.albumId === albumId)) {
          // Matches the real `@@unique([userId, albumId])`: a second
          // concurrent create for the same pair is a unique-constraint
          // violation, not a silent overwrite.
          throw prismaError(
            "Unique constraint failed on the fields: (`user_id`,`album_id`)",
            "P2002",
          );
        }
        const row: ReviewRow = { id: nextId(), userId, albumId, body };
        reviews.push(row);
        return row;
      },
      async update(args: {
        where: { userId_albumId: { userId: string; albumId: string } };
        data: { body: string };
      }): Promise<ReviewRow> {
        const { userId, albumId } = args.where.userId_albumId;
        const row = reviews.find(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        if (!row) {
          // Matches real Prisma: `update` on a row that's already gone
          // throws P2025 — the shape `writeReview`'s update-race-recovery
          // catch (judgment-day PR8 round 3, issue #1) must handle.
          throw prismaError(
            "An operation failed because it depends on one or more records that were required but not found.",
            "P2025",
          );
        }
        row.body = args.data.body;
        return row;
      },
      async delete(args: { where: { id: string } }): Promise<ReviewRow> {
        const index = reviews.findIndex((r) => r.id === args.where.id);
        if (index === -1) {
          throw prismaError(
            "An operation failed because it depends on one or more records that were required but not found.",
            "P2025",
          );
        }
        const [removed] = reviews.splice(index, 1);
        return removed;
      },
    },
    activityEvent: {
      async create(args: { data: ActivityRow }): Promise<ActivityRow> {
        const row: ActivityRow = {
          id: nextId(),
          userId: args.data.userId,
          type: args.data.type,
          albumId: args.data.albumId,
          listenId: args.data.listenId ?? null,
          reviewId: args.data.reviewId ?? null,
          ratingId: args.data.ratingId ?? null,
          payload: args.data.payload ?? null,
        };
        activity.push(row);
        return row;
      },
      async deleteMany(args: {
        where: { listenId?: string; reviewId?: string; ratingId?: string };
      }): Promise<{ count: number }> {
        const { listenId, reviewId, ratingId } = args.where;
        let count = 0;
        for (let i = activity.length - 1; i >= 0; i -= 1) {
          const row = activity[i];
          if (
            (listenId !== undefined && row.listenId === listenId) ||
            (reviewId !== undefined && row.reviewId === reviewId) ||
            (ratingId !== undefined && row.ratingId === ratingId)
          ) {
            activity.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      },
      async updateMany(args: {
        where: { ratingId?: string; type?: string };
        data: { payload: unknown };
      }): Promise<{ count: number }> {
        let count = 0;
        for (const row of activity) {
          if (
            (args.where.ratingId === undefined ||
              row.ratingId === args.where.ratingId) &&
            (args.where.type === undefined || row.type === args.where.type)
          ) {
            row.payload = args.data.payload;
            count += 1;
          }
        }
        return { count };
      },
    },
  };

  return {
    service: { client } as unknown as PrismaService,
    // Exposed (in addition to `service`) so race-condition tests can
    // monkey-patch a single model method per test to simulate a concurrent
    // writer completing between a pre-check and the write it guards.
    client,
    users,
    albums,
    listens,
    ratings,
    reviews,
    activity,
  };
}

describe("TrackingService", () => {
  let service: TrackingService;
  let fake: ReturnType<typeof createFakePrisma>;
  let recoQueue: ReturnType<typeof createRecoQueueStub>;

  beforeEach(() => {
    fake = createFakePrisma();
    recoQueue = createRecoQueueStub();
    fake.users.set("clerk_1", "user_1");
    fake.albums.add(ALBUM_ID);
    fake.albums.add(OTHER_ALBUM_ID);
    service = new TrackingService(fake.service, recoQueue.queue);
  });

  describe("markListened", () => {
    it("creates a Listen and a LISTEN ActivityEvent", async () => {
      const result = await service.markListened("clerk_1", ALBUM_ID);

      expect(result.created).toBe(true);
      expect(fake.listens).toHaveLength(1);
      expect(fake.activity).toHaveLength(1);
      expect(fake.activity[0]).toMatchObject({
        type: "LISTEN",
        albumId: ALBUM_ID,
        listenId: result.id,
      });
    });

    it("is idempotent: re-marking creates no duplicate Listen or event", async () => {
      const first = await service.markListened("clerk_1", ALBUM_ID);
      const second = await service.markListened("clerk_1", ALBUM_ID);

      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
      expect(fake.listens).toHaveLength(1);
      expect(fake.activity).toHaveLength(1);
    });

    it("triggers a debounced recommendation refresh on a new listen (PR11 tracking trigger)", async () => {
      await service.markListened("clerk_1", ALBUM_ID);
      expect(recoQueue.enqueueDebouncedGeneration).toHaveBeenCalledWith("user_1");
    });

    it("does not re-trigger recommendations on an idempotent re-mark", async () => {
      await service.markListened("clerk_1", ALBUM_ID);
      recoQueue.enqueueDebouncedGeneration.mockClear();
      await service.markListened("clerk_1", ALBUM_ID);
      expect(recoQueue.enqueueDebouncedGeneration).not.toHaveBeenCalled();
    });

    it("still records the listen when the recommendation trigger throws (best-effort)", async () => {
      recoQueue.enqueueDebouncedGeneration.mockRejectedValueOnce(
        new Error("redis down"),
      );
      const result = await service.markListened("clerk_1", ALBUM_ID);
      expect(result.created).toBe(true);
      expect(fake.listens).toHaveLength(1);
    });

    it("404s when the album does not exist", async () => {
      await expect(
        service.markListened("clerk_1", "55555555-5555-4555-8555-555555555555"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.listens).toHaveLength(0);
    });

    it("404s when the session has no local user", async () => {
      await expect(
        service.markListened("clerk_ghost", ALBUM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("tags the no-local-user 404 with a stable machine-readable code", async () => {
      // The client (apps/web/lib/albums.ts) relies on this exact `code` to
      // show a friendly "still syncing" message instead of the raw string
      // below — a regression here would silently revert to the confusing
      // message judgment-day PR9 round 2/3 fixed.
      await expect(
        service.markListened("clerk_ghost", ALBUM_ID),
      ).rejects.toMatchObject({
        response: { code: "ACCOUNT_NOT_SYNCED" },
      });
    });

    it("400s a malformed album id before any write", async () => {
      await expect(
        service.markListened("clerk_1", "not-a-uuid"),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.listens).toHaveLength(0);
    });
  });

  describe("deleteListen", () => {
    it("removes the listen and its ActivityEvent(s)", async () => {
      const listen = await service.markListened("clerk_1", ALBUM_ID);
      expect(fake.activity).toHaveLength(1);

      await service.deleteListen("clerk_1", listen.id);

      expect(fake.listens).toHaveLength(0);
      expect(fake.activity).toHaveLength(0);
    });

    it("404s when the listen belongs to another user", async () => {
      fake.users.set("clerk_2", "user_2");
      const listen = await service.markListened("clerk_1", ALBUM_ID);

      await expect(
        service.deleteListen("clerk_2", listen.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.listens).toHaveLength(1);
    });

    it("treats a concurrent double-delete as already deleted instead of a raw 500 (P2025 race, judgment-day PR8 round 2)", async () => {
      const listen = await service.markListened("clerk_1", ALBUM_ID);

      const originalDelete = fake.client.listen.delete;
      fake.client.listen.delete = async (args) => {
        // Simulate a concurrent deleteListen call (e.g. a double-clicked
        // delete button) removing the row first: by the time THIS
        // transaction reaches `tx.listen.delete`, the row is already gone,
        // so the fake's own not-found check throws P2025 below — exactly
        // like the real driver would.
        const index = fake.listens.findIndex((r) => r.id === args.where.id);
        if (index !== -1) {
          fake.listens.splice(index, 1);
        }
        return originalDelete(args);
      };

      await expect(service.deleteListen("clerk_1", listen.id)).resolves.toEqual(
        { id: listen.id },
      );
      expect(fake.listens).toHaveLength(0);
    });
  });

  describe("rateAlbum", () => {
    it("rejects an out-of-range score with the exact contract message, writing nothing", async () => {
      await expect(
        service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 11 }),
      ).rejects.toThrow(SCORE_RANGE_ERROR);
      await expect(
        service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.ratings).toHaveLength(0);
      expect(fake.activity).toHaveLength(0);
    });

    it("rejects a non-integer score", async () => {
      await expect(
        service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 7.5 }),
      ).rejects.toThrow(SCORE_RANGE_ERROR);
    });

    it("creates a Rating + RATING ActivityEvent and reflects the aggregate", async () => {
      const result = await service.rateAlbum("clerk_1", {
        albumId: ALBUM_ID,
        score: 8,
      });

      expect(result.created).toBe(true);
      expect(result.score).toBe(8);
      expect(result.aggregate).toEqual({ average: 8, count: 1 });
      expect(fake.activity).toHaveLength(1);
      expect(fake.activity[0]).toMatchObject({
        type: "RATING",
        ratingId: fake.ratings[0].id,
        payload: { score: 8 },
      });
    });

    it("edits the rating in place, keeps the event snapshot in sync, and the aggregate reflects it", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 6 });
      const result = await service.rateAlbum("clerk_1", {
        albumId: ALBUM_ID,
        score: 9,
      });

      expect(result.created).toBe(false);
      expect(fake.ratings).toHaveLength(1);
      expect(fake.ratings[0].score).toBe(9);
      expect(result.aggregate).toEqual({ average: 9, count: 1 });
      // No duplicate event, and its score snapshot was updated.
      expect(fake.activity).toHaveLength(1);
      expect(fake.activity[0].payload).toEqual({ score: 9 });
    });

    it("recovers from a concurrent create race instead of a raw 500: a competing rateAlbum call wins the composite-PK insert first (P2002 race, judgment-day PR8 round 2)", async () => {
      const originalFindUnique = fake.client.rating.findUnique;
      fake.client.rating.findUnique = async (args) => {
        const result = await originalFindUnique(args);
        if (result === null) {
          // Simulate a concurrent rateAlbum call for the same (user, album)
          // completing its own create() between OUR pre-check (this call,
          // which correctly saw no existing row) and OUR create() below.
          const { userId, albumId } = args.where.userId_albumId;
          fake.ratings.push({
            id: "concurrent-rating-id",
            userId,
            albumId,
            score: 4,
          });
        }
        return result;
      };

      const result = await service.rateAlbum("clerk_1", {
        albumId: ALBUM_ID,
        score: 8,
      });

      // Returns the concurrent winner's row rather than throwing — this
      // call's own create() lost the race and hit P2002.
      expect(result.created).toBe(false);
      expect(result.score).toBe(4);
      expect(fake.ratings).toHaveLength(1);
    });

    it("recovers from a concurrent update race instead of a raw 500: a competing deleteRating call removes the row first (P2025 race, judgment-day PR8 round 3)", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 6 });

      const originalUpdate = fake.client.rating.update;
      fake.client.rating.update = async (args) => {
        // Simulate a concurrent deleteRating call (e.g. a double-clicked
        // delete button) removing the row first: by the time THIS
        // transaction reaches `tx.rating.update`, the row is already gone,
        // so the fake's own not-found check throws P2025 below — exactly
        // like the real driver would.
        const { userId, albumId } = args.where.userId_albumId;
        const index = fake.ratings.findIndex(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        if (index !== -1) {
          fake.ratings.splice(index, 1);
        }
        return originalUpdate(args);
      };

      const result = await service.rateAlbum("clerk_1", {
        albumId: ALBUM_ID,
        score: 9,
      });

      // Recovers by creating the row fresh rather than throwing a raw
      // PrismaClientKnownRequestError — the old row is genuinely gone, so
      // this call's own intent ("set my rating to 9") is realized via create.
      expect(result.created).toBe(true);
      expect(result.score).toBe(9);
      expect(fake.ratings).toHaveLength(1);
      expect(fake.ratings[0].score).toBe(9);
    });

    it("recovers from a race within the race-recovery instead of a raw 500: a second concurrent writer wins the retry-create fallback first (P2025-then-P2002 race, judgment-day PR8 round 4)", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 6 });

      const originalUpdate = fake.client.rating.update;
      fake.client.rating.update = async (args) => {
        // Same as the round 3 test above: a concurrent deleteRating call
        // removes the row first, so `tx.rating.update` throws P2025 and
        // `rateAlbum` falls back to its P2025-recovery retry create.
        const { userId, albumId } = args.where.userId_albumId;
        const index = fake.ratings.findIndex(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        if (index !== -1) {
          fake.ratings.splice(index, 1);
        }
        return originalUpdate(args);
      };

      const originalCreate = fake.client.rating.create;
      fake.client.rating.create = async (args) => {
        // Simulate a SECOND concurrent writer that also lost its update to
        // this same delete and reached this exact retry-create fallback
        // first: by the time OUR retry `tx.rating.create` runs, the row
        // already exists again, so the fake's own unique-constraint check
        // throws P2002 below — exactly like the real driver would
        // (judgment-day PR8 round 4, issue #1).
        fake.ratings.push({
          id: "concurrent-retry-winner-id",
          userId: args.data.userId,
          albumId: args.data.albumId,
          score: 7,
        });
        return originalCreate(args);
      };

      const result = await service.rateAlbum("clerk_1", {
        albumId: ALBUM_ID,
        score: 9,
      });

      // Recovers by re-fetching the concurrent retry-winner's row rather
      // than letting a raw PrismaClientKnownRequestError propagate — this
      // call's own retry create lost the race and hit P2002.
      expect(result.created).toBe(false);
      expect(result.score).toBe(7);
      expect(fake.ratings).toHaveLength(1);
    });
  });

  describe("deleteRating", () => {
    it("explicitly deletes the associated RATING ActivityEvent — no orphan with a null ratingId remains", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });
      expect(fake.activity).toHaveLength(1);

      const result = await service.deleteRating("clerk_1", ALBUM_ID);

      expect(result.deletedActivityEvents).toBe(1);
      expect(fake.ratings).toHaveLength(0);
      // The cleanup is EXPLICIT (Decision #12): the event is gone, not left
      // behind with a SetNull'd ratingId.
      expect(fake.activity).toHaveLength(0);
      expect(
        fake.activity.some((e) => e.type === "RATING" && e.ratingId === null),
      ).toBe(false);
    });

    it("also removes an attached review and its events (schema FK dependency)", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });
      await service.writeReview("clerk_1", {
        albumId: ALBUM_ID,
        body: "A landmark record.",
      });
      expect(fake.reviews).toHaveLength(1);
      expect(fake.activity).toHaveLength(2); // RATING + REVIEW

      const result = await service.deleteRating("clerk_1", ALBUM_ID);

      expect(result.reviewDeleted).toBe(true);
      expect(fake.reviews).toHaveLength(0);
      expect(fake.ratings).toHaveLength(0);
      expect(fake.activity).toHaveLength(0);
    });

    it("deletes the review BEFORE the rating — load-bearing for the review->rating FK's ON DELETE RESTRICT (judgment-day PR8 round 2, issue #2)", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });
      await service.writeReview("clerk_1", {
        albumId: ALBUM_ID,
        body: "A landmark record.",
      });

      // The fake's `rating.delete` enforces the real migration's
      // `reviews_user_id_album_id_fkey ... ON DELETE RESTRICT`: it throws a
      // P2003 if a review row still references the rating being deleted.
      // `deleteRating` only passes because it deletes the review FIRST — if
      // a future edit reordered those two deletes, this assertion would fail
      // with that simulated FK violation instead of silently passing.
      await expect(
        service.deleteRating("clerk_1", ALBUM_ID),
      ).resolves.toMatchObject({ reviewDeleted: true });
      expect(fake.reviews).toHaveLength(0);
      expect(fake.ratings).toHaveLength(0);
    });

    it("only touches the caller's rating for that album, leaving others intact", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });
      await service.rateAlbum("clerk_1", { albumId: OTHER_ALBUM_ID, score: 5 });

      await service.deleteRating("clerk_1", ALBUM_ID);

      expect(fake.ratings).toHaveLength(1);
      expect(fake.ratings[0].albumId).toBe(OTHER_ALBUM_ID);
      expect(fake.activity).toHaveLength(1);
      expect(fake.activity[0].albumId).toBe(OTHER_ALBUM_ID);
    });

    it("scopes the ActivityEvent cleanup to the caller's own rating (ratingId-scoped `deleteMany`), leaving another user's rating on the SAME album intact — two-row disambiguation", async () => {
      fake.users.set("clerk_2", "user_2");
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });
      await service.rateAlbum("clerk_2", { albumId: ALBUM_ID, score: 5 });
      expect(fake.activity).toHaveLength(2);

      await service.deleteRating("clerk_1", ALBUM_ID);

      expect(fake.ratings).toHaveLength(1);
      expect(fake.ratings[0].userId).toBe("user_2");
      expect(fake.activity).toHaveLength(1);
      expect(fake.activity[0].userId).toBe("user_2");
    });

    it("404s when the caller has no rating for the album", async () => {
      await expect(
        service.deleteRating("clerk_1", ALBUM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("treats a concurrent double-delete as already deleted instead of a raw 500 (P2025 race, judgment-day PR8 round 2)", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });

      const originalDelete = fake.client.rating.delete;
      fake.client.rating.delete = async (args) => {
        // Simulate a concurrent deleteRating call (e.g. a double-clicked
        // delete button) removing the row first: by the time THIS
        // transaction reaches `tx.rating.delete`, the row is already gone,
        // so the fake's own not-found check throws P2025 below — exactly
        // like the real driver would.
        const { userId, albumId } = args.where.userId_albumId;
        const index = fake.ratings.findIndex(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        if (index !== -1) {
          fake.ratings.splice(index, 1);
        }
        return originalDelete(args);
      };

      await expect(service.deleteRating("clerk_1", ALBUM_ID)).resolves.toEqual({
        albumId: ALBUM_ID,
        deletedActivityEvents: 0,
        reviewDeleted: false,
      });
    });
  });

  describe("writeReview", () => {
    it("requires an existing rating (schema FK) and rejects otherwise", async () => {
      await expect(
        service.writeReview("clerk_1", { albumId: ALBUM_ID, body: "great" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.reviews).toHaveLength(0);
    });

    it("creates a Review + REVIEW ActivityEvent once the album is rated", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });
      const result = await service.writeReview("clerk_1", {
        albumId: ALBUM_ID,
        body: "  A landmark record.  ",
      });

      expect(result.created).toBe(true);
      expect(result.body).toBe("A landmark record.");
      expect(fake.reviews).toHaveLength(1);
      expect(fake.activity.filter((e) => e.type === "REVIEW")).toHaveLength(1);
    });

    it("updates the review body in place without duplicating the event", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });
      await service.writeReview("clerk_1", { albumId: ALBUM_ID, body: "v1" });
      const result = await service.writeReview("clerk_1", {
        albumId: ALBUM_ID,
        body: "v2",
      });

      expect(result.created).toBe(false);
      expect(fake.reviews).toHaveLength(1);
      expect(fake.reviews[0].body).toBe("v2");
      expect(fake.activity.filter((e) => e.type === "REVIEW")).toHaveLength(1);
    });

    it("rejects an empty review body", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });
      await expect(
        service.writeReview("clerk_1", { albumId: ALBUM_ID, body: "   " }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("recovers from a concurrent create race instead of a raw 500: a competing writeReview call wins the unique-constraint insert first (P2002 race, judgment-day PR8 round 2)", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });

      const originalFindUnique = fake.client.review.findUnique;
      fake.client.review.findUnique = async (args) => {
        const result = await originalFindUnique(args);
        if (result === null) {
          // Simulate a concurrent writeReview call for the same (user,
          // album) completing its own create() between OUR pre-check (this
          // call, which correctly saw no existing row) and OUR create()
          // below.
          const { userId, albumId } = args.where.userId_albumId;
          fake.reviews.push({
            id: "concurrent-review-id",
            userId,
            albumId,
            body: "The concurrent winner's review.",
          });
        }
        return result;
      };

      const result = await service.writeReview("clerk_1", {
        albumId: ALBUM_ID,
        body: "My own review.",
      });

      // Returns the concurrent winner's row rather than throwing — this
      // call's own create() lost the race and hit P2002.
      expect(result.created).toBe(false);
      expect(result.body).toBe("The concurrent winner's review.");
      expect(fake.reviews).toHaveLength(1);
    });

    it("recovers from a concurrent update race instead of a raw 500: a competing delete removes the row first (P2025 race, judgment-day PR8 round 3)", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });
      await service.writeReview("clerk_1", { albumId: ALBUM_ID, body: "v1" });

      const originalUpdate = fake.client.review.update;
      fake.client.review.update = async (args) => {
        // Simulate a concurrent deleteRating call (which also deletes the
        // review, per Decision #12's FK-driven cleanup order) removing the
        // row first: by the time THIS transaction reaches
        // `tx.review.update`, the row is already gone, so the fake's own
        // not-found check throws P2025 below — exactly like the real driver
        // would.
        const { userId, albumId } = args.where.userId_albumId;
        const index = fake.reviews.findIndex(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        if (index !== -1) {
          fake.reviews.splice(index, 1);
        }
        return originalUpdate(args);
      };

      const result = await service.writeReview("clerk_1", {
        albumId: ALBUM_ID,
        body: "v2",
      });

      // Recovers by creating the row fresh rather than throwing a raw
      // PrismaClientKnownRequestError — the old row is genuinely gone, so
      // this call's own intent ("set my review to v2") is realized via
      // create.
      expect(result.created).toBe(true);
      expect(result.body).toBe("v2");
      expect(fake.reviews).toHaveLength(1);
      expect(fake.reviews[0].body).toBe("v2");
    });

    it("recovers from a race within the race-recovery instead of a raw 500: a second concurrent writer wins the retry-create fallback first (P2025-then-P2002 race, judgment-day PR8 round 4)", async () => {
      await service.rateAlbum("clerk_1", { albumId: ALBUM_ID, score: 8 });
      await service.writeReview("clerk_1", { albumId: ALBUM_ID, body: "v1" });

      const originalUpdate = fake.client.review.update;
      fake.client.review.update = async (args) => {
        // Same as the round 3 test above: a concurrent deleteRating call
        // (which also deletes the review, per Decision #12's FK-driven
        // cleanup order) removes the row first, so `tx.review.update` throws
        // P2025 and `writeReview` falls back to its P2025-recovery retry
        // create.
        const { userId, albumId } = args.where.userId_albumId;
        const index = fake.reviews.findIndex(
          (r) => r.userId === userId && r.albumId === albumId,
        );
        if (index !== -1) {
          fake.reviews.splice(index, 1);
        }
        return originalUpdate(args);
      };

      const originalCreate = fake.client.review.create;
      fake.client.review.create = async (args) => {
        // Simulate a SECOND concurrent writer that also lost its update to
        // this same delete and reached this exact retry-create fallback
        // first: by the time OUR retry `tx.review.create` runs, the row
        // already exists again, so the fake's own unique-constraint check
        // throws P2002 below — exactly like the real driver would
        // (judgment-day PR8 round 4, issue #1).
        fake.reviews.push({
          id: "concurrent-retry-winner-id",
          userId: args.data.userId,
          albumId: args.data.albumId,
          body: "The concurrent retry-winner's review.",
        });
        return originalCreate(args);
      };

      const result = await service.writeReview("clerk_1", {
        albumId: ALBUM_ID,
        body: "v2",
      });

      // Recovers by re-fetching the concurrent retry-winner's row rather
      // than letting a raw PrismaClientKnownRequestError propagate — this
      // call's own retry create lost the race and hit P2002.
      expect(result.created).toBe(false);
      expect(result.body).toBe("The concurrent retry-winner's review.");
      expect(fake.reviews).toHaveLength(1);
    });
  });
});
