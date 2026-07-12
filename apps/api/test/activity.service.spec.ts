import { beforeEach, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { ActivityType } from "@coda/db";
import { ActivityService } from "../src/activity/activity.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const CLERK_ID = "clerk_1";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "55555555-5555-4555-8555-555555555555";
const ALBUM_ID = "33333333-3333-4333-8333-333333333333";

/** An activity-event row in the shape {@link ActivityService} selects it. */
interface EventRow {
  id: string;
  userId: string;
  type: ActivityType;
  occurredAt: Date;
  payload: unknown;
  album: {
    id: string;
    title: string;
    coverUrl: string | null;
    primaryArtist: { name: string };
  };
  review: { body: string } | null;
}

const ALBUM = {
  id: ALBUM_ID,
  title: "OK Computer",
  coverUrl: "https://cdn.coda.test/ok.jpg",
  primaryArtist: { name: "Radiohead" },
};

/**
 * In-memory Prisma stand-in honouring the exact read query
 * {@link ActivityService} issues: `user.findUnique` by clerk id, and
 * `activityEvent.findMany` with a `{ userId }` filter, `[{ occurredAt desc },
 * { id desc }]` ordering, `take`, and optional `cursor`+`skip`. Proves the
 * personal stream deterministically without a live Postgres (PR1-9 no-docker
 * sandbox convention).
 */
function createFakePrisma() {
  const users = new Map<string, string>();
  const events: EventRow[] = [];

  const client = {
    user: {
      async findUnique(args: {
        where: { clerkUserId: string };
      }): Promise<{ id: string } | null> {
        const id = users.get(args.where.clerkUserId);
        return id ? { id } : null;
      },
    },
    activityEvent: {
      async findMany(args: {
        where: { userId: string };
        take: number;
        cursor?: { id: string };
        skip?: number;
      }): Promise<EventRow[]> {
        let rows = events
          .filter((e) => e.userId === args.where.userId)
          .sort((a, b) => {
            const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
            if (byTime !== 0) return byTime;
            // id descending, matching the service's secondary sort.
            return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
          });
        if (args.cursor) {
          const idx = rows.findIndex((r) => r.id === args.cursor?.id);
          // Real Prisma resolves a cursor's anchor row via a scalar subquery
          // comparison; when no row matches the cursor id, that comparison is
          // NULL against every row, so the WHERE clause matches nothing and
          // findMany resolves to an empty array rather than throwing (verified
          // against Prisma's documented cursor semantics — see
          // ActivityService's `resolveCursor` doc comment). Mirror that here
          // rather than silently falling back to "no cursor" (which would mask
          // a real correctness gap in this fake).
          rows = idx >= 0 ? rows.slice(idx + (args.skip ?? 0)) : [];
        }
        return rows.slice(0, args.take);
      },
    },
  };

  return { prisma: { client } as unknown as PrismaService, users, events };
}

function pushEvent(
  fake: ReturnType<typeof createFakePrisma>,
  overrides: Partial<EventRow> & Pick<EventRow, "id" | "type" | "occurredAt">,
): void {
  fake.events.push({
    userId: USER_ID,
    payload: null,
    album: ALBUM,
    review: null,
    ...overrides,
  });
}

describe("ActivityService", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let service: ActivityService;

  beforeEach(() => {
    fake = createFakePrisma();
    service = new ActivityService(fake.prisma);
    fake.users.set(CLERK_ID, USER_ID);
  });

  it("returns the caller's own listen and rating events, most recent first", async () => {
    pushEvent(fake, {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      type: ActivityType.LISTEN,
      occurredAt: new Date("2026-07-01T10:00:00.000Z"),
    });
    pushEvent(fake, {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      type: ActivityType.RATING,
      occurredAt: new Date("2026-07-02T10:00:00.000Z"),
      payload: { score: 9 },
    });

    const page = await service.getOwnActivity(CLERK_ID);

    expect(page.items).toHaveLength(2);
    // Most recent (the rating) first.
    expect(page.items[0].type).toBe(ActivityType.RATING);
    expect(page.items[0].score).toBe(9);
    expect(page.items[0].album.id).toBe(ALBUM_ID);
    expect(page.items[0].album.primaryArtistName).toBe("Radiohead");
    expect(page.items[1].type).toBe(ActivityType.LISTEN);
    expect(page.items[1].score).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it("never includes another user's activity", async () => {
    pushEvent(fake, {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      type: ActivityType.LISTEN,
      occurredAt: new Date("2026-07-01T10:00:00.000Z"),
    });
    // Another user's event for the same album.
    pushEvent(fake, {
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      userId: OTHER_USER_ID,
      type: ActivityType.RATING,
      occurredAt: new Date("2026-07-05T10:00:00.000Z"),
      payload: { score: 10 },
    });

    const page = await service.getOwnActivity(CLERK_ID);

    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1");
  });

  it("renders a stranded event gracefully: RATING score from the payload snapshot, REVIEW body null when its review was deleted", async () => {
    // A RATING event whose Rating row was later deleted — its FK is SetNull, so
    // the event lingers with no rating relation, but the score snapshot in
    // `payload` still lets the feed render it without crashing.
    pushEvent(fake, {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      type: ActivityType.RATING,
      occurredAt: new Date("2026-07-03T10:00:00.000Z"),
      payload: { score: 7 },
      review: null,
    });
    // A REVIEW event whose Review row was deleted (SetNull) — body degrades to
    // null rather than throwing on a missing relation.
    pushEvent(fake, {
      id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
      type: ActivityType.REVIEW,
      occurredAt: new Date("2026-07-02T10:00:00.000Z"),
      review: null,
    });

    const page = await service.getOwnActivity(CLERK_ID);

    expect(page.items[0].type).toBe(ActivityType.RATING);
    expect(page.items[0].score).toBe(7);
    expect(page.items[0].reviewBody).toBeNull();
    expect(page.items[1].type).toBe(ActivityType.REVIEW);
    expect(page.items[1].reviewBody).toBeNull();
  });

  it("cursor-paginates: the first page yields a nextCursor, the next page resumes after it", async () => {
    const ids = [
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3",
    ];
    ids.forEach((id, i) => {
      pushEvent(fake, {
        id,
        type: ActivityType.LISTEN,
        // Older as the index grows, so the ordering is id[0] newest.
        occurredAt: new Date(2026, 6, 10 - i, 10, 0, 0),
      });
    });

    const first = await service.getOwnActivity(CLERK_ID, { limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual([ids[0], ids[1]]);
    expect(first.nextCursor).toBe(ids[1]);

    const second = await service.getOwnActivity(CLERK_ID, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((i) => i.id)).toEqual([ids[2]]);
    expect(second.nextCursor).toBeNull();
  });

  it("tie-breaks two events sharing the exact same occurredAt by id desc, even when a page boundary falls between them", async () => {
    // Two events with the identical occurredAt (e.g. a rating and its own
    // ActivityEvent, or two rapid actions in the same request) plus an older
    // third event, so the id-desc tie-break is exercised across a page split.
    const SAME_TIME = new Date("2026-07-04T10:00:00.000Z");
    const idHigh = "ffffffff-ffff-4fff-8fff-fffffffffff2"; // sorts first (id desc)
    const idLow = "ffffffff-ffff-4fff-8fff-fffffffffff1"; // tied on time, lower id
    const idOlder = "ffffffff-ffff-4fff-8fff-fffffffffff0"; // strictly older

    pushEvent(fake, {
      id: idLow,
      type: ActivityType.LISTEN,
      occurredAt: SAME_TIME,
    });
    pushEvent(fake, {
      id: idHigh,
      type: ActivityType.LISTEN,
      occurredAt: SAME_TIME,
    });
    pushEvent(fake, {
      id: idOlder,
      type: ActivityType.LISTEN,
      occurredAt: new Date("2026-07-03T10:00:00.000Z"),
    });

    // limit: 1 forces a page boundary to fall exactly between the two tied
    // (same occurredAt) events.
    const first = await service.getOwnActivity(CLERK_ID, { limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual([idHigh]);
    expect(first.nextCursor).toBe(idHigh);

    const second = await service.getOwnActivity(CLERK_ID, {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((i) => i.id)).toEqual([idLow]);
    expect(second.nextCursor).toBe(idLow);

    const third = await service.getOwnActivity(CLERK_ID, {
      limit: 1,
      cursor: second.nextCursor ?? undefined,
    });
    expect(third.items.map((i) => i.id)).toEqual([idOlder]);
    expect(third.nextCursor).toBeNull();

    // No duplicates and no gaps across the three pages.
    const allIds = [...first.items, ...second.items, ...third.items].map(
      (i) => i.id,
    );
    expect(allIds).toEqual([idHigh, idLow, idOlder]);
    expect(new Set(allIds).size).toBe(3);
  });

  it("degrades to an empty page (not an error) when the local user is not synced yet", async () => {
    fake.users.clear(); // no local User row for CLERK_ID

    const page = await service.getOwnActivity(CLERK_ID);

    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("returns an empty page (not a crash) for a well-formed cursor id that doesn't match any event", async () => {
    pushEvent(fake, {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      type: ActivityType.LISTEN,
      occurredAt: new Date("2026-07-01T10:00:00.000Z"),
    });

    // A syntactically valid UUID (passes resolveCursor's shape guard) that
    // doesn't correspond to any ActivityEvent row — e.g. a stale cursor after
    // the anchor row was removed, or a guessed value.
    const page = await service.getOwnActivity(CLERK_ID, {
      cursor: "99999999-9999-4999-8999-999999999999",
    });

    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("rejects a malformed cursor with a 400", async () => {
    await expect(
      service.getOwnActivity(CLERK_ID, { cursor: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a non-positive limit with a 400", async () => {
    await expect(
      service.getOwnActivity(CLERK_ID, { limit: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
