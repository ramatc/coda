import { beforeEach, describe, expect, it } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@coda/db";
import { ListsService } from "../src/lists/lists.service.js";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
} from "../src/lists/lists.constants.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const OWNER_CLERK = "clerk_owner";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_USERNAME = "owner";
const OTHER_CLERK = "clerk_other";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ALBUM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ALBUM_ID_2 = "abababab-abab-4bab-8bab-abababababab";
const ALBUM_ID_3 = "acacacac-acac-4cac-8cac-acacacacacac";
const PUBLIC_LIST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRIVATE_LIST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UNKNOWN_LIST_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OTHER_LIST_ID = "baba1111-baba-4bab-8bab-babababababa";
const ITEM_ID_1 = "10000000-0000-4000-8000-000000000001";
const ITEM_ID_2 = "10000000-0000-4000-8000-000000000002";
const ITEM_ID_3 = "10000000-0000-4000-8000-000000000003";
const UNKNOWN_ITEM_ID = "10000000-0000-4000-8000-0000000000ff";

interface StoredList {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredItem {
  id: string;
  listId: string;
  albumId: string;
  position: number;
  note: string | null;
}

interface StoredListLike {
  userId: string;
  listId: string;
}

const ALBUM = {
  id: ALBUM_ID,
  title: "OK Computer",
  coverUrl: "https://cdn.coda.test/ok.jpg",
  primaryArtist: { name: "Radiohead" },
};

/**
 * Builds a P2002 unique-constraint error shaped like this project's Prisma 7
 * client (the REAL `@prisma/adapter-pg` driver-adapter shape: fields live on
 * `meta.driverAdapterError.cause.constraint.fields`, NOT the classic
 * `meta.target` this client never populates — Decision #14), so
 * {@link isUniqueConstraintViolation} recognizes it, {@link
 * extractUniqueConstraintField} resolves the raw `list_id` DB column (mapped
 * from `ListItem.listId` via `@map("list_id")`) from
 * `@@unique([listId, albumId])`, and the duplicate item-add path maps it to a
 * 409 (not a 500).
 */
function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`list_id`,`album_id`)",
    {
      code: "P2002",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["list_id"] },
          },
        },
      },
    },
  );
}

/**
 * Builds the P2002 a duplicate `ListLike` insert raises. Deliberately reports
 * `user_id` as the violated field — the LEADING column of the composite
 * `@@id([userId, listId])`, which is exactly what the real driver adapter
 * surfaces and which discriminates NOTHING.
 *
 * That choice is load-bearing, not incidental. `list_likes` has the composite
 * PK as its SOLE unique constraint, so {@link ListsService.likeList} maps a
 * BARE {@link isUniqueConstraintViolation} to 409 (design Decision 5). If a
 * later contributor copies `addItem`'s `extractUniqueConstraintField(err) ===
 * "list_id"` discrimination into the like path — which is correct THERE, where
 * `ListItem` carries both a surrogate `@id` and `@@unique([listId, albumId])`
 * — this error would no longer match, the 409 would not be thrown, and the
 * duplicate-like test below would fail with a raw P2002 instead. The test is
 * the tripwire for that specific mistake.
 */
function listLikeUniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`user_id`,`list_id`)",
    {
      code: "P2002",
      clientVersion: "test",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["user_id"] },
          },
        },
      },
    },
  );
}

/**
 * Builds a P2003 foreign-key violation shaped like this project's Prisma 7
 * client. `loadListForViewer` and `listLike.create` are separate,
 * non-transactional round trips, so a list deleted in that window (e.g. the
 * owner deletes it from another tab while a like request is in flight) makes
 * `ListLike.listId` point at nothing, and the design requires that to surface
 * as a 404 rather than an unhandled 500 — mirroring
 * `reviews.service.spec.ts`'s `foreignKeyError`.
 */
function listLikeForeignKeyError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Foreign key constraint failed on the field: `list_id`",
    { code: "P2003", clientVersion: "test" },
  );
}

/**
 * In-memory Prisma stand-in honouring the exact queries {@link ListsService}
 * issues: `user.findUnique` by clerk id, `profile.findUnique` by username, and
 * `list.findUnique` / `list.create` / `list.updateMany` / `list.deleteMany` /
 * `list.findMany` for the CRUD + access-helper paths. Proves the ownership /
 * 403-vs-404 matrix deterministically without a live Postgres (the project's
 * no-docker sandbox convention, mirroring social.service.spec).
 */
