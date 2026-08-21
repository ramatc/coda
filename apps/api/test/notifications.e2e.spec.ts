import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import request from "supertest";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { verifyToken } from "@clerk/backend";
import { NotificationType } from "@coda/db";
import { AppModule } from "../src/app.module.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

// Mock the Clerk SDK at the module boundary so no network / real key is needed
// (matches auth-guard.e2e / social.e2e / reviews.e2e).
vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));
const mockedVerifyToken = vi.mocked(verifyToken);

const RECIPIENT_CLERK = "user_recipient";
const RECIPIENT_ID = "11111111-1111-4111-8111-111111111111";
/** A second synced account that owns NO notifications (the empty-page case). */
const NEWCOMER_CLERK = "user_newcomer";
const NEWCOMER_ID = "22222222-2222-4222-8222-222222222222";
const REVIEW_ID = "77777777-7777-4777-8777-777777777777";
const FOLLOW_NOTIFICATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const COMMENT_NOTIFICATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

/** A notification row in the shape the service's `select` projects it. */
interface Row {
  id: string;
  recipientUserId: string;
  type: NotificationType;
  createdAt: Date;
  readAt: Date | null;
  actor: {
    profile: {
      username: string;
      displayName: string;
      avatarUrl: string | null;
    } | null;
  };
  reviewComment: { reviewId: string; body: string } | null;
}

/**
 * The narrow Prisma surface the `/notifications` routes touch, stubbed so they
 * can be exercised end to end without a live Postgres (the project's no-docker
 * sandbox convention, matching `reviews.e2e.spec.ts`).
 *
 * The row store is MUTABLE and `reset()` restores it between tests, because the
 * `read-all` scenario needs two sequential HTTP requests to share state: proving
 * the badge is zero afterwards is only meaningful if the first request really
 * persisted. `updateMany` applies the `readAt: null` predicate the way Postgres
 * would, so a row already read is never matched.
 */
