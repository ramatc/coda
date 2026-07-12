-- DropIndex
DROP INDEX "activity_events_user_id_occurred_at_idx";

-- CreateIndex
CREATE INDEX "activity_events_user_id_occurred_at_id_idx" ON "activity_events"("user_id", "occurred_at" DESC, "id" DESC);
