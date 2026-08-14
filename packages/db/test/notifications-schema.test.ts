import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NotificationType } from "../src/generated/client/index.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const SCHEMA = readFileSync(
  path.join(packageRoot, "prisma", "schema.prisma"),
  "utf8",
);

const MIGRATION = readFileSync(
  path.join(
    packageRoot,
    "prisma",
    "migrations",
    "20260812000000_fase2_notifications",
    "migration.sql",
  ),
  "utf8",
);

/**
 * Returns the body of a top-level `model X { ... }` / `enum X { ... }` block so
 * an assertion about one model cannot accidentally be satisfied by text
 * belonging to another.
 */
function block(source: string, header: string): string {
  const start = source.indexOf(`${header} {`);
  if (start === -1) {
    return "";
  }
  const end = source.indexOf("\n}", start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("NotificationType enum", () => {
  it("is generated with exactly the two v1 event types", () => {
    expect(NotificationType.FOLLOW).toBe("FOLLOW");
    expect(NotificationType.COMMENT).toBe("COMMENT");
    expect(Object.keys(NotificationType)).toEqual(["FOLLOW", "COMMENT"]);
  });

  it("maps to the snake_case postgres type name", () => {
    expect(block(SCHEMA, "enum NotificationType")).toContain(
      '@@map("notification_type")',
    );
  });
});

describe("Notification model (schema.prisma)", () => {
  const model = block(SCHEMA, "model Notification");

  it("requires actorUserId and leaves only the comment FK nullable (design Decisions 1 and 3)", () => {
    expect(model).toMatch(/recipientUserId\s+String\s+@map\("recipient_user_id"\)/);
    // No `?` on actorUserId: v1 has no system notifications, so the FK is required.
    expect(model).toMatch(/actorUserId\s+String\s+@map\("actor_user_id"\)/);
    expect(model).not.toMatch(/actorUserId\s+String\?/);
    // FOLLOW rows carry no target FK at all, so the comment FK must be nullable.
    expect(model).toMatch(/reviewCommentId\s+String\?\s+@map\("review_comment_id"\)/);
    expect(model).toMatch(/readAt\s+DateTime\?\s+@map\("read_at"\)/);
    // There is deliberately no scalar FK to Follow (its PK is composite).
    expect(model).not.toContain("followId");
  });

  it("cascades all three relations, inverting ActivityEvent's SetNull policy (design Decision 2)", () => {
    const cascades = model.match(/onDelete: Cascade/g) ?? [];
    expect(cascades).toHaveLength(3);
    expect(model).not.toContain("SetNull");
    expect(model).toMatch(
      /recipient\s+User\s+@relation\("NotificationRecipient"/,
    );
    expect(model).toMatch(/actor\s+User\s+@relation\("NotificationActor"/);
    expect(model).toMatch(/reviewComment\s+ReviewComment\?\s+@relation\(/);
  });

  it("declares the four read/cascade indexes and the table mapping", () => {
    expect(model).toContain(
      "@@index([recipientUserId, createdAt(sort: Desc), id(sort: Desc)])",
    );
    expect(model).toContain("@@index([recipientUserId, readAt])");
    expect(model).toContain("@@index([reviewCommentId])");
    expect(model).toContain("@@index([actorUserId])");
    expect(model).toContain('@@map("notifications")');
  });

  it("wires the back-relations on User and ReviewComment", () => {
    const user = block(SCHEMA, "model User");
    expect(user).toMatch(
      /notificationsReceived\s+Notification\[\]\s+@relation\("NotificationRecipient"\)/,
    );
    expect(user).toMatch(
      /notificationsSent\s+Notification\[\]\s+@relation\("NotificationActor"\)/,
    );
    expect(block(SCHEMA, "model ReviewComment")).toMatch(
      /notifications\s+Notification\[\]/,
    );
  });
});

/**
 * Returns the column-definition body of `CREATE TABLE "name" ( ... );` so a
 * nullability assertion about one column cannot accidentally be satisfied by
 * text belonging to an index, constraint, or a different table.
 */
function tableBlock(source: string, tableName: string): string {
  const header = `CREATE TABLE "${tableName}" (`;
  const start = source.indexOf(header);
  if (start === -1) {
    return "";
  }
  const end = source.indexOf(");", start);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("fase2_notifications migration", () => {
  it("creates the enum and the table before anything references them", () => {
    expect(MIGRATION).toContain(
      "CREATE TYPE \"notification_type\" AS ENUM ('FOLLOW', 'COMMENT');",
    );
    expect(MIGRATION).toContain('CREATE TABLE "notifications"');
    expect(MIGRATION.indexOf("CREATE TYPE")).toBeLessThan(
      MIGRATION.indexOf("CREATE TABLE"),
    );
  });

  it("enforces the exact column nullability from schema.prisma (design Decision 3: actorUserId is required)", () => {
    const table = tableBlock(MIGRATION, "notifications");
    expect(table).not.toBe("");

    expect(table).toContain('"id" UUID NOT NULL');
    expect(table).toContain('"recipient_user_id" UUID NOT NULL');
    // actorUserId has no `?` in schema.prisma: v1 has no system notifications,
    // so the FK column must be NOT NULL at the DB level too.
    expect(table).toContain('"actor_user_id" UUID NOT NULL');
    expect(table).toContain('"type" "notification_type" NOT NULL');
    // reviewCommentId is the discriminated FK: only set for COMMENT-type rows,
    // so it must stay nullable (no NOT NULL) here.
    expect(table).toMatch(/"review_comment_id" UUID,/);
    expect(table).not.toMatch(/"review_comment_id" UUID NOT NULL/);
    expect(table).toMatch(/"read_at" TIMESTAMP\(3\),/);
    expect(table).not.toMatch(/"read_at" TIMESTAMP\(3\) NOT NULL/);
    expect(table).toContain(
      '"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
    );
  });

  it("creates the four plain indexes declared in schema.prisma", () => {
    expect(MIGRATION).toContain(
      'CREATE INDEX "notifications_recipient_user_id_created_at_id_idx" ON "notifications"("recipient_user_id", "created_at" DESC, "id" DESC);',
    );
    expect(MIGRATION).toContain(
      'CREATE INDEX "notifications_recipient_user_id_read_at_idx" ON "notifications"("recipient_user_id", "read_at");',
    );
    expect(MIGRATION).toContain(
      'CREATE INDEX "notifications_review_comment_id_idx" ON "notifications"("review_comment_id");',
    );
    expect(MIGRATION).toContain(
      'CREATE INDEX "notifications_actor_user_id_idx" ON "notifications"("actor_user_id");',
    );
  });

  it("hand-adds the partial unique dedup index that Prisma's DSL cannot express (design Decision 17)", () => {
    expect(MIGRATION).toContain(
      'CREATE UNIQUE INDEX "notifications_active_follow_dedup_idx" ON "notifications"("recipient_user_id", "actor_user_id", "type") WHERE "read_at" IS NULL AND "type" = \'FOLLOW\';',
    );
  });

  it("documents why the redundant `type` column is kept in the dedup index", () => {
    const indexAt = MIGRATION.indexOf(
      'CREATE UNIQUE INDEX "notifications_active_follow_dedup_idx"',
    );
    expect(indexAt).toBeGreaterThan(-1);
    // The rationale must sit directly above the statement, where a future
    // contributor pruning "redundant" index columns will actually read it.
    const preamble = MIGRATION.slice(0, indexAt);
    const commentBlock = preamble.slice(preamble.lastIndexOf("\n\n"));
    expect(commentBlock).toContain("redundant");
    expect(commentBlock).toContain("NotificationType");
  });

  it("cascades all three foreign keys", () => {
    for (const [column, table] of [
      ["recipient_user_id", "users"],
      ["actor_user_id", "users"],
      ["review_comment_id", "review_comments"],
    ]) {
      expect(MIGRATION).toContain(
        `FOREIGN KEY ("${column}") REFERENCES "${table}"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      );
    }
  });

  it("documents a rollback that drops the table before the enum type", () => {
    const dropTable = MIGRATION.indexOf('DROP TABLE "notifications"');
    const dropType = MIGRATION.indexOf('DROP TYPE "notification_type"');
    expect(dropTable).toBeGreaterThan(-1);
    expect(dropType).toBeGreaterThan(-1);
    // Postgres refuses to drop a type still used by a live column.
    expect(dropTable).toBeLessThan(dropType);
  });
});