function stubPrisma() {
  let rows: Row[] = [];

  function seed(): Row[] {
    return [
      {
        id: COMMENT_NOTIFICATION_ID,
        recipientUserId: RECIPIENT_ID,
        type: NotificationType.COMMENT,
        createdAt: new Date("2026-08-02T10:00:00.000Z"),
        readAt: null,
        actor: {
          profile: {
            username: "ana",
            displayName: "Ana Torres",
            avatarUrl: null,
          },
        },
        reviewComment: { reviewId: REVIEW_ID, body: "This record rules." },
      },
      {
        id: FOLLOW_NOTIFICATION_ID,
        recipientUserId: RECIPIENT_ID,
        type: NotificationType.FOLLOW,
        createdAt: new Date("2026-08-01T10:00:00.000Z"),
        readAt: null,
        actor: {
          profile: {
            username: "ana",
            displayName: "Ana Torres",
            avatarUrl: null,
          },
        },
        reviewComment: null,
      },
    ];
  }

  /** The caller's own rows in `[createdAt desc, id desc]` order. */
  function ownedBy(recipientUserId: string): Row[] {
    return rows
      .filter((r) => r.recipientUserId === recipientUserId)
      .sort((a, b) => {
        const byTime = b.createdAt.getTime() - a.createdAt.getTime();
        if (byTime !== 0) return byTime;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
  }

  const client = {
    user: {
      async findUnique(args: { where: { clerkUserId: string } }) {
        if (args.where.clerkUserId === RECIPIENT_CLERK) {
          return { id: RECIPIENT_ID };
        }
        if (args.where.clerkUserId === NEWCOMER_CLERK) {
          return { id: NEWCOMER_ID };
        }
        return null;
      },
    },
    notification: {
      async findMany(args: {
        where: { recipientUserId: string };
        take: number;
        cursor?: { id: string };
        skip?: number;
      }) {
        let page = ownedBy(args.where.recipientUserId);
        if (args.cursor) {
          const idx = page.findIndex((r) => r.id === args.cursor?.id);
          page = idx >= 0 ? page.slice(idx + (args.skip ?? 0)) : [];
        }
        return page.slice(0, args.take);
      },
      async count(args: {
        where: { recipientUserId: string; readAt: null };
      }) {
        return ownedBy(args.where.recipientUserId).filter(
          (r) => r.readAt === args.where.readAt,
        ).length;
      },
      async updateMany(args: {
        where: { recipientUserId: string; readAt: null };
        data: { readAt: Date };
      }) {
        const matched = ownedBy(args.where.recipientUserId).filter(
          (r) => r.readAt === args.where.readAt,
        );
        for (const row of matched) {
          row.readAt = args.data.readAt;
        }
        return { count: matched.length };
      },
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    reset(): void {
      rows = seed();
    },
  };
}

/**
 * HTTP-layer proof for the notifications module. The controller spec asserts
 * decorator placement by reading metadata and never boots Nest, so it cannot
 * prove that (a) the routes actually resolve under the paths declared, (b) the
 * global fail-closed `ClerkGuard` really rejects an anonymous caller on all
 * THREE of them, (c) `@HttpCode(200)` survives into a real response, or (d) the
 * service's `BadRequestException` maps to a 400 rather than escaping as a 500.
 *
 * The `401 (not 404)` assertions are the load-bearing ones: a notification is
 * private to its recipient, so this module has no anonymous surface at all. If
 * `@Public()` or `OptionalClerkGuard` were ever copied here from
 * `ReviewsController`, these would silently turn into 2xx with an `undefined`
 * caller.
 */
describe("Notifications API (e2e)", () => {
  let app: INestApplication;
  let stub: ReturnType<typeof stubPrisma>;

  /** Makes the mocked Clerk SDK accept any bearer token as the given account. */
  function signInAs(clerkUserId: string): void {
    mockedVerifyToken.mockResolvedValue({
      sub: clerkUserId,
      sid: "sess_1",
    } as Awaited<ReturnType<typeof verifyToken>>);
  }

  beforeAll(async () => {
    stub = stubPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(stub.prisma)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockedVerifyToken.mockReset();
    stub.reset();
  });

  it.each([
    ["get", "/notifications"],
    ["get", "/notifications/unread-count"],
    ["post", "/notifications/read-all"],
  ] as const)(
    "rejects %s %s without an Authorization header (401, not 404)",
    async (method, path) => {
      const res = await request(app.getHttpServer())[method](path);

      // 401 rather than 404 proves the route resolved and the guard ran; the
      // guard never reaching the Clerk SDK proves it failed closed on the
      // missing header instead of attempting a verification.
      expect(res.status).toBe(401);
      expect(mockedVerifyToken).not.toHaveBeenCalled();
    },
  );

  it("serves GET /notifications to a signed-in caller, newest first with the badge", async () => {
    signInAs(RECIPIENT_CLERK);

    const res = await request(app.getHttpServer())
      .get("/notifications")
      .set("Authorization", "Bearer valid.jwt.token");

    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(2);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([
      COMMENT_NOTIFICATION_ID,
      FOLLOW_NOTIFICATION_ID,
    ]);
    // The COMMENT item carries its link target and preview; timestamps survive
    // JSON serialization as ISO strings, which the unit spec cannot prove
    // because it never crosses the wire.
    expect(res.body.items[0]).toMatchObject({
      type: "COMMENT",
      reviewId: REVIEW_ID,
      commentExcerpt: "This record rules.",
      readAt: null,
      createdAt: "2026-08-02T10:00:00.000Z",
      actor: { username: "ana", displayName: "Ana Torres", avatarUrl: null },
    });
    // A FOLLOW row carries no target FK at all (design Decision 1).
    expect(res.body.items[1]).toMatchObject({
      type: "FOLLOW",
      reviewId: null,
      commentExcerpt: null,
    });
  });

  it("pages across a cursor boundary without skipping or repeating a row", async () => {
    signInAs(RECIPIENT_CLERK);
    const server = app.getHttpServer();

    const firstPage = await request(server)
      .get("/notifications?limit=1")
      .set("Authorization", "Bearer valid.jwt.token");

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.items.map((i: { id: string }) => i.id)).toEqual([
      COMMENT_NOTIFICATION_ID,
    ]);
    expect(firstPage.body.nextCursor).toBe(COMMENT_NOTIFICATION_ID);

    const secondPage = await request(server)
      .get(`/notifications?limit=1&cursor=${firstPage.body.nextCursor}`)
      .set("Authorization", "Bearer valid.jwt.token");

    expect(secondPage.status).toBe(200);
    // The second page must land on the OTHER seeded row: neither the same
    // one repeated (the cursor failed to advance) nor an empty page (the
    // cursor skipped past it) across the boundary.
    expect(secondPage.body.items.map((i: { id: string }) => i.id)).toEqual([
      FOLLOW_NOTIFICATION_ID,
    ]);
    expect(secondPage.body.nextCursor).toBeNull();
  });

  it("serves GET /notifications/unread-count as the bare badge payload", async () => {
    signInAs(RECIPIENT_CLERK);

    const res = await request(app.getHttpServer())
      .get("/notifications/unread-count")
      .set("Authorization", "Bearer valid.jwt.token");

    expect(res.status).toBe(200);
    // Exactly the badge and nothing else — this is the route every signed-in
    // tab polls twice a minute forever (design Decision 12).
    expect(res.body).toEqual({ unreadCount: 2 });
  });

  it("clears the badge through POST /notifications/read-all with a 200, not a 201", async () => {
    signInAs(RECIPIENT_CLERK);
    const server = app.getHttpServer();

    const readAll = await request(server)
      .post("/notifications/read-all")
      .set("Authorization", "Bearer valid.jwt.token");

    // 200 (not Nest's default 201 for a POST): nothing was created.
    expect(readAll.status).toBe(200);
    expect(readAll.body).toEqual({ unreadCount: 0 });

    // Re-reading over HTTP proves the rows were really written, rather than the
    // handler returning a zero literal.
    const after = await request(server)
      .get("/notifications")
      .set("Authorization", "Bearer valid.jwt.token");

    expect(after.body.unreadCount).toBe(0);
    expect(after.body.items).toHaveLength(2);
    for (const item of after.body.items as { readAt: string | null }[]) {
      expect(item.readAt).not.toBeNull();
    }
  });

  it("treats a second POST /notifications/read-all as an idempotent 200 no-op", async () => {
    signInAs(RECIPIENT_CLERK);
    const server = app.getHttpServer();

    const first = await request(server)
      .post("/notifications/read-all")
      .set("Authorization", "Bearer valid.jwt.token");
    const firstReadAt = (
      await request(server)
        .get("/notifications")
        .set("Authorization", "Bearer valid.jwt.token")
    ).body.items[0].readAt as string;

    const second = await request(server)
      .post("/notifications/read-all")
      .set("Authorization", "Bearer valid.jwt.token");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ unreadCount: 0 });

    // Nothing matched the second time, so replaying the request (a double-open
    // of the dropdown) cannot restamp when the user actually saw them.
    const after = await request(server)
      .get("/notifications")
      .set("Authorization", "Bearer valid.jwt.token");
    expect(after.body.items[0].readAt).toBe(firstReadAt);
  });

  it("serves an empty page and a zero badge to a synced caller who owns no rows", async () => {
    // The store is NOT empty — it holds the recipient's two rows. The emptiness
    // below therefore proves the recipient scoping in the `where`, not an empty
    // table, and is the companion to the populated page asserted above.
    signInAs(NEWCOMER_CLERK);
    const server = app.getHttpServer();

    const page = await request(server)
      .get("/notifications")
      .set("Authorization", "Bearer valid.jwt.token");
    const readAll = await request(server)
      .post("/notifications/read-all")
      .set("Authorization", "Bearer valid.jwt.token");

    expect(page.status).toBe(200);
    expect(page.body).toEqual({ items: [], nextCursor: null, unreadCount: 0 });
    // `read-all` over an empty set is a tolerant 200, never a 404 (Decision 14).
    expect(readAll.status).toBe(200);
    expect(readAll.body).toEqual({ unreadCount: 0 });
  });

  it("leaves another user's notifications untouched when read-all is called", async () => {
    signInAs(NEWCOMER_CLERK);
    const server = app.getHttpServer();

    await request(server)
      .post("/notifications/read-all")
      .set("Authorization", "Bearer valid.jwt.token");

    signInAs(RECIPIENT_CLERK);
    const recipientView = await request(server)
      .get("/notifications")
      .set("Authorization", "Bearer valid.jwt.token");

    // One signed-in caller must not be able to clear the whole table's unread
    // state — the scoping lives in the `where` and this is its HTTP-level proof.
    expect(recipientView.body.unreadCount).toBe(2);
  });

  it("answers a malformed cursor with 400, not a 500", async () => {
    signInAs(RECIPIENT_CLERK);

    const res = await request(app.getHttpServer())
      .get("/notifications?cursor=not-a-uuid")
      .set("Authorization", "Bearer valid.jwt.token");

    // The UUID guard runs before Postgres would raise "invalid input syntax for
    // type uuid"; an unmapped exception would escape here as an unhandled 500.
    expect(res.status).toBe(400);
  });

  it("degrades to an empty page (never a 404) for an unsynced caller", async () => {
    signInAs("user_never_synced");
    const server = app.getHttpServer();

    const page = await request(server)
      .get("/notifications")
      .set("Authorization", "Bearer valid.jwt.token");
    const count = await request(server)
      .get("/notifications/unread-count")
      .set("Authorization", "Bearer valid.jwt.token");
    const readAll = await request(server)
      .post("/notifications/read-all")
      .set("Authorization", "Bearer valid.jwt.token");

    // Authenticated by Clerk but with no local `User` row yet (the webhook sync
    // is eventually consistent). All three routes stay tolerant.
    expect(page.status).toBe(200);
    expect(page.body).toEqual({ items: [], nextCursor: null, unreadCount: 0 });
    expect(count.body).toEqual({ unreadCount: 0 });
    expect(readAll.status).toBe(200);
    expect(readAll.body).toEqual({ unreadCount: 0 });
  });
});