function createFakePrisma() {
  const usersByClerk = new Map<string, string>();
  const usersByUsername = new Map<string, string>();
  const lists: StoredList[] = [];
  const items: StoredItem[] = [];
  const listLikes: StoredListLike[] = [];
  // Every composite-key like lookup the service issues, so a test can prove a
  // `null` viewer never reaches Prisma at all (there is no local id to key on).
  const likeLookups: { userId: string; listId: string }[] = [];
  const hooks: { afterAccessLoad?: () => void } = {};
  let idSeq = 0;

  function likesForList(listId: string): number {
    return listLikes.filter((l) => l.listId === listId).length;
  }

  function nextId(): string {
    idSeq += 1;
    return `ffffffff-ffff-4fff-8fff-${idSeq.toString().padStart(12, "0")}`;
  }

  function itemsForList(listId: string) {
    return items
      .filter((i) => i.listId === listId)
      .sort((a, b) => a.position - b.position)
      .map((i) => ({
        id: i.id,
        position: i.position,
        note: i.note,
        album: ALBUM,
      }));
  }

  const client = {
    user: {
      async findUnique(args: {
        where: { clerkUserId: string };
      }): Promise<{ id: string } | null> {
        const id = usersByClerk.get(args.where.clerkUserId);
        return id ? { id } : null;
      },
    },
    profile: {
      async findUnique(args: {
        where: { username: string };
      }): Promise<{ userId: string } | null> {
        const userId = usersByUsername.get(args.where.username);
        return userId ? { userId } : null;
      },
    },
    list: {
      async findUnique(args: {
        where: { id: string };
      }): Promise<Record<string, unknown> | null> {
        const list = lists.find((l) => l.id === args.where.id);
        if (!list) return null;
        const result = {
          id: list.id,
          userId: list.userId,
          title: list.title,
          description: list.description,
          isRanked: list.isRanked,
          isPublic: list.isPublic,
          createdAt: list.createdAt,
          updatedAt: list.updatedAt,
          items: itemsForList(list.id),
          _count: { likes: likesForList(list.id) },
        };
        // Race seam: a test can set this to remove the list from the store
        // right after the access check reads it but before the subsequent
        // write runs, proving `loadListForViewer` and the write are separate,
        // non-transactional round trips.
        hooks.afterAccessLoad?.();
        return result;
      },
      async create(args: {
        data: {
          userId: string;
          title: string;
          description: string | null;
          isRanked: boolean;
          isPublic: boolean;
        };
      }): Promise<Record<string, unknown>> {
        const now = new Date("2026-07-22T12:00:00.000Z");
        const list: StoredList = {
          id: nextId(),
          userId: args.data.userId,
          title: args.data.title,
          description: args.data.description,
          isRanked: args.data.isRanked,
          isPublic: args.data.isPublic,
          createdAt: now,
          updatedAt: now,
        };
        lists.push(list);
        return { ...list, items: [] };
      },
      async updateMany(args: {
        where: { id: string; userId: string };
        data: Record<string, unknown>;
      }): Promise<{ count: number }> {
        const list = lists.find(
          (l) => l.id === args.where.id && l.userId === args.where.userId,
        );
        if (!list) return { count: 0 };
        Object.assign(list, args.data);
        list.updatedAt = new Date("2026-07-22T13:00:00.000Z");
        return { count: 1 };
      },
      async deleteMany(args: {
        where: { id: string; userId: string };
      }): Promise<{ count: number }> {
        const idx = lists.findIndex(
          (l) => l.id === args.where.id && l.userId === args.where.userId,
        );
        if (idx === -1) return { count: 0 };
        lists.splice(idx, 1);
        return { count: 1 };
      },
      async findMany(args: {
        where: { userId: string; isPublic?: boolean };
      }): Promise<Record<string, unknown>[]> {
        return lists
          .filter((l) => {
            if (l.userId !== args.where.userId) return false;
            if (
              args.where.isPublic !== undefined &&
              l.isPublic !== args.where.isPublic
            ) {
              return false;
            }
            return true;
          })
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((l) => ({
            id: l.id,
            title: l.title,
            description: l.description,
            isRanked: l.isRanked,
            isPublic: l.isPublic,
            createdAt: l.createdAt,
            updatedAt: l.updatedAt,
            _count: { items: items.filter((i) => i.listId === l.id).length },
          }));
      },
    },
    listItem: {
      async findMany(args: {
        where: { listId: string };
      }): Promise<{ id: string; position: number }[]> {
        return items
          .filter((i) => i.listId === args.where.listId)
          .sort((a, b) => a.position - b.position)
          .map((i) => ({ id: i.id, position: i.position }));
      },
      async create(args: {
        data: {
          listId: string;
          albumId: string;
          position: number;
          note: string | null;
        };
      }): Promise<StoredItem> {
        const duplicate = items.some(
          (i) =>
            i.listId === args.data.listId && i.albumId === args.data.albumId,
        );
        if (duplicate) {
          throw uniqueConstraintError();
        }
        const item: StoredItem = {
          id: nextId(),
          listId: args.data.listId,
          albumId: args.data.albumId,
          position: args.data.position,
          note: args.data.note,
        };
        items.push(item);
        return item;
      },
      async deleteMany(args: {
        where: { id: string; listId: string };
      }): Promise<{ count: number }> {
        const before = items.length;
        for (let i = items.length - 1; i >= 0; i -= 1) {
          if (
            items[i].id === args.where.id &&
            items[i].listId === args.where.listId
          ) {
            items.splice(i, 1);
          }
        }
        return { count: before - items.length };
      },
      async update(args: {
        where: { id: string };
        data: { position: number };
      }): Promise<StoredItem> {
        const item = items.find((i) => i.id === args.where.id);
        if (!item) {
          throw new Prisma.PrismaClientKnownRequestError("Record not found", {
            code: "P2025",
            clientVersion: "test",
          });
        }
        item.position = args.data.position;
        return item;
      },
    },
    listLike: {
      async create(args: {
        data: { userId: string; listId: string };
      }): Promise<StoredListLike> {
        const { userId, listId } = args.data;
        // Real FK: the list must still exist (P2003 → 404). `loadListForViewer`
        // and this `create` are separate, non-transactional round trips, so a
        // list deleted in that window (see `afterAccessLoad`) IS reachable
        // here and must be handled the same way `addItem`/`reviewLike.create`
        // do — this is not unreachable code.
        if (!lists.some((l) => l.id === listId)) {
          throw listLikeForeignKeyError();
        }
        // Real composite PK: a second like is a constraint violation, never a
        // silent no-op (P2002 → 409). The DB is the single arbiter — the
        // service issues no `findUnique` pre-check, so there is no TOCTOU
        // window to test around.
        if (listLikes.some((l) => l.userId === userId && l.listId === listId)) {
          throw listLikeUniqueConstraintError();
        }
        const row: StoredListLike = { userId, listId };
        listLikes.push(row);
        return row;
      },
      async deleteMany(args: {
        where: { userId: string; listId: string };
      }): Promise<{ count: number }> {
        const { userId, listId } = args.where;
        let count = 0;
        for (let i = listLikes.length - 1; i >= 0; i -= 1) {
          if (
            listLikes[i].userId === userId &&
            listLikes[i].listId === listId
          ) {
            listLikes.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      },
      async count(args: { where: { listId: string } }): Promise<number> {
        return likesForList(args.where.listId);
      },
      async findUnique(args: {
        where: { userId_listId: { userId: string; listId: string } };
      }): Promise<{ userId: string } | null> {
        const key = args.where.userId_listId;
        likeLookups.push(key);
        const hit = listLikes.find(
          (l) => l.userId === key.userId && l.listId === key.listId,
        );
        return hit ? { userId: hit.userId } : null;
      },
    },
    async $transaction<T>(fn: (tx: typeof client) => Promise<T>): Promise<T> {
      return fn(client);
    },
  };

  return {
    prisma: { client } as unknown as PrismaService,
    usersByClerk,
    usersByUsername,
    lists,
    items,
    listLikes,
    likeLookups,
    hooks,
  };
}

describe("ListsService", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let service: ListsService;

  beforeEach(() => {
    fake = createFakePrisma();
    service = new ListsService(fake.prisma);
    fake.usersByClerk.set(OWNER_CLERK, OWNER_ID);
    fake.usersByClerk.set(OTHER_CLERK, OTHER_ID);
    fake.usersByUsername.set(OWNER_USERNAME, OWNER_ID);
  });

  function seedList(overrides: Partial<StoredList> = {}): StoredList {
    const list: StoredList = {
      id: overrides.id ?? PUBLIC_LIST_ID,
      userId: overrides.userId ?? OWNER_ID,
      title: overrides.title ?? "Best of 2026",
      description: overrides.description ?? null,
      isRanked: overrides.isRanked ?? false,
      isPublic: overrides.isPublic ?? true,
      createdAt: overrides.createdAt ?? new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: overrides.updatedAt ?? new Date("2026-07-01T00:00:00.000Z"),
    };
    fake.lists.push(list);
    return list;
  }

  describe("createList", () => {
    it("creates an owner-scoped list and returns its detail with empty items", async () => {
      const detail = await service.createList(OWNER_CLERK, {
        title: "  Best of 2026  ",
        description: "  my picks  ",
        isRanked: true,
        isPublic: false,
      });

      expect(detail).toMatchObject({
        userId: OWNER_ID,
        title: "Best of 2026",
        description: "my picks",
        isRanked: true,
        isPublic: false,
        items: [],
      });
      expect(fake.lists).toHaveLength(1);
      expect(fake.lists[0].userId).toBe(OWNER_ID);
    });

    it("defaults isRanked=false and isPublic=true when the flags are omitted", async () => {
      const detail = await service.createList(OWNER_CLERK, {
        title: "Untitled",
      });

      expect(detail.isRanked).toBe(false);
      expect(detail.isPublic).toBe(true);
      expect(detail.description).toBeNull();
    });

    it("rejects a blank title with a 400 and creates no row", async () => {
      await expect(
        service.createList(OWNER_CLERK, { title: "   " }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.lists).toHaveLength(0);
    });

    it("rejects an unsynced caller with a 404", async () => {
      await expect(
        service.createList("unsynced_clerk", { title: "X" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.lists).toHaveLength(0);
    });

    it("rejects a title longer than MAX_TITLE_LENGTH with a 400", async () => {
      await expect(
        service.createList(OWNER_CLERK, {
          title: "a".repeat(MAX_TITLE_LENGTH + 1),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.lists).toHaveLength(0);
    });

    it("rejects a non-string description with a 400", async () => {
      await expect(
        service.createList(OWNER_CLERK, { title: "OK", description: 123 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.lists).toHaveLength(0);
    });

    it("rejects a description longer than MAX_DESCRIPTION_LENGTH with a 400", async () => {
      await expect(
        service.createList(OWNER_CLERK, {
          title: "OK",
          description: "a".repeat(MAX_DESCRIPTION_LENGTH + 1),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.lists).toHaveLength(0);
    });

    it("rejects a non-boolean isRanked (string 'true') with a 400", async () => {
      await expect(
        service.createList(OWNER_CLERK, { title: "OK", isRanked: "true" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.lists).toHaveLength(0);
    });

    it("rejects a non-boolean isPublic (string 'true') with a 400", async () => {
      await expect(
        service.createList(OWNER_CLERK, { title: "OK", isPublic: "true" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.lists).toHaveLength(0);
    });
  });

  describe("getList", () => {
    it("lets the owner read their own PRIVATE list, with items mapped", async () => {
      seedList({ id: PRIVATE_LIST_ID, isPublic: false });
      fake.items.push({
        id: "item-1",
        listId: PRIVATE_LIST_ID,
        albumId: ALBUM_ID,
        position: 1,
        note: "opener",
      });

      const detail = await service.getList(OWNER_CLERK, PRIVATE_LIST_ID);

      expect(detail.id).toBe(PRIVATE_LIST_ID);
      expect(detail.isPublic).toBe(false);
      expect(detail.items).toEqual([
        {
          id: "item-1",
          position: 1,
          note: "opener",
          album: {
            id: ALBUM_ID,
            title: "OK Computer",
            coverUrl: "https://cdn.coda.test/ok.jpg",
            primaryArtistName: "Radiohead",
          },
        },
      ]);
    });

    it("lets a non-owner read a PUBLIC list", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });

      const detail = await service.getList(OTHER_CLERK, PUBLIC_LIST_ID);

      expect(detail.id).toBe(PUBLIC_LIST_ID);
      expect(detail.userId).toBe(OWNER_ID);
    });

    it("lets an UNSYNCED caller read a PUBLIC list (read-only unsynced access)", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });

      const detail = await service.getList("unsynced_clerk", PUBLIC_LIST_ID);

      expect(detail.id).toBe(PUBLIC_LIST_ID);
      expect(detail.userId).toBe(OWNER_ID);
    });

    it("returns 404 (not 403) when a non-owner reads a PRIVATE list", async () => {
      seedList({ id: PRIVATE_LIST_ID, isPublic: false });

      await expect(
        service.getList(OTHER_CLERK, PRIVATE_LIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns 404 for an unknown list id", async () => {
      await expect(
        service.getList(OWNER_CLERK, UNKNOWN_LIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects a malformed list id with a 400", async () => {
      await expect(
        service.getList(OWNER_CLERK, "not-a-uuid"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("updateList", () => {
    it("lets the owner edit title and flags and returns the updated detail", async () => {
      seedList({ id: PUBLIC_LIST_ID, title: "Old", isPublic: true });

      const detail = await service.updateList(OWNER_CLERK, PUBLIC_LIST_ID, {
        title: "New title",
        isPublic: false,
      });

      expect(detail.title).toBe("New title");
      expect(detail.isPublic).toBe(false);
      expect(fake.lists[0].title).toBe("New title");
      expect(fake.lists[0].isPublic).toBe(false);
    });

    it("rejects a non-owner editing a PUBLIC list with a 403", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });

      await expect(
        service.updateList(OTHER_CLERK, PUBLIC_LIST_ID, { title: "hijack" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fake.lists[0].title).toBe("Best of 2026");
    });

    it("returns 404 (not 403) when a non-owner edits a PRIVATE list", async () => {
      seedList({ id: PRIVATE_LIST_ID, isPublic: false });

      await expect(
        service.updateList(OTHER_CLERK, PRIVATE_LIST_ID, { title: "hijack" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("returns 404 for an unknown list id", async () => {
      await expect(
        service.updateList(OWNER_CLERK, UNKNOWN_LIST_ID, { title: "x" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects an unsynced caller with a 404", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.updateList("unsynced_clerk", PUBLIC_LIST_ID, { title: "x" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.lists[0].title).toBe("Best of 2026");
    });

    it("rejects an empty patch (no updatable fields) with a 400", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.updateList(OWNER_CLERK, PUBLIC_LIST_ID, {}),
      ).rejects.toThrow("No fields to update.");
    });

    it("rejects a title longer than MAX_TITLE_LENGTH with a 400", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.updateList(OWNER_CLERK, PUBLIC_LIST_ID, {
          title: "a".repeat(MAX_TITLE_LENGTH + 1),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.lists[0].title).toBe("Best of 2026");
    });

    it("rejects a non-string description with a 400", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.updateList(OWNER_CLERK, PUBLIC_LIST_ID, { description: 123 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a description longer than MAX_DESCRIPTION_LENGTH with a 400", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.updateList(OWNER_CLERK, PUBLIC_LIST_ID, {
          description: "a".repeat(MAX_DESCRIPTION_LENGTH + 1),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a non-boolean isRanked (string 'true') with a 400", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.updateList(OWNER_CLERK, PUBLIC_LIST_ID, { isRanked: "true" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a non-boolean isPublic (string 'true') with a 400", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.updateList(OWNER_CLERK, PUBLIC_LIST_ID, { isPublic: "true" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("deleteList", () => {
    it("lets the owner delete their own list", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.deleteList(OWNER_CLERK, PUBLIC_LIST_ID),
      ).resolves.toBeUndefined();
      expect(fake.lists).toHaveLength(0);
    });

    it("rejects a non-owner deleting a PUBLIC list with a 403", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });

      await expect(
        service.deleteList(OTHER_CLERK, PUBLIC_LIST_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fake.lists).toHaveLength(1);
    });

    it("returns 404 (not 403) when a non-owner deletes a PRIVATE list", async () => {
      seedList({ id: PRIVATE_LIST_ID, isPublic: false });

      await expect(
        service.deleteList(OTHER_CLERK, PRIVATE_LIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.lists).toHaveLength(1);
    });

    it("rejects an unsynced caller with a 404", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.deleteList("unsynced_clerk", PUBLIC_LIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.lists).toHaveLength(1);
    });
  });

  describe("getUserLists", () => {
    beforeEach(() => {
      seedList({
        id: PUBLIC_LIST_ID,
        title: "Public picks",
        isPublic: true,
        createdAt: new Date("2026-07-02T00:00:00.000Z"),
      });
      seedList({
        id: PRIVATE_LIST_ID,
        title: "Secret stash",
        isPublic: false,
        createdAt: new Date("2026-07-03T00:00:00.000Z"),
      });
    });

    it("shows the owner ALL their lists (public and private), newest first", async () => {
      const summaries = await service.getUserLists(OWNER_CLERK, OWNER_USERNAME);

      expect(summaries.map((s) => s.id)).toEqual([
        PRIVATE_LIST_ID,
        PUBLIC_LIST_ID,
      ]);
      expect(summaries.map((s) => s.isPublic)).toEqual([false, true]);
    });

    it("shows a non-owner ONLY the public lists", async () => {
      const summaries = await service.getUserLists(OTHER_CLERK, OWNER_USERNAME);

      expect(summaries.map((s) => s.id)).toEqual([PUBLIC_LIST_ID]);
      expect(summaries[0].isPublic).toBe(true);
    });

    it("shows a non-owner only public lists even when the caller is unsynced", async () => {
      const summaries = await service.getUserLists(
        "unsynced_clerk",
        OWNER_USERNAME,
      );

      expect(summaries.map((s) => s.id)).toEqual([PUBLIC_LIST_ID]);
    });

    it("reports each list's item count", async () => {
      fake.items.push({
        id: "item-1",
        listId: PUBLIC_LIST_ID,
        albumId: ALBUM_ID,
        position: 1,
        note: null,
      });
      fake.items.push({
        id: "item-2",
        listId: PUBLIC_LIST_ID,
        albumId: ALBUM_ID,
        position: 2,
        note: null,
      });

      const summaries = await service.getUserLists(OTHER_CLERK, OWNER_USERNAME);

      expect(summaries[0].itemCount).toBe(2);
    });

    it("returns an empty array for a profile with no lists (not an error)", async () => {
      fake.usersByUsername.set("empty", OTHER_ID);

      const summaries = await service.getUserLists(OWNER_CLERK, "empty");

      expect(summaries).toEqual([]);
    });

    it("throws 404 for an unknown username", async () => {
      await expect(
        service.getUserLists(OWNER_CLERK, "ghost"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  function seedItem(overrides: Partial<StoredItem> = {}): StoredItem {
    const item: StoredItem = {
      id: overrides.id ?? ITEM_ID_1,
      listId: overrides.listId ?? PUBLIC_LIST_ID,
      albumId: overrides.albumId ?? ALBUM_ID,
      position: overrides.position ?? 1,
      note: overrides.note ?? null,
    };
    fake.items.push(item);
    return item;
  }

  describe("addItem", () => {
    it("appends the first album at position 1 and returns the detail", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      const detail = await service.addItem(OWNER_CLERK, PUBLIC_LIST_ID, {
        albumId: ALBUM_ID,
      });

      expect(detail.items).toHaveLength(1);
      expect(detail.items[0].position).toBe(1);
      expect(fake.items).toHaveLength(1);
      expect(fake.items[0]).toMatchObject({
        listId: PUBLIC_LIST_ID,
        albumId: ALBUM_ID,
        position: 1,
      });
    });

    it("appends a second album at position 2, keeping positions contiguous", async () => {
      seedList({ id: PUBLIC_LIST_ID });
      seedItem({ id: ITEM_ID_1, albumId: ALBUM_ID, position: 1 });

      const detail = await service.addItem(OWNER_CLERK, PUBLIC_LIST_ID, {
        albumId: ALBUM_ID_2,
      });

      expect(detail.items.map((i) => i.position)).toEqual([1, 2]);
      expect(fake.items).toHaveLength(2);
    });

    it("stores a trimmed note and null for a blank note", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await service.addItem(OWNER_CLERK, PUBLIC_LIST_ID, {
        albumId: ALBUM_ID,
        note: "  opener  ",
      });
      await service.addItem(OWNER_CLERK, PUBLIC_LIST_ID, {
        albumId: ALBUM_ID_2,
        note: "   ",
      });

      expect(fake.items[0].note).toBe("opener");
      expect(fake.items[1].note).toBeNull();
    });

    it("rejects a duplicate album with a 409 (unique-constraint violation)", async () => {
      seedList({ id: PUBLIC_LIST_ID });
      seedItem({ id: ITEM_ID_1, albumId: ALBUM_ID, position: 1 });

      await expect(
        service.addItem(OWNER_CLERK, PUBLIC_LIST_ID, { albumId: ALBUM_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(fake.items).toHaveLength(1);
    });

    it("rejects a non-owner adding to a PUBLIC list with a 403", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });

      await expect(
        service.addItem(OTHER_CLERK, PUBLIC_LIST_ID, { albumId: ALBUM_ID }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fake.items).toHaveLength(0);
    });

    it("returns 404 (not 403) when a non-owner adds to a PRIVATE list", async () => {
      seedList({ id: PRIVATE_LIST_ID, isPublic: false });

      await expect(
        service.addItem(OTHER_CLERK, PRIVATE_LIST_ID, { albumId: ALBUM_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.items).toHaveLength(0);
    });

    it("rejects an unsynced caller with a 404", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.addItem("unsynced_clerk", PUBLIC_LIST_ID, {
          albumId: ALBUM_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.items).toHaveLength(0);
    });

    it("rejects a malformed albumId with a 400", async () => {
      seedList({ id: PUBLIC_LIST_ID });

      await expect(
        service.addItem(OWNER_CLERK, PUBLIC_LIST_ID, { albumId: "not-a-uuid" }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.items).toHaveLength(0);
    });
  });

  describe("removeItem", () => {
    beforeEach(() => {
      seedList({ id: PUBLIC_LIST_ID });
      seedItem({ id: ITEM_ID_1, albumId: ALBUM_ID, position: 1 });
      seedItem({ id: ITEM_ID_2, albumId: ALBUM_ID_2, position: 2 });
      seedItem({ id: ITEM_ID_3, albumId: ALBUM_ID_3, position: 3 });
    });

    it("removes the middle item and renumbers the rest to contiguous 1,2", async () => {
      const detail = await service.removeItem(
        OWNER_CLERK,
        PUBLIC_LIST_ID,
        ITEM_ID_2,
      );

      expect(detail.items).toHaveLength(2);
      expect(detail.items.map((i) => i.position)).toEqual([1, 2]);
      expect(detail.items.map((i) => i.id)).toEqual([ITEM_ID_1, ITEM_ID_3]);
    });

    it("returns 404 for an unknown item id", async () => {
      await expect(
        service.removeItem(OWNER_CLERK, PUBLIC_LIST_ID, UNKNOWN_ITEM_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.items).toHaveLength(3);
    });

    it("returns 404 when the item belongs to a DIFFERENT list (scoped delete)", async () => {
      seedList({ id: OTHER_LIST_ID, isPublic: true });
      const foreign = seedItem({
        id: "20000000-0000-4000-8000-000000000001",
        listId: OTHER_LIST_ID,
        albumId: ALBUM_ID,
        position: 1,
      });

      await expect(
        service.removeItem(OWNER_CLERK, PUBLIC_LIST_ID, foreign.id),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.items.some((i) => i.id === foreign.id)).toBe(true);
    });

    it("rejects a non-owner removing from a PUBLIC list with a 403", async () => {
      await expect(
        service.removeItem(OTHER_CLERK, PUBLIC_LIST_ID, ITEM_ID_1),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fake.items).toHaveLength(3);
    });

    it("returns 404 (not 403) when a non-owner removes from a PRIVATE list", async () => {
      seedList({ id: PRIVATE_LIST_ID, isPublic: false });
      seedItem({
        id: "30000000-0000-4000-8000-000000000001",
        listId: PRIVATE_LIST_ID,
        albumId: ALBUM_ID,
        position: 1,
      });

      await expect(
        service.removeItem(
          OTHER_CLERK,
          PRIVATE_LIST_ID,
          "30000000-0000-4000-8000-000000000001",
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("reorder", () => {
    beforeEach(() => {
      seedList({ id: PUBLIC_LIST_ID });
      seedItem({ id: ITEM_ID_1, albumId: ALBUM_ID, position: 1 });
      seedItem({ id: ITEM_ID_2, albumId: ALBUM_ID_2, position: 2 });
      seedItem({ id: ITEM_ID_3, albumId: ALBUM_ID_3, position: 3 });
    });

    it("renumbers to the requested order, contiguous and unique", async () => {
      const detail = await service.reorder(OWNER_CLERK, PUBLIC_LIST_ID, {
        itemIds: [ITEM_ID_3, ITEM_ID_1, ITEM_ID_2],
      });

      expect(detail.items.map((i) => i.id)).toEqual([
        ITEM_ID_3,
        ITEM_ID_1,
        ITEM_ID_2,
      ]);
      expect(detail.items.map((i) => i.position)).toEqual([1, 2, 3]);
    });

    it("is a no-op for a single-item list", async () => {
      fake.items.length = 0;
      seedItem({ id: ITEM_ID_1, albumId: ALBUM_ID, position: 1 });

      const detail = await service.reorder(OWNER_CLERK, PUBLIC_LIST_ID, {
        itemIds: [ITEM_ID_1],
      });

      expect(detail.items).toHaveLength(1);
      expect(detail.items[0]).toMatchObject({ id: ITEM_ID_1, position: 1 });
    });

    it("rejects an itemIds shorter than the list (dropped item) with a 400", async () => {
      await expect(
        service.reorder(OWNER_CLERK, PUBLIC_LIST_ID, {
          itemIds: [ITEM_ID_1, ITEM_ID_2],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fake.items.map((i) => i.position).sort()).toEqual([1, 2, 3]);
    });

    it("rejects a duplicate-ID array that masks a dropped item with a 400", async () => {
      await expect(
        service.reorder(OWNER_CLERK, PUBLIC_LIST_ID, {
          itemIds: [ITEM_ID_1, ITEM_ID_1, ITEM_ID_2],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects an array containing an id not on the list with a 400", async () => {
      await expect(
        service.reorder(OWNER_CLERK, PUBLIC_LIST_ID, {
          itemIds: [ITEM_ID_1, ITEM_ID_2, UNKNOWN_ITEM_ID],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a non-array itemIds with a 400", async () => {
      await expect(
        service.reorder(OWNER_CLERK, PUBLIC_LIST_ID, {
          itemIds: "not-an-array",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a malformed id element with a 400", async () => {
      await expect(
        service.reorder(OWNER_CLERK, PUBLIC_LIST_ID, {
          itemIds: [ITEM_ID_1, ITEM_ID_2, "not-a-uuid"],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a non-owner reordering a PUBLIC list with a 403", async () => {
      await expect(
        service.reorder(OTHER_CLERK, PUBLIC_LIST_ID, {
          itemIds: [ITEM_ID_3, ITEM_ID_2, ITEM_ID_1],
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(fake.items.map((i) => i.position)).toEqual([1, 2, 3]);
    });

    it("returns 404 (not 403) when a non-owner reorders a PRIVATE list", async () => {
      seedList({ id: PRIVATE_LIST_ID, isPublic: false });
      seedItem({
        id: "40000000-0000-4000-8000-000000000001",
        listId: PRIVATE_LIST_ID,
        albumId: ALBUM_ID,
        position: 1,
      });

      await expect(
        service.reorder(OTHER_CLERK, PRIVATE_LIST_ID, {
          itemIds: ["40000000-0000-4000-8000-000000000001"],
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /**
   * List likes (Fase 2 slice 3, design Decisions 3-5). The access rule is the
   * READ rule — `loadListForViewer`, NOT `loadListForOwnerAction` — because
   * liking is a VISITOR action: gating it on ownership would 403 every
   * non-owner, the exact inverse of the requirement. That yields the spec's
   * matrix: owner→ok (self-like allowed), public→ok, private+non-owner→404.
   */
  describe("likeList / unlikeList", () => {
    it("lets the OWNER like their own PUBLIC list (self-like is allowed)", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });

      const result = await service.likeList(OWNER_CLERK, PUBLIC_LIST_ID);

      expect(result).toEqual({ likeCount: 1, hasLiked: true });
      expect(fake.listLikes).toEqual([
        { userId: OWNER_ID, listId: PUBLIC_LIST_ID },
      ]);
    });

    it("lets the OWNER like their own PRIVATE list", async () => {
      seedList({ id: PRIVATE_LIST_ID, isPublic: false });

      const result = await service.likeList(OWNER_CLERK, PRIVATE_LIST_ID);

      expect(result).toEqual({ likeCount: 1, hasLiked: true });
    });

    it("lets a NON-OWNER like a PUBLIC list", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });

      const result = await service.likeList(OTHER_CLERK, PUBLIC_LIST_ID);

      expect(result).toEqual({ likeCount: 1, hasLiked: true });
      expect(fake.listLikes).toEqual([
        { userId: OTHER_ID, listId: PUBLIC_LIST_ID },
      ]);
    });

    it("returns 404 (not 403) when a NON-OWNER likes a PRIVATE list, writing no row", async () => {
      seedList({ id: PRIVATE_LIST_ID, isPublic: false });

      await expect(
        service.likeList(OTHER_CLERK, PRIVATE_LIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.listLikes).toHaveLength(0);
    });

    it("returns 404 for an unknown list id, writing no row", async () => {
      await expect(
        service.likeList(OWNER_CLERK, UNKNOWN_LIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.listLikes).toHaveLength(0);
    });

    it("rejects a DUPLICATE like with a 409, leaving the single original row intact", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });
      await service.likeList(OTHER_CLERK, PUBLIC_LIST_ID);

      // The second like must surface the P2002 as a 409 — NOT a 500, and NOT a
      // silently idempotent 200 (`likeList` deliberately does not mirror
      // `follow()`'s upsert). Idempotency is a DATA-layer invariant enforced by
      // the composite PK; the 409 is the honest HTTP report that the write was
      // refused. This also pins that the mapping uses a BARE
      // `isUniqueConstraintViolation` — see `listLikeUniqueConstraintError`.
      await expect(
        service.likeList(OTHER_CLERK, PUBLIC_LIST_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(fake.listLikes).toHaveLength(1);
    });

    it("maps a list deleted between the access check and the like write to 404, not a raw 500", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });
      // Simulates the owner deleting the list from another tab while this
      // like request is in flight: `loadListForViewer` and `listLike.create`
      // are separate, non-transactional round trips, so the list can vanish
      // in between, raising a genuine P2003.
      fake.hooks.afterAccessLoad = () => {
        fake.lists.length = 0;
        delete fake.hooks.afterAccessLoad;
      };

      await expect(
        service.likeList(OWNER_CLERK, PUBLIC_LIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.listLikes).toHaveLength(0);
    });

    it("removes the like on unlike and decrements the count", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });
      await service.likeList(OWNER_CLERK, PUBLIC_LIST_ID);
      await service.likeList(OTHER_CLERK, PUBLIC_LIST_ID);

      const result = await service.unlikeList(OTHER_CLERK, PUBLIC_LIST_ID);

      expect(result).toEqual({ likeCount: 1, hasLiked: false });
      expect(fake.listLikes).toEqual([
        { userId: OWNER_ID, listId: PUBLIC_LIST_ID },
      ]);
    });

    it("treats unliking a list that was never liked as a 200 no-op (never 404/409)", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });

      // The spec constrains only the duplicate-LIKE direction. Unlike stays
      // tolerant via `deleteMany`, matching the follow/unfollow precedent — do
      // NOT mirror the 409 here.
      const result = await service.unlikeList(OTHER_CLERK, PUBLIC_LIST_ID);

      expect(result).toEqual({ likeCount: 0, hasLiked: false });
      expect(fake.listLikes).toHaveLength(0);
    });

    it("applies the SAME access rule to unlike: a non-owner unliking a PRIVATE list is a 404", async () => {
      seedList({ id: PRIVATE_LIST_ID, isPublic: false });

      await expect(
        service.unlikeList(OTHER_CLERK, PRIVATE_LIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects an UNSYNCED caller with a 404 on both like and unlike", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });

      // Liking is a WRITE, so it uses `requireCallerId` (404 for a caller with
      // no local User row) rather than `getList`'s null-tolerant resolution.
      await expect(
        service.likeList("unsynced_clerk", PUBLIC_LIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.unlikeList("unsynced_clerk", PUBLIC_LIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(fake.listLikes).toHaveLength(0);
    });

    it("rejects a malformed list id with a 400 on both like and unlike", async () => {
      await expect(
        service.likeList(OWNER_CLERK, "not-a-uuid"),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.unlikeList(OWNER_CLERK, "not-a-uuid"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("ListDetail like projection", () => {
    it("reports likeCount and viewerHasLiked=true for a viewer who liked the list", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });
      await service.likeList(OWNER_CLERK, PUBLIC_LIST_ID);
      await service.likeList(OTHER_CLERK, PUBLIC_LIST_ID);

      const detail = await service.getList(OTHER_CLERK, PUBLIC_LIST_ID);

      expect(detail.likeCount).toBe(2);
      expect(detail.viewerHasLiked).toBe(true);
    });

    it("reports viewerHasLiked=false for a viewer who has not liked it, without hiding the count", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });
      await service.likeList(OWNER_CLERK, PUBLIC_LIST_ID);

      const detail = await service.getList(OTHER_CLERK, PUBLIC_LIST_ID);

      expect(detail.likeCount).toBe(1);
      expect(detail.viewerHasLiked).toBe(false);
    });

    it("resolves an UNSYNCED viewer to viewerHasLiked=false WITHOUT any like lookup", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });
      await service.likeList(OWNER_CLERK, PUBLIC_LIST_ID);
      fake.likeLookups.length = 0;

      const detail = await service.getList("unsynced_clerk", PUBLIC_LIST_ID);

      expect(detail.likeCount).toBe(1);
      expect(detail.viewerHasLiked).toBe(false);
      // A null viewer has no local id to key the composite lookup on, so the
      // service must short-circuit rather than issue a query with `undefined`.
      expect(fake.likeLookups).toHaveLength(0);
    });

    it("returns likeCount=0 / viewerHasLiked=false on a freshly created list", async () => {
      const detail = await service.createList(OWNER_CLERK, { title: "New" });

      expect(detail.likeCount).toBe(0);
      expect(detail.viewerHasLiked).toBe(false);
    });

    it("keeps the like projection accurate on the detail returned by a MUTATION", async () => {
      seedList({ id: PUBLIC_LIST_ID, isPublic: true });
      await service.likeList(OTHER_CLERK, PUBLIC_LIST_ID);

      // `updateList` re-reads through `getListByIdOrThrow`, which must thread
      // the caller through to the viewer projection like `getList` does — the
      // owner here has NOT liked their own list, so a hardcoded `true`/`false`
      // or a dropped caller would show up as a wrong `viewerHasLiked`.
      const detail = await service.updateList(OWNER_CLERK, PUBLIC_LIST_ID, {
        title: "Renamed",
      });

      expect(detail.title).toBe("Renamed");
      expect(detail.likeCount).toBe(1);
      expect(detail.viewerHasLiked).toBe(false);
    });
  });
});
