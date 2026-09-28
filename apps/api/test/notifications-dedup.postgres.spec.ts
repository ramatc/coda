import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NotificationType } from "@coda/db";
import type { NotificationEmailQueue } from "../src/notifications/notification-email.queue.js";
import { NotificationsService } from "../src/notifications/notifications.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { INTEGRATION_ENABLED, INTEGRATION_ENV } from "./integration.js";

/**
 * Real-Postgres integration spec for the refollow dedup index (design
 * Decision 17, task 8.1) and its schema drift check (task 16.4).
 *
 * OPT-IN. Skipped unless `CODA_INTEGRATION=1`, because it needs a migrated
 * database. It is NOT gated on `DATABASE_URL` alone: CI exports that variable
 * but runs `pnpm turbo test` BEFORE `prisma migrate deploy`, so presence of a
 * URL does not mean the schema exists. Run it locally with the Docker stack up:
 *
 *   docker compose up -d postgres
 *   pnpm --filter @coda/db db:deploy
 *   # PowerShell: $env:CODA_INTEGRATION="1"; pnpm --filter @coda/api exec vitest run test/notifications-dedup.postgres.spec.ts
 *   # bash:       CODA_INTEGRATION=1 pnpm --filter @coda/api exec vitest run test/notifications-dedup.postgres.spec.ts
 *
 * `test/setup.ts` loads the repo-root `.env` when the flag is set, without
 * overriding variables already in the environment.
 *
 * Complements, and does NOT replace, the unit-layer dedup tests in
 * `notifications.service.spec.ts` / `social.service.spec.ts`: those isolate the
 * catch logic over single-threaded fakes; only this file exercises the real
 * partial unique index under concurrent inserts on separate connections.
 *
 * Every row it creates hangs off two throwaway users, deleted in `afterAll`
 * (notifications cascade with them), so the database is left as found. Users
 * orphaned by a killed run are swept by the next run's `beforeAll`.
 */

/**
 * The exact definition Postgres reports for the hand-written index. It has no
 * counterpart in `schema.prisma`, so any future `prisma migrate dev` may
 * propose dropping it; this assertion is the repeatable form of the design's
 * "`\d notifications` before accepting a generated migration" check.
 */
const DEDUP_INDEX_NAME = "notifications_active_follow_dedup_idx";
const DEDUP_INDEX_DEFINITION =
  "CREATE UNIQUE INDEX notifications_active_follow_dedup_idx ON public.notifications " +
  "USING btree (recipient_user_id, actor_user_id, type) " +
  "WHERE ((read_at IS NULL) AND (type = 'FOLLOW'::notification_type))";

/** Concurrent calls fired per race. More than two widens the collision window. */
const RACE_WIDTH = 5;

/** Every throwaway user this spec creates carries this `clerkUserId` prefix. */
const INTEGRATION_USER_PREFIX = "integration-";

/**
 * A run killed before `afterAll` leaves its users behind. The next run sweeps
 * prefixed users older than this, which no live run can still be using, so two
 * runs sharing a database never delete each other's users mid-flight.
 */
const STALE_USER_GRACE_MS = 60 * 60 * 1000;

