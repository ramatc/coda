import { beforeEach, describe, expect, it } from "vitest";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ListsService } from "../src/lists/lists.service.js";
import type { PrismaService } from "../src/prisma/prisma.service.js";

const OWNER_CLERK = "clerk_owner";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_USERNAME = "owner";
const OTHER_CLERK = "clerk_other";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ALBUM_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PUBLIC_LIST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PRIVATE_LIST_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UNKNOWN_LIST_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

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
  });
});
