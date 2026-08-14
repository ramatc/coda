-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('FOLLOW', 'COMMENT');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "recipient_user_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "type" "notification_type" NOT NULL,
    "review_comment_id" UUID,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_created_at_id_idx" ON "notifications"("recipient_user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_read_at_idx" ON "notifications"("recipient_user_id", "read_at");

-- CreateIndex
CREATE INDEX "notifications_review_comment_id_idx" ON "notifications"("review_comment_id");

-- CreateIndex
CREATE INDEX "notifications_actor_user_id_idx" ON "notifications"("actor_user_id");

-- CreateIndex (hand-written — NOT generated from schema.prisma)
-- Refollow-spam guard (design Decision 17). An unfollow -> refollow loop would
-- otherwise mint an unlimited number of FOLLOW notifications and emails at the
-- victim. This partial unique index enforces "at most one UNREAD FOLLOW
-- notification per (recipient, actor)" atomically at the DB level, so
-- `notifyFollow` can insert-then-catch instead of running a `findFirst`
-- pre-check that would leave a TOCTOU race open. Once the existing row is read,
-- a later refollow legitimately creates a new notification.
--
-- Prisma's schema DSL cannot express a partial (WHERE-scoped) unique index, so
-- this statement has no counterpart in `schema.prisma`. Any future
-- `prisma migrate dev` run diffs the DB against `schema.prisma`, will not find
-- this index, and may propose dropping it — silently reopening the spam vector.
-- Verify it survives (`\d notifications` in psql) before accepting any
-- generated migration that touches this table.
--
-- On the "type" column: it IS redundant as an index column, because the
-- `WHERE "type" = 'FOLLOW'` predicate already pins it to a single value, so it
-- adds nothing to selectivity today. It is kept deliberately, not by accident.
-- It documents at a glance that the constraint is FOLLOW-scoped, and it is the
-- defensive shape for the day a second NotificationType value is added to the
-- WHERE clause (e.g. `"type" IN ('FOLLOW', 'MENTION')`), at which point the
-- column becomes load-bearing and its absence would be a correctness bug.
-- Do not "optimize" it away.
CREATE UNIQUE INDEX "notifications_active_follow_dedup_idx" ON "notifications"("recipient_user_id", "actor_user_id", "type") WHERE "read_at" IS NULL AND "type" = 'FOLLOW';

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_review_comment_id_fkey" FOREIGN KEY ("review_comment_id") REFERENCES "review_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rollback (documentation only — Prisma Migrate has no down-migration runner).
-- The order is NOT interchangeable: Postgres refuses to drop an enum type that
-- a live column still references, so the table must go first. Dropping the
-- table takes its indexes and foreign keys with it.
--
--   DROP TABLE "notifications";
--   DROP TYPE "notification_type";
--
-- This migration is purely additive: nothing from Fase 1-3 is altered, so the
-- rollback touches no pre-existing data.
