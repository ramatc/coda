import { beforeEach, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { NotificationType } from "@coda/db";
import { COMMENT_EXCERPT_LENGTH } from "../src/notifications/notifications.constants.js";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const CLERK_ID = "clerk_recipient";
const RECIPIENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW_ID = "77777777-7777-4777-8777-777777777777";

/** The actor profile projection nested inside the notification select. */
interface ActorProfile {
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** A notification row in the shape {@link NotificationsService.list} selects it. */
interface NotificationRow {
  id: string;
  /**
   * Fake-only filter key. The service's own `select` never projects it — the
   * recipient scoping lives entirely in the `where`, which is exactly the
   * invariant the "never another user's notifications" test below protects.
   */
  recipientUserId: string;
  type: NotificationType;
  createdAt: Date;
  readAt: Date | null;
  /**
   * `actor` is a required FK so the relation object always exists, but
   * `Profile` is optional on `User`, so the nested profile can be `null` —
   * the degrade case asserted below.
   */
  actor: { profile: ActorProfile | null };
  /** Present only for COMMENT notifications (`Cascade`-deleted with the comment). */
  reviewComment: { reviewId: string; body: string } | null;
}

const ACTOR: ActorProfile = {
  username: "ana",
  displayName: "Ana Torres",
  avatarUrl: "https://cdn.coda.test/ana.jpg",
};

/** The exact `orderBy` clause {@link NotificationsService.list} must send. */
const EXPECTED_ORDER_BY = [{ createdAt: "desc" }, { id: "desc" }];

/**
 * Fails loudly if the service sends anything other than
 * {@link EXPECTED_ORDER_BY}. Without this, the fake's own hard-coded sort
 * would mask a dropped, reversed, or tie-break-less `orderBy` from the real
 * query — see the "tie-breaks two notifications..." test below, which relies
 * on this assertion actually exercising the argument the service passes.
 */
function assertExpectedOrderBy(orderBy: unknown): void {
  if (JSON.stringify(orderBy) !== JSON.stringify(EXPECTED_ORDER_BY)) {
    throw new Error(
      `notification.findMany received unexpected orderBy: ${JSON.stringify(orderBy)}`,
    );
  }
}

/**
 * In-memory Prisma stand-in honouring the exact read queries
 * {@link NotificationsService} issues: `user.findUnique` by clerk id,
 * `notification.findMany` filtered by `{ recipientUserId }` with
 * `[{ createdAt desc }, { id desc }]` ordering, `take` and an optional
 * `cursor`+`skip`, and `notification.count` over unread rows. Proves the read
 * surface deterministically without a live Postgres (the project's no-docker
 * sandbox convention, mirroring `activity.service.spec.ts`).
 */
function createFakePrisma() {
  const users = new Map<string, string>();
  const notifications: NotificationRow[] = [];

  /** The caller's own rows, in the service's `[createdAt desc, id desc]` order. */
  function ownedBy(recipientUserId: string): NotificationRow[] {
    return notifications
      .filter((n) => n.recipientUserId === recipientUserId)
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) return byTime;
        // id descending, matching the service's secondary sort.
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
  }

  const client = {
    user: {
      async findUnique(args: {
        where: { clerkUserId: string };
      }): Promise<{ id: string } | null> {
        const id = users.get(args.where.clerkUserId);
        return id ? { id } : null;
      },
    },
    notification: {
      async findMany(args: {
        where: { recipientUserId: string };
        orderBy: unknown;
        take: number;
        cursor?: { id: string };
        skip?: number;
      }): Promise<NotificationRow[]> {
        assertExpectedOrderBy(args.orderBy);
        let rows = ownedBy(args.where.recipientUserId);
        if (args.cursor) {
          const idx = rows.findIndex((r) => r.id === args.cursor?.id);
          // Real Prisma resolves the cursor anchor via a scalar comparison that
          // is NULL when no row matches, so an unknown-but-well-formed cursor
          // yields an empty page rather than throwing (same semantics the
          // activity/feed fakes mirror). Do NOT silently fall back to "no
          // cursor" — that would mask a real correctness gap in this fake.
          rows = idx >= 0 ? rows.slice(idx + (args.skip ?? 0)) : [];
        }
        return rows.slice(0, args.take);
      },
      async count(args: {
        where: { recipientUserId: string; readAt: null };
      }): Promise<number> {
        return ownedBy(args.where.recipientUserId).filter(
          (n) => n.readAt === args.where.readAt,
        ).length;
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    users,
    notifications,
  };
}

function push(
  fake: ReturnType<typeof createFakePrisma>,
  overrides: Partial<NotificationRow> &
    Pick<NotificationRow, "id" | "type" | "createdAt">,
): void {
  fake.notifications.push({
    recipientUserId: RECIPIENT_ID,
    readAt: null,
    actor: { profile: ACTOR },
    reviewComment: null,
    ...overrides,
  });
}

describe("NotificationsService (read surface)", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let service: NotificationsService;

  beforeEach(() => {
    fake = createFakePrisma();
    service = new NotificationsService(fake.prisma);
    fake.users.set(CLERK_ID, RECIPIENT_ID);
  });

  it("returns the caller's notifications newest-first, discriminating COMMENT link data from FOLLOW", async () => {
    push(fake, {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    push(fake, {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
      type: NotificationType.COMMENT,
      createdAt: new Date("2026-08-02T10:00:00.000Z"),
      reviewComment: { reviewId: REVIEW_ID, body: "This record rules." },
    });

    const page = await service.list(CLERK_ID);

    expect(page.items).toHaveLength(2);
    // Most recent (the comment) first.
    expect(page.items[0].type).toBe(NotificationType.COMMENT);
    expect(page.items[0].reviewId).toBe(REVIEW_ID);
    expect(page.items[0].commentExcerpt).toBe("This record rules.");
    expect(page.items[0].createdAt).toBe("2026-08-02T10:00:00.000Z");
    expect(page.items[0].readAt).toBeNull();
    expect(page.items[0].actor).toEqual(ACTOR);
    // A FOLLOW notification carries no target FK at all (design Decision 1),
    // so both COMMENT-only projections must be null rather than empty strings.
    expect(page.items[1].type).toBe(NotificationType.FOLLOW);
    expect(page.items[1].reviewId).toBeNull();
    expect(page.items[1].commentExcerpt).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it("carries the unread count alongside the page, ignoring already-read rows", async () => {
    push(fake, {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
      readAt: new Date("2026-08-03T09:00:00.000Z"),
    });
    push(fake, {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-02T10:00:00.000Z"),
    });

    const page = await service.list(CLERK_ID);

    // Both rows are listed; only the unread one counts toward the badge, and
    // the read row round-trips its `readAt` as an ISO string.
    expect(page.items).toHaveLength(2);
    expect(page.unreadCount).toBe(1);
    expect(page.items[1].readAt).toBe("2026-08-03T09:00:00.000Z");
  });

  it("never includes another user's notifications", async () => {
    push(fake, {
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    push(fake, {
      id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
      recipientUserId: OTHER_USER_ID,
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-05T10:00:00.000Z"),
    });

    const page = await service.list(CLERK_ID);

    expect(page.items.map((i) => i.id)).toEqual([
      "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    ]);
    expect(page.unreadCount).toBe(1);
  });

  it("cursor-paginates: the first page yields a nextCursor, the next page resumes after it", async () => {
    const ids = [
      "dddddddd-dddd-4ddd-8ddd-ddddddddddd1",
      "dddddddd-dddd-4ddd-8ddd-ddddddddddd2",
      "dddddddd-dddd-4ddd-8ddd-ddddddddddd3",
    ];
    ids.forEach((id, i) => {
      push(fake, {
        id,
        type: NotificationType.FOLLOW,
        // Older as the index grows, so ids[0] is newest.
        createdAt: new Date(2026, 7, 10 - i, 10, 0, 0),
      });
    });

    const first = await service.list(CLERK_ID, { limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual([ids[0], ids[1]]);
    expect(first.nextCursor).toBe(ids[1]);

    const second = await service.list(CLERK_ID, {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((i) => i.id)).toEqual([ids[2]]);
    expect(second.nextCursor).toBeNull();
  });

  it("tie-breaks two notifications sharing the exact same createdAt by id desc, even across a page boundary", async () => {
    // Two notifications minted in the same request (e.g. a burst of comments)
    // share a createdAt; the id-desc secondary sort is what stops the cursor
    // from skipping or repeating one of them at the split.
    const SAME_TIME = new Date("2026-08-04T10:00:00.000Z");
    const idHigh = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2";
    const idLow = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
    const idOlder = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0";

    push(fake, {
      id: idLow,
      type: NotificationType.FOLLOW,
      createdAt: SAME_TIME,
    });
    push(fake, {
      id: idHigh,
      type: NotificationType.FOLLOW,
      createdAt: SAME_TIME,
    });
    push(fake, {
      id: idOlder,
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-03T10:00:00.000Z"),
    });

    // limit: 1 forces the page boundary to fall exactly between the tied rows.
    const first = await service.list(CLERK_ID, { limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual([idHigh]);

    const second = await service.list(CLERK_ID, {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((i) => i.id)).toEqual([idLow]);

    const third = await service.list(CLERK_ID, {
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

  it("degrades the actor's fields to empty values when the Profile row is missing", async () => {
    push(fake, {
      id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-06T10:00:00.000Z"),
      actor: { profile: null },
    });

    const page = await service.list(CLERK_ID);

    // `actor` stays a non-null object (the FK is required); only its fields
    // degrade — same fallback as the feed's `toFeedItem` and reviews' `toAuthor`.
    expect(page.items[0].actor).toEqual({
      username: "",
      displayName: "",
      avatarUrl: null,
    });
  });

  it("trims a long comment body to the excerpt length and leaves a short one intact", async () => {
    const long = "z".repeat(COMMENT_EXCERPT_LENGTH + 40);
    push(fake, {
      id: "ffffffff-ffff-4fff-8fff-fffffffffff2",
      type: NotificationType.COMMENT,
      createdAt: new Date("2026-08-07T10:00:00.000Z"),
      reviewComment: { reviewId: REVIEW_ID, body: long },
    });
    push(fake, {
      id: "ffffffff-ffff-4fff-8fff-fffffffffff3",
      type: NotificationType.COMMENT,
      createdAt: new Date("2026-08-06T10:00:00.000Z"),
      reviewComment: { reviewId: REVIEW_ID, body: "Short." },
    });

    const page = await service.list(CLERK_ID);

    expect(page.items[0].commentExcerpt).toBe(
      "z".repeat(COMMENT_EXCERPT_LENGTH),
    );
    expect(page.items[1].commentExcerpt).toBe("Short.");
  });

  it("degrades to an empty page (never a 404) when the local user is not synced yet", async () => {
    fake.users.clear(); // no local User row for CLERK_ID
    // A row that WOULD match if the caller resolved, proving the empty result
    // comes from the unsynced short-circuit and not from an empty table.
    push(fake, {
      id: "99999999-9999-4999-8999-999999999991",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    const page = await service.list(CLERK_ID);

    expect(page).toEqual({ items: [], nextCursor: null, unreadCount: 0 });
  });

  it("returns an empty page (not a crash) for a well-formed cursor id that matches no row", async () => {
    push(fake, {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    const page = await service.list(CLERK_ID, {
      cursor: "99999999-9999-4999-8999-999999999999",
    });

    // The page is empty because the anchor row does not exist, but the badge
    // count still reflects the caller's real unread rows.
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.unreadCount).toBe(1);
  });

  it("rejects a malformed cursor with a 400", async () => {
    await expect(
      service.list(CLERK_ID, { cursor: "not-a-uuid" }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a non-positive limit with a 400", async () => {
    await expect(service.list(CLERK_ID, { limit: 0 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("counts only the caller's own unread notifications", async () => {
    push(fake, {
      id: "88888888-8888-4888-8888-888888888881",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    push(fake, {
      id: "88888888-8888-4888-8888-888888888882",
      type: NotificationType.COMMENT,
      createdAt: new Date("2026-08-02T10:00:00.000Z"),
      reviewComment: { reviewId: REVIEW_ID, body: "Nice." },
    });
    push(fake, {
      id: "88888888-8888-4888-8888-888888888883",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-03T10:00:00.000Z"),
      readAt: new Date("2026-08-04T10:00:00.000Z"),
    });
    push(fake, {
      id: "88888888-8888-4888-8888-888888888884",
      recipientUserId: OTHER_USER_ID,
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-03T10:00:00.000Z"),
    });

    expect(await service.getUnreadCount(CLERK_ID)).toEqual({ unreadCount: 2 });
  });

  it("reports zero unread (never a 404) when the local user is not synced yet", async () => {
    fake.users.clear();
    push(fake, {
      id: "88888888-8888-4888-8888-888888888885",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    expect(await service.getUnreadCount(CLERK_ID)).toEqual({ unreadCount: 0 });
  });
});
