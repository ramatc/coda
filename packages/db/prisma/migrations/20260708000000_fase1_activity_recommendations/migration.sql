-- CreateEnum
CREATE TYPE "activity_type" AS ENUM ('LISTEN', 'RATING', 'REVIEW');

-- CreateEnum
CREATE TYPE "recommendation_status" AS ENUM ('ACTIVE', 'DISMISSED', 'CONSUMED');

-- CreateTable
CREATE TABLE "user_genre_preferences" (
    "user_id" UUID NOT NULL,
    "genre_id" UUID NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_genre_preferences_pkey" PRIMARY KEY ("user_id","genre_id")
);

-- CreateTable
CREATE TABLE "user_artist_favorites" (
    "user_id" UUID NOT NULL,
    "artist_id" UUID NOT NULL,
    "rank" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_artist_favorites_pkey" PRIMARY KEY ("user_id","artist_id")
);

-- CreateTable
CREATE TABLE "user_album_favorites" (
    "user_id" UUID NOT NULL,
    "album_id" UUID NOT NULL,
    "rank" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_album_favorites_pkey" PRIMARY KEY ("user_id","album_id")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "activity_type" NOT NULL,
    "album_id" UUID NOT NULL,
    "listen_id" UUID,
    "review_id" UUID,
    "rating_id" UUID,
    "payload" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "album_id" UUID NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" JSONB,
    "status" "recommendation_status" NOT NULL DEFAULT 'ACTIVE',
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissed_at" TIMESTAMP(3),

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_genre_preferences_genre_id_idx" ON "user_genre_preferences"("genre_id");

-- CreateIndex
CREATE INDEX "user_artist_favorites_artist_id_idx" ON "user_artist_favorites"("artist_id");

-- CreateIndex
CREATE INDEX "user_album_favorites_album_id_idx" ON "user_album_favorites"("album_id");

-- AlterTable
ALTER TABLE "ratings" ADD COLUMN "id" UUID NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ratings_id_key" ON "ratings"("id");

-- CreateIndex
CREATE INDEX "activity_events_user_id_occurred_at_idx" ON "activity_events"("user_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_events_occurred_at_idx" ON "activity_events"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "activity_events_album_id_idx" ON "activity_events"("album_id");

-- CreateIndex
CREATE INDEX "activity_events_listen_id_idx" ON "activity_events"("listen_id");

-- CreateIndex
CREATE INDEX "activity_events_review_id_idx" ON "activity_events"("review_id");

-- CreateIndex
CREATE INDEX "activity_events_rating_id_idx" ON "activity_events"("rating_id");

-- CreateIndex
CREATE INDEX "recommendations_user_id_status_score_idx" ON "recommendations"("user_id", "status", "score" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "recommendations_user_id_album_id_key" ON "recommendations"("user_id", "album_id");

-- AddForeignKey
ALTER TABLE "user_genre_preferences" ADD CONSTRAINT "user_genre_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_genre_preferences" ADD CONSTRAINT "user_genre_preferences_genre_id_fkey" FOREIGN KEY ("genre_id") REFERENCES "genres"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_artist_favorites" ADD CONSTRAINT "user_artist_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_artist_favorites" ADD CONSTRAINT "user_artist_favorites_artist_id_fkey" FOREIGN KEY ("artist_id") REFERENCES "artists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_album_favorites" ADD CONSTRAINT "user_album_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_album_favorites" ADD CONSTRAINT "user_album_favorites_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_listen_id_fkey" FOREIGN KEY ("listen_id") REFERENCES "listens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_review_id_fkey" FOREIGN KEY ("review_id") REFERENCES "reviews"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_rating_id_fkey" FOREIGN KEY ("rating_id") REFERENCES "ratings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE CASCADE ON UPDATE CASCADE;