describe.skipIf(!INTEGRATION_ENABLED)(
  `notifications dedup index (real Postgres; set ${INTEGRATION_ENV}=1 to run)`,
  () => {
    const prismaService = new PrismaService();
    const prisma = prismaService.client;
    const enqueue = vi.fn<(notificationId: string) => Promise<void>>();
    const service = new NotificationsService(prismaService, {
      enqueue,
    } as unknown as NotificationEmailQueue);

    const runTag = randomUUID();
    const userIds: string[] = [];

    async function createUser(label: string): Promise<string> {
      const user = await prisma.user.create({
        data: {
          clerkUserId: `${INTEGRATION_USER_PREFIX}${runTag}-${label}`,
          email: `${INTEGRATION_USER_PREFIX}${runTag}-${label}@example.test`,
        },
      });
      userIds.push(user.id);
      return user.id;
    }

    async function sweepStaleIntegrationUsers(now: Date): Promise<void> {
      await prisma.user.deleteMany({
        where: {
          clerkUserId: { startsWith: INTEGRATION_USER_PREFIX },
          createdAt: { lt: new Date(now.getTime() - STALE_USER_GRACE_MS) },
        },
      });
    }

    async function followRows(actorUserId: string, recipientUserId: string) {
      return prisma.notification.findMany({
        where: { actorUserId, recipientUserId, type: NotificationType.FOLLOW },
        orderBy: { createdAt: "asc" },
      });
    }

    beforeAll(async () => {
      enqueue.mockResolvedValue(undefined);
      await sweepStaleIntegrationUsers(new Date());
    });

    afterAll(async () => {
      if (userIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
      await prismaService.onModuleDestroy();
    });

    it("keeps the partial unique index exactly as designed (task 16.4)", async () => {
      const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'notifications'
          AND indexname = ${DEDUP_INDEX_NAME}`;

      expect(rows).toEqual([{ indexdef: DEDUP_INDEX_DEFINITION }]);
    });

    it("stores exactly one unread FOLLOW row when notifyFollow races itself", async () => {
      const actor = await createUser("race-actor");
      const recipient = await createUser("race-recipient");
      enqueue.mockClear();

      const results = await Promise.allSettled(
        Array.from({ length: RACE_WIDTH }, () =>
          service.notifyFollow(actor, recipient),
        ),
      );

      // Every loser's unique violation is the expected dedup no-op, never an error.
      expect(results.map((r) => r.status)).toEqual(
        Array.from({ length: RACE_WIDTH }, () => "fulfilled"),
      );
      const rows = await followRows(actor, recipient);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.readAt).toBeNull();
      // Only the winning insert may schedule an email.
      expect(enqueue.mock.calls).toEqual([[rows[0]?.id]]);
    });

    it("allows a new FOLLOW row once the previous one has been read", async () => {
      const actor = await createUser("reread-actor");
      const recipient = await createUser("reread-recipient");

      await service.notifyFollow(actor, recipient);
      const [first] = await followRows(actor, recipient);
      await prisma.notification.update({
        where: { id: first!.id },
        data: { readAt: new Date() },
      });

      await Promise.all(
        Array.from({ length: RACE_WIDTH }, () =>
          service.notifyFollow(actor, recipient),
        ),
      );

      const rows = await followRows(actor, recipient);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.id).toBe(first!.id);
      expect(rows[0]?.readAt).toBeInstanceOf(Date);
      expect(rows[1]?.readAt).toBeNull();
    });

    it("scopes the index per actor: two actors racing the same recipient both land", async () => {
      const actorA = await createUser("scope-actor-a");
      const actorB = await createUser("scope-actor-b");
      const recipient = await createUser("scope-recipient");

      await Promise.all([
        service.notifyFollow(actorA, recipient),
        service.notifyFollow(actorB, recipient),
        service.notifyFollow(actorA, recipient),
        service.notifyFollow(actorB, recipient),
      ]);

      expect(await followRows(actorA, recipient)).toHaveLength(1);
      expect(await followRows(actorB, recipient)).toHaveLength(1);
    });

    it("sweeps throwaway users older than the grace period, never fresh or foreign ones", async () => {
      const longAgo = new Date(Date.now() - 2 * STALE_USER_GRACE_MS);
      const stale = await prisma.user.create({
        data: {
          clerkUserId: `${INTEGRATION_USER_PREFIX}${runTag}-stale`,
          email: `${INTEGRATION_USER_PREFIX}${runTag}-stale@example.test`,
          createdAt: longAgo,
        },
      });
      userIds.push(stale.id);
      const foreign = await prisma.user.create({
        data: {
          clerkUserId: `guard-${runTag}-old-real-user`,
          email: `guard-${runTag}-old-real-user@example.test`,
          createdAt: longAgo,
        },
      });
      userIds.push(foreign.id);
      const fresh = await createUser("sweep-fresh");

      await sweepStaleIntegrationUsers(new Date());

      expect(
        await prisma.user.findUnique({ where: { id: stale.id } }),
      ).toBeNull();
      expect(
        await prisma.user.findUnique({ where: { id: foreign.id } }),
      ).not.toBeNull();
      expect(
        await prisma.user.findUnique({ where: { id: fresh } }),
      ).not.toBeNull();
    });
  },
);
