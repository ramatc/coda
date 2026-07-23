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
 * extractUniqueConstraintField} resolves the `listId` column from
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
            constraint: { fields: ["listId"] },
          },
        },
      },
    },
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
  let idSeq = 0;

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
        return {
          id: list.id,
          userId: list.userId,
          title: list.title,
          description: list.description,
          isRanked: list.isRanked,
          isPublic: list.isPublic,
          createdAt: list.createdAt,
          updatedAt: list.updatedAt,
          items: itemsForList(list.id),
        };
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
      const detail = await service.createList(OWNER_CLERK, { title: "Untitled" });

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
        service.createList(OWNER_CLERK, { title: "a".repeat(MAX_TITLE_LENGTH + 1) }),
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
      const summaries = await service.getUserLists("unsynced_clerk", OWNER_USERNAME);

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
        service.addItem("unsynced_clerk", PUBLIC_LIST_ID, { albumId: ALBUM_ID }),
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
});
