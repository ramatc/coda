-- CreateTable
CREATE TABLE "want_to_listen" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "album_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "want_to_listen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "want_to_listen_user_id_created_at_idx" ON "want_to_listen"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "want_to_listen_user_id_album_id_key" ON "want_to_listen"("user_id", "album_id");

-- AddForeignKey
ALTER TABLE "want_to_listen" ADD CONSTRAINT "want_to_listen_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "want_to_listen" ADD CONSTRAINT "want_to_listen_album_id_fkey" FOREIGN KEY ("album_id") REFERENCES "albums"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
