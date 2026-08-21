import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestException, Logger } from "@nestjs/common";
import { NotificationType, Prisma } from "@coda/db";
import { COMMENT_EXCERPT_LENGTH } from "../src/notifications/notifications.constants.js";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const CLERK_ID = "clerk_recipient";
const RECIPIENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const REVIEW_ID = "77777777-7777-4777-8777-777777777777";
const COMMENT_ID = "66666666-6666-4666-8666-666666666666";

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
  /**
   * Fake-only filter key, like `recipientUserId`. The read `select` never
   * projects it, but the Decision 17 dedup index keys on it, so the write tests
   * below need it addressable.
   */
  actorUserId: string;
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
  /** Set by a test to make the NEXT `create` fail for a non-dedup reason. */
  const control: { nextCreateError: unknown } = { nextCreateError: null };
  let seq = 0;

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
      async updateMany(args: {
        where: { recipientUserId: string; readAt: null };
        data: { readAt: Date };
      }): Promise<{ count: number }> {
        // Postgres would apply the `readAt: null` predicate as part of the
        // UPDATE's WHERE, so an already-read row is never even matched — which
        // is exactly what preserves its original timestamp. The fake filters
        // the same way rather than blanket-assigning, or the "preserves an
        // earlier readAt" test below would pass for the wrong reason.
        const matched = ownedBy(args.where.recipientUserId).filter(
          (n) => n.readAt === args.where.readAt,
        );
        for (const row of matched) {
          row.readAt = args.data.readAt;
        }
        return { count: matched.length };
      },
      async create(args: {
        data: {
          recipientUserId: string;
          actorUserId: string;
          type: NotificationType;
          reviewCommentId?: string;
        };
      }): Promise<{ id: string }> {
        if (control.nextCreateError !== null) {
          const err = control.nextCreateError;
          control.nextCreateError = null;
          throw err;
        }
        // Stands in for `notifications_active_follow_dedup_idx` — the partial
        // UNIQUE index on (recipient, actor, type) scoped to
        // `WHERE read_at IS NULL AND type = 'FOLLOW'` (design Decision 17).
        // Enforcing it HERE, inside the insert, is the whole point: the service
        // must not pre-check, so the fake has to be the arbiter exactly like
        // Postgres is. Note the scoping is faithful in both directions — an
        // already-READ FOLLOW row does not block, and COMMENT rows are not
        // constrained at all.
        const blocked =
          args.data.type === NotificationType.FOLLOW &&
          notifications.some(
            (n) =>
              n.recipientUserId === args.data.recipientUserId &&
              n.actorUserId === args.data.actorUserId &&
              n.type === NotificationType.FOLLOW &&
              n.readAt === null,
          );
        if (blocked) {
          throw followDedupConstraintError();
        }
        seq += 1;
        const row: NotificationRow = {
          id: `00000000-0000-4000-8000-00000000000${seq}`,
          recipientUserId: args.data.recipientUserId,
          actorUserId: args.data.actorUserId,
          type: args.data.type,
          createdAt: new Date("2026-08-10T12:00:00.000Z"),
          readAt: null,
          actor: { profile: ACTOR },
          reviewComment: args.data.reviewCommentId
            ? { reviewId: REVIEW_ID, body: "Great take." }
            : null,
        };
        notifications.push(row);
        return { id: row.id };
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    users,
    notifications,
    control,
  };
}

/**
 * Builds the P2002 Postgres raises when an insert collides with
 * `notifications_active_follow_dedup_idx`, in this project's Prisma 7
 * driver-adapter shape (fields on `meta.driverAdapterError.cause.constraint`,
 * never the classic `meta.target` — see `prisma-error.util.ts`).
 *
 * The reported field is the index's LEADING column, `recipient_user_id`, which
 * is what the real adapter surfaces and which discriminates NOTHING on its own.
 * That is deliberate: `notifyFollow` classifies purely on the P2002 CODE (the
 * table has exactly one non-PK unique index, so the code is unambiguous today),
 * and this error is the tripwire for anyone who later adds an
 * `extractUniqueConstraintField(err) === "..."` guard without also updating the
 * documented limitation at the catch site.
 */
function followDedupConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`recipient_user_id`,`actor_user_id`,`type`)",
    {
      code: "P2002",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["recipient_user_id"] },
          },
        },
      },
    },
  );
}

function push(
  fake: ReturnType<typeof createFakePrisma>,
  overrides: Partial<NotificationRow> &
    Pick<NotificationRow, "id" | "type" | "createdAt">,
): void {
  fake.notifications.push({
    recipientUserId: RECIPIENT_ID,
    actorUserId: ACTOR_ID,
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

/**
 * The slice's only write on this surface (design Decision 13): `read-all`, fired
 * when the web dropdown OPENS. Two properties carry the whole design here and
 * each has its own test below:
 *
 * 1. The update is SCOPED to `readAt: null`, so a row read three days ago keeps
 *    its original timestamp instead of being restamped to "now" on every open.
 *    That scoping is also what makes a second call a genuine no-op.
 * 2. The update is SCOPED to the caller's `recipientUserId`. A notification is
 *    private to its recipient, so the posture is tolerant-200 and never 403/404
 *    (design Decision 14): nothing to update is an honest success, and an
 *    unsynced caller gets the same cleared badge rather than an error that would
 *    leak whether another account's rows exist.
 */
describe("NotificationsService (mark-as-read)", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let service: NotificationsService;

  beforeEach(() => {
    fake = createFakePrisma();
    service = new NotificationsService(fake.prisma);
    fake.users.set(CLERK_ID, RECIPIENT_ID);
  });

  it("stamps every unread notification as read and reports a cleared badge", async () => {
    push(fake, {
      id: "11111111-1111-4111-8111-11111111aaa1",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    push(fake, {
      id: "11111111-1111-4111-8111-11111111aaa2",
      type: NotificationType.COMMENT,
      createdAt: new Date("2026-08-02T10:00:00.000Z"),
      reviewComment: { reviewId: REVIEW_ID, body: "Great take." },
    });
    expect(await service.getUnreadCount(CLERK_ID)).toEqual({ unreadCount: 2 });

    const result = await service.markAllRead(CLERK_ID);

    expect(result).toEqual({ unreadCount: 0 });
    // The badge is not merely asserted from the return value: re-counting proves
    // the rows themselves were written, not that the method returned a literal.
    expect(await service.getUnreadCount(CLERK_ID)).toEqual({ unreadCount: 0 });
    for (const row of fake.notifications) {
      expect(row.readAt).toBeInstanceOf(Date);
    }
  });

  it("preserves the original readAt of a row that was already read", async () => {
    const ALREADY_READ_AT = new Date("2026-08-03T09:00:00.000Z");
    push(fake, {
      id: "22222222-2222-4222-8222-22222222bbb1",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
      readAt: ALREADY_READ_AT,
    });
    push(fake, {
      id: "22222222-2222-4222-8222-22222222bbb2",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-02T10:00:00.000Z"),
    });

    await service.markAllRead(CLERK_ID);

    const [alreadyRead, wasUnread] = fake.notifications;
    // Scoping the update to `readAt: null` is what keeps this timestamp intact.
    // An unscoped `updateMany` would restamp it to "now" every time the dropdown
    // opens, silently destroying when the user actually saw it.
    expect(alreadyRead.readAt).toBe(ALREADY_READ_AT);
    expect(wasUnread.readAt).not.toBeNull();
    expect(wasUnread.readAt).not.toBe(ALREADY_READ_AT);
  });

  it("is an idempotent no-op on a second call, leaving the first timestamps intact", async () => {
    push(fake, {
      id: "33333333-3333-4333-8333-33333333ccc1",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    await service.markAllRead(CLERK_ID);
    const firstReadAt = fake.notifications[0].readAt;

    const second = await service.markAllRead(CLERK_ID);

    expect(second).toEqual({ unreadCount: 0 });
    // Nothing matched the second time, so the row is byte-identical: replaying
    // the request (a double-open of the dropdown) cannot rewrite history.
    expect(fake.notifications[0].readAt).toBe(firstReadAt);
  });

  it("never marks another user's notifications read", async () => {
    push(fake, {
      id: "44444444-4444-4444-8444-44444444ddd1",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    push(fake, {
      id: "44444444-4444-4444-8444-44444444ddd2",
      recipientUserId: OTHER_USER_ID,
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-02T10:00:00.000Z"),
    });

    await service.markAllRead(CLERK_ID);

    const [own, foreign] = fake.notifications;
    expect(own.readAt).not.toBeNull();
    // The recipient scoping lives entirely in the `where`; dropping it would
    // let one signed-in user clear the entire table's unread state.
    expect(foreign.readAt).toBeNull();
  });

  it("reports a cleared badge (never a 404) when the local user is not synced yet", async () => {
    fake.users.clear(); // no local User row for CLERK_ID
    // A row that WOULD match if the caller resolved, so the untouched `readAt`
    // below proves the short-circuit ran instead of an empty-table coincidence.
    push(fake, {
      id: "55555555-5555-4555-8555-55555555eee1",
      type: NotificationType.FOLLOW,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    const result = await service.markAllRead(CLERK_ID);

    // Tolerant 200, matching both reads (design Decision 14). An unsynced
    // account owns no notifications, so "everything you have is read" is the
    // honest answer; a 404 here would be an error posture this module
    // deliberately does not have.
    expect(result).toEqual({ unreadCount: 0 });
    expect(fake.notifications[0].readAt).toBeNull();
  });
});

/**
 * The write helpers the hook sites will call (design Decisions 4, 6 and 17).
 * Both take LOCAL user ids, not clerk ids — they are called from inside
 * `follow()` / `createComment()`, which already resolved the caller.
 *
 * **This block is UNIT-LAYER ONLY.** The dedup and "concurrent" cases below
 * assert the SERVICE's catch-logic against a fake that raises the constraint,
 * i.e. that `notifyFollow` treats a P2002 as an expected no-op instead of
 * letting it escape. They do NOT and CANNOT prove the real Postgres race — the
 * fake is single-threaded, so its "collision" is sequential by construction.
 * The genuine atomicity guarantee belongs to
 * `notifications_active_follow_dedup_idx` itself and is asserted against a live
 * database in Phase 8's dedicated integration spec.
 */
describe("NotificationsService (write surface, unit layer)", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let service: NotificationsService;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fake = createFakePrisma();
    service = new NotificationsService(fake.prisma);
    fake.users.set(CLERK_ID, RECIPIENT_ID);
    warnSpy = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates one unread FOLLOW notification addressed to the followed user", async () => {
    await service.notifyFollow(ACTOR_ID, RECIPIENT_ID);

    expect(fake.notifications).toHaveLength(1);
    const [row] = fake.notifications;
    expect(row.type).toBe(NotificationType.FOLLOW);
    expect(row.recipientUserId).toBe(RECIPIENT_ID);
    expect(row.actorUserId).toBe(ACTOR_ID);
    // A FOLLOW row carries no target FK at all (design Decision 1), and it
    // starts unread so it counts toward the recipient's badge immediately.
    expect(row.reviewComment).toBeNull();
    expect(row.readAt).toBeNull();
    expect(await service.getUnreadCount(CLERK_ID)).toEqual({ unreadCount: 1 });
  });

  it("suppresses a self-follow notification without touching the table", async () => {
    // Structurally unreachable today (`follow()` 400s a self-follow), which is
    // exactly why the guard lives in the service and not at the call site: it
    // becomes reachable the moment a second caller appears (Decision 4).
    await service.notifyFollow(RECIPIENT_ID, RECIPIENT_ID);

    expect(fake.notifications).toEqual([]);
  });

  it("creates a COMMENT notification linked to the comment that triggered it", async () => {
    await service.notifyComment(ACTOR_ID, RECIPIENT_ID, COMMENT_ID);

    expect(fake.notifications).toHaveLength(1);
    const [row] = fake.notifications;
    expect(row.type).toBe(NotificationType.COMMENT);
    expect(row.recipientUserId).toBe(RECIPIENT_ID);
    expect(row.actorUserId).toBe(ACTOR_ID);
    // The comment FK is what makes the item deep-linkable; without it the read
    // surface would render a COMMENT item with a null reviewId.
    expect(row.reviewComment).not.toBeNull();
    const page = await service.list(CLERK_ID);
    expect(page.items[0].reviewId).toBe(REVIEW_ID);
  });

  it("suppresses a self-comment notification without touching the table", async () => {
    // Unlike the follow guard this one is LIVE — self-commenting is explicitly
    // allowed by the reviews slice, so this is the branch that actually fires.
    await service.notifyComment(RECIPIENT_ID, RECIPIENT_ID, COMMENT_ID);

    expect(fake.notifications).toEqual([]);
  });

  it("does not dedup COMMENT notifications: two comments from the same actor create two rows", async () => {
    await service.notifyComment(ACTOR_ID, RECIPIENT_ID, COMMENT_ID);
    await service.notifyComment(ACTOR_ID, RECIPIENT_ID, COMMENT_ID);

    // The dedup index is scoped to `type = 'FOLLOW'`. A table-wide
    // `@@unique([recipient, actor, type])` would silently swallow every reply
    // after the first — this is the test that catches that mistake.
    expect(fake.notifications).toHaveLength(2);
    expect(await service.getUnreadCount(CLERK_ID)).toEqual({ unreadCount: 2 });
  });

  it("swallows the dedup violation when an unread FOLLOW from the same actor already exists — no row, no warning", async () => {
    await service.notifyFollow(ACTOR_ID, RECIPIENT_ID);

    await expect(
      service.notifyFollow(ACTOR_ID, RECIPIENT_ID),
    ).resolves.toBeUndefined();

    expect(fake.notifications).toHaveLength(1);
    expect(await service.getUnreadCount(CLERK_ID)).toEqual({ unreadCount: 1 });
    // A refollow-while-unread is an EXPECTED outcome, not a failure. Logging it
    // would make every normal refollow look like a production error (Decision 6).
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("creates a fresh FOLLOW notification once the previous one has been read", async () => {
    await service.notifyFollow(ACTOR_ID, RECIPIENT_ID);
    await service.markAllRead(CLERK_ID);

    await service.notifyFollow(ACTOR_ID, RECIPIENT_ID);

    // The index is partial (`WHERE read_at IS NULL`), so a read row stops
    // constraining anything — the second follow is legitimately newsworthy.
    expect(fake.notifications).toHaveLength(2);
    expect(fake.notifications[0].readAt).not.toBeNull();
    expect(fake.notifications[1].readAt).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("yields exactly one row when two notifyFollow calls race with no unread row to pre-check against", async () => {
    // Unit-layer proof of the CATCH, not of the DB race (see the block
    // docstring): the fake's `create()` has no internal `await`, so this is
    // deterministically SEQUENTIAL, not a genuine interleaving — call A's
    // entire body (including its row push) runs to completion before call B
    // starts, so B always collides with A's just-written row and always hits
    // the dedup branch. Still worth keeping as its own assertion of the
    // `Promise.all` call shape, even though it is functionally redundant with
    // "swallows the dedup violation" above.
    await Promise.all([
      service.notifyFollow(ACTOR_ID, RECIPIENT_ID),
      service.notifyFollow(ACTOR_ID, RECIPIENT_ID),
    ]);

    expect(fake.notifications).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warn-logs and rethrows an insert failure that is NOT the dedup violation", async () => {
    fake.control.nextCreateError = new Error("connection terminated");

    await expect(
      service.notifyFollow(ACTOR_ID, RECIPIENT_ID),
    ).rejects.toThrow("connection terminated");

    // The contrast case for the dedup test above: a genuine failure is NOT
    // silently absorbed. It is surfaced to the log AND propagated to the hook
    // site's own try/catch, which is what keeps the follow itself a 200.
    expect(fake.notifications).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMessage = String(warnSpy.mock.calls[0][0]);
    expect(warnMessage).toContain("connection terminated");
    // The log must also identify WHO the lost notification was for — a
    // regression that drops the recipient id would still "warn", just
    // uselessly, since nobody could tell which user's follow notification
    // failed to send.
    expect(warnMessage).toContain(RECIPIENT_ID);
  });
});
