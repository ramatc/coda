import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import { isUniqueConstraintViolation } from "../prisma/prisma-error.util.js";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TITLE_LENGTH,
  UUID_PATTERN,
} from "./lists.constants.js";

/** Payload accepted by {@link ListsService.createList}. */
export interface CreateListInput {
  title?: unknown;
  description?: unknown;
  isRanked?: unknown;
  isPublic?: unknown;
}

/** Partial payload accepted by {@link ListsService.updateList}. */
export interface UpdateListInput {
  title?: unknown;
  description?: unknown;
  isRanked?: unknown;
  isPublic?: unknown;
}

/** Payload accepted by {@link ListsService.addItem}. */
export interface AddItemInput {
  albumId?: unknown;
  note?: unknown;
}

/** Payload accepted by {@link ListsService.reorder}. */
export interface ReorderInput {
  itemIds?: unknown;
}

/** One item on a list's detail view, with its album denormalized for render. */
export interface ListItemView {
  id: string;
  position: number;
  note: string | null;
  album: {
    id: string;
    title: string;
    coverUrl: string | null;
    primaryArtistName: string;
  };
}

/** The full detail of a single list, consumed by `apps/web/app/lists/[id]`. */
export interface ListDetail {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
  items: ListItemView[];
}

/** A compact list row for the profile Lists section (no items, just a count). */
export interface ListSummary {
  id: string;
  title: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Access-check projection of a list: just what the visibility branch needs. */
interface ListAccessRow {
  userId: string;
  isPublic: boolean;
}

/** Normalized, validated create payload ready to hand to Prisma. */
interface ValidatedCreate {
  title: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
}

/**
 * Curated album lists (Fase 2 slice 2): backs list CRUD plus the profile Lists
 * section. Mirrors the `social` module's flat shape — one service owns all
 * Prisma access and manual `unknown`-typed validation with a local
 * {@link UUID_PATTERN}, running behind the global `ClerkGuard`.
 *
 * Ownership and visibility are enforced INLINE via two private helpers
 * ({@link ListsService.loadListForViewer} for reads,
 * {@link ListsService.loadListForOwnerAction} for mutations), because the
 * codebase has no public/private guard/decorator pattern (follows are public;
 * tracking scopes rows inline). Centralizing the 403-vs-404 branch in one place
 * per access mode prevents drift:
 *
 * ```
 * READ:     owner→ok | public→ok | private→404
 * MUTATION: owner→ok | public→403 | private→404
 * ```
 *
 * A private list is hidden as 404 (not 403) to avoid leaking its existence.
 * `PATCH`/`DELETE` additionally use `updateMany`/`deleteMany({ id, userId })`
 * with `count === 0 → 404` as a race-safety net AFTER the owner check has
 * already authorized the caller — so a double-tab request that loses a race
 * against a concurrent delete returns 404 instead of an unhandled P2025 (500).
 */
@Injectable()
export class ListsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a list owned by the caller. Requires a synced local `User` row
   * (an unsynced caller is a 404, matching the tracking/social write paths).
   */
  async createList(
    clerkUserId: string,
    input: CreateListInput,
  ): Promise<ListDetail> {
    const userId = await this.requireCallerId(clerkUserId);
    const data = this.validateCreate(input);

    const list = await this.prisma.client.list.create({
      data: { userId, ...data },
    });

    return this.toDetail(list as unknown as ListRow);
  }

  /**
   * Returns a single list with its ordered items. Visibility follows the READ
   * rule: the owner always sees their own list; a public list is visible to
   * anyone; a private list is 404 for a non-owner (hides existence). An unsynced
   * caller can still read public lists (resolves to a `null` caller id).
   */
  async getList(clerkUserId: string, listId: unknown): Promise<ListDetail> {
    const id = this.validateListId(listId);
    const callerId = await this.resolveUserId(clerkUserId);
    await this.loadListForViewer(callerId, id);

    const list = await this.prisma.client.list.findUnique({
      where: { id },
      select: LIST_DETAIL_SELECT,
    });
    if (!list) {
      // Extremely narrow race (deleted between the access check and this read).
      throw new NotFoundException("List not found.");
    }
    return this.toDetail(list as unknown as ListRow);
  }

  /**
   * Edits the caller's own list (title/description/flags). Non-owner access is
   * rejected by {@link loadListForOwnerAction} (403 public / 404 private) before
   * any write. The scoped `updateMany({ id, userId })` + `count === 0 → 404` is a
   * race-safety net, not the authorization check.
   */
  async updateList(
    clerkUserId: string,
    listId: unknown,
    input: UpdateListInput,
  ): Promise<ListDetail> {
    const id = this.validateListId(listId);
    const userId = await this.requireCallerId(clerkUserId);
    await this.loadListForOwnerAction(userId, id);
    const data = this.validateUpdate(input);

    const { count } = await this.prisma.client.list.updateMany({
      where: { id, userId },
      data,
    });
    if (count === 0) {
      throw new NotFoundException("List not found.");
    }

    return this.getListByIdOrThrow(id);
  }

  /**
   * Deletes the caller's own list (cascading to its items via the schema FK).
   * Non-owner access is rejected by {@link loadListForOwnerAction} (403 public /
   * 404 private) before the delete. The scoped `deleteMany({ id, userId })` +
   * `count === 0 → 404` is a race-safety net against a lost double-delete race.
   */
  async deleteList(clerkUserId: string, listId: unknown): Promise<void> {
    const id = this.validateListId(listId);
    const userId = await this.requireCallerId(clerkUserId);
    await this.loadListForOwnerAction(userId, id);

    const { count } = await this.prisma.client.list.deleteMany({
      where: { id, userId },
    });
    if (count === 0) {
      throw new NotFoundException("List not found.");
    }
  }

  /**
   * Returns the lists shown on `username`'s profile: the owner sees ALL their
   * lists (public and private); anyone else sees only the public ones. An
   * unknown username is a 404; an unsynced caller simply is not the owner.
   */
  async getUserLists(
    clerkUserId: string,
    username: string,
  ): Promise<ListSummary[]> {
    const targetId = await this.requireTargetId(username);
    const callerId = await this.resolveUserId(clerkUserId);
    const isOwner = callerId !== null && callerId === targetId;

    const rows = await this.prisma.client.list.findMany({
      where: { userId: targetId, ...(isOwner ? {} : { isPublic: true }) },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        description: true,
        isRanked: true,
        isPublic: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { items: true } },
      },
    });

    return (rows as unknown as ListSummaryRow[]).map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      isRanked: row.isRanked,
      isPublic: row.isPublic,
      itemCount: row._count.items,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * Adds an album to the caller's own list. Non-owner access is rejected by
   * {@link loadListForOwnerAction} (403 public / 404 private) before any write.
   * A duplicate album violates `@@unique([listId, albumId])` (P2002) and is
   * mapped to a 409. Positions are renumbered to a contiguous `1..n` inside the
   * transaction so the list stays gap-free.
   */
  async addItem(
    clerkUserId: string,
    listId: unknown,
    input: AddItemInput,
  ): Promise<ListDetail> {
    const id = this.validateListId(listId);
    const userId = await this.requireCallerId(clerkUserId);
    await this.loadListForOwnerAction(userId, id);
    const albumId = this.validateAlbumId(input.albumId);
    const note = this.validateNote(input.note);

    try {
      await this.prisma.client.$transaction(async (tx) => {
        const existing = await tx.listItem.findMany({
          where: { listId: id },
          orderBy: { position: "asc" },
          select: { id: true },
        });
        await tx.listItem.create({
          data: { listId: id, albumId, note, position: existing.length + 1 },
        });
        await this.renumberItems(tx, id);
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new ConflictException("This album is already on the list.");
      }
      throw err;
    }

    return this.getListByIdOrThrow(id);
  }

  /**
   * Removes an item from the caller's own list. Non-owner access is rejected by
   * {@link loadListForOwnerAction} (403 public / 404 private) before the delete.
   * The delete is scoped by both `id` AND `listId` (`deleteMany` + `count === 0
   * → 404`) so an owner cannot delete an item that belongs to a different list
   * by supplying its id directly, and a lost delete race surfaces as 404 rather
   * than an unhandled P2025 (500). Remaining items are renumbered to contiguous
   * `1..n`, preserving their relative order.
   */
  async removeItem(
    clerkUserId: string,
    listId: unknown,
    itemId: unknown,
  ): Promise<ListDetail> {
    const id = this.validateListId(listId);
    const targetItemId = this.validateItemId(itemId);
    const userId = await this.requireCallerId(clerkUserId);
    await this.loadListForOwnerAction(userId, id);

    await this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.listItem.deleteMany({
        where: { id: targetItemId, listId: id },
      });
      if (count === 0) {
        throw new NotFoundException("List item not found.");
      }
      await this.renumberItems(tx, id);
    });

    return this.getListByIdOrThrow(id);
  }

  /**
   * Reorders the caller's own list to the exact order given by `itemIds`. The
   * client (dnd-kit) sends the FULL desired order; the service validates that the
   * array is a permutation of the list's current items — same length, every
   * element unique, and set-equal to the stored ids (set equality alone is
   * insufficient: `[id1, id1, id2]` on a 3-item list must be rejected because the
   * duplicate masks a dropped item). A valid order assigns `position = index + 1`
   * per row in one transaction. A single-item list is a valid no-op. Non-owner
   * access is rejected by {@link loadListForOwnerAction} (403 public / 404
   * private) before any write.
   */
  async reorder(
    clerkUserId: string,
    listId: unknown,
    input: ReorderInput,
  ): Promise<ListDetail> {
    const id = this.validateListId(listId);
    const userId = await this.requireCallerId(clerkUserId);
    await this.loadListForOwnerAction(userId, id);
    const itemIds = this.validateItemIds(input.itemIds);

    await this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.listItem.findMany({
        where: { listId: id },
        select: { id: true },
      });
      const existingIds = new Set(existing.map((item) => item.id));
      const requestedIds = new Set(itemIds);

      const isPermutation =
        itemIds.length === existing.length &&
        requestedIds.size === itemIds.length &&
        itemIds.every((itemId) => existingIds.has(itemId));
      if (!isPermutation) {
        throw new BadRequestException(
          "itemIds must list every item on the list exactly once.",
        );
      }

      let position = 1;
      for (const itemId of itemIds) {
        await tx.listItem.update({
          where: { id: itemId },
          data: { position },
        });
        position += 1;
      }
    });

    return this.getListByIdOrThrow(id);
  }

  /**
   * READ access: resolves a list for a viewer. `null` → 404 (unknown); owner or
   * public → ok; private + non-owner → 404 (hides existence, never 403).
   */
  private async loadListForViewer(
    callerId: string | null,
    listId: string,
  ): Promise<ListAccessRow> {
    const list = await this.findAccessRow(listId);
    const isOwner = callerId !== null && callerId === list.userId;
    if (isOwner || list.isPublic) {
      return list;
    }
    throw new NotFoundException("List not found.");
  }

  /**
   * MUTATION access: resolves a list for an owner action. `null` → 404; owner →
   * ok; non-owner + public → 403; non-owner + private → 404 (hides existence).
   */
  private async loadListForOwnerAction(
    callerId: string,
    listId: string,
  ): Promise<ListAccessRow> {
    const list = await this.findAccessRow(listId);
    if (list.userId === callerId) {
      return list;
    }
    if (list.isPublic) {
      throw new ForbiddenException("You do not own this list.");
    }
    throw new NotFoundException("List not found.");
  }

  /** Loads the minimal ownership/visibility projection, 404 when absent. */
  private async findAccessRow(listId: string): Promise<ListAccessRow> {
    const list = await this.prisma.client.list.findUnique({
      where: { id: listId },
      select: { userId: true, isPublic: true },
    });
    if (!list) {
      throw new NotFoundException("List not found.");
    }
    return list;
  }

  /**
   * Reassigns every item's `position` to a contiguous `1..n` sequence, ordered
   * by the current `position` (preserving relative order). The `position` column
   * has NO unique constraint, so per-row updates are collision-free and need no
   * two-phase temp-position dance. Runs inside the caller's `$transaction`.
   */
  private async renumberItems(
    tx: Prisma.TransactionClient,
    listId: string,
  ): Promise<void> {
    const items = await tx.listItem.findMany({
      where: { listId },
      orderBy: { position: "asc" },
      select: { id: true },
    });
    let position = 1;
    for (const item of items) {
      await tx.listItem.update({
        where: { id: item.id },
        data: { position },
      });
      position += 1;
    }
  }

  /** Re-reads a full list detail by id after a mutation (owner already authorized). */
  private async getListByIdOrThrow(id: string): Promise<ListDetail> {
    const list = await this.prisma.client.list.findUnique({
      where: { id },
      select: LIST_DETAIL_SELECT,
    });
    if (!list) {
      throw new NotFoundException("List not found.");
    }
    return this.toDetail(list as unknown as ListRow);
  }

  /** Maps a persisted list row (with items) to the API detail shape. */
  private toDetail(list: ListRow): ListDetail {
    return {
      id: list.id,
      userId: list.userId,
      title: list.title,
      description: list.description,
      isRanked: list.isRanked,
      isPublic: list.isPublic,
      createdAt: list.createdAt.toISOString(),
      updatedAt: list.updatedAt.toISOString(),
      items: (list.items ?? []).map((item) => ({
        id: item.id,
        position: item.position,
        note: item.note,
        album: {
          id: item.album.id,
          title: item.album.title,
          coverUrl: item.album.coverUrl,
          primaryArtistName: item.album.primaryArtist.name,
        },
      })),
    };
  }

  /** Validates + normalizes a full create payload. */
  private validateCreate(input: CreateListInput): ValidatedCreate {
    return {
      title: this.validateTitle(input.title),
      description: this.validateDescription(input.description),
      isRanked: this.validateBoolean(input.isRanked, "isRanked") ?? false,
      isPublic: this.validateBoolean(input.isPublic, "isPublic") ?? true,
    };
  }

  /** Validates a partial update payload, rejecting an empty patch with 400. */
  private validateUpdate(input: UpdateListInput): Record<string, unknown> {
    const data: Record<string, unknown> = {};
    if (input.title !== undefined) {
      data.title = this.validateTitle(input.title);
    }
    if (input.description !== undefined) {
      data.description = this.validateDescription(input.description);
    }
    if (input.isRanked !== undefined) {
      data.isRanked = this.requireBoolean(input.isRanked, "isRanked");
    }
    if (input.isPublic !== undefined) {
      data.isPublic = this.requireBoolean(input.isPublic, "isPublic");
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException("No fields to update.");
    }
    return data;
  }

  /** A required, non-empty, length-bounded title (trimmed). */
  private validateTitle(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException("title is required.");
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_TITLE_LENGTH) {
      throw new BadRequestException(
        `title must be at most ${MAX_TITLE_LENGTH} characters.`,
      );
    }
    return trimmed;
  }

  /** An optional description: `null`/empty → `null`; else a bounded string. */
  private validateDescription(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string") {
      throw new BadRequestException("description must be a string.");
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
      throw new BadRequestException(
        `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
      );
    }
    return trimmed;
  }

  /** An optional boolean flag: `undefined` → `undefined`; else strict boolean. */
  private validateBoolean(value: unknown, field: string): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }
    return this.requireBoolean(value, field);
  }

  /** A required strict boolean, 400 on any non-boolean. */
  private requireBoolean(value: unknown, field: string): boolean {
    if (typeof value !== "boolean") {
      throw new BadRequestException(`${field} must be a boolean.`);
    }
    return value;
  }

  /** Validates a UUID-shaped id before it reaches Postgres (clean 400). */
  private validateListId(value: unknown): string {
    return this.validateUuid(value, "list id");
  }

  /** Validates the `albumId` supplied when adding an item (clean 400). */
  private validateAlbumId(value: unknown): string {
    return this.validateUuid(value, "albumId");
  }

  /** Validates an item id path/array element (clean 400). */
  private validateItemId(value: unknown): string {
    return this.validateUuid(value, "item id");
  }

  /** Validates the reorder payload is an array of UUID-shaped item ids (clean 400). */
  private validateItemIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException("itemIds must be an array.");
    }
    return value.map((entry) => this.validateItemId(entry));
  }

  /** Shared UUID-shape guard producing a clean 400 with a field-specific message. */
  private validateUuid(value: unknown, field: string): string {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (UUID_PATTERN.test(trimmed)) {
        return trimmed;
      }
    }
    throw new BadRequestException(`${field} must be a valid id.`);
  }

  /** An optional item note: `null`/empty → `null`; else a bounded, trimmed string. */
  private validateNote(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string") {
      throw new BadRequestException("note must be a string.");
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > MAX_NOTE_LENGTH) {
      throw new BadRequestException(
        `note must be at most ${MAX_NOTE_LENGTH} characters.`,
      );
    }
    return trimmed;
  }

  /**
   * Resolves the caller's local `User.id`, throwing 404 when no local row exists
   * yet (write paths require a synced account — same convention as the tracking
   * and social modules' write flows).
   */
  private async requireCallerId(clerkUserId: string): Promise<string> {
    const userId = await this.resolveUserId(clerkUserId);
    if (userId === null) {
      throw new NotFoundException("No local account for the current user.");
    }
    return userId;
  }

  /** Resolves the caller's local `User.id`, or `null` when not synced yet. */
  private async resolveUserId(clerkUserId: string): Promise<string | null> {
    const user = await this.prisma.client.user.findUnique({
      where: { clerkUserId },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  /**
   * Resolves the target user's local `User.id` from a `username`, throwing 404
   * when no profile matches. Usernames are canonicalized to lowercase, matching
   * the profile module's storage convention.
   */
  private async requireTargetId(username: string): Promise<string> {
    const profile = await this.prisma.client.profile.findUnique({
      where: { username: username.trim().toLowerCase() },
      select: { userId: true },
    });
    if (!profile) {
      throw new NotFoundException(`No user found for username ${username}.`);
    }
    return profile.userId;
  }
}

/** The Prisma `select` for a full list detail (list + ordered items + album). */
const LIST_DETAIL_SELECT = {
  id: true,
  userId: true,
  title: true,
  description: true,
  isRanked: true,
  isPublic: true,
  createdAt: true,
  updatedAt: true,
  items: {
    orderBy: { position: "asc" as const },
    select: {
      id: true,
      position: true,
      note: true,
      album: {
        select: {
          id: true,
          title: true,
          coverUrl: true,
          primaryArtist: { select: { name: true } },
        },
      },
    },
  },
} as const;

/** Row shape returned by {@link LIST_DETAIL_SELECT}. */
interface ListRow {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
  items?: {
    id: string;
    position: number;
    note: string | null;
    album: {
      id: string;
      title: string;
      coverUrl: string | null;
      primaryArtist: { name: string };
    };
  }[];
}

/** Row shape returned by the {@link ListsService.getUserLists} select. */
interface ListSummaryRow {
  id: string;
  title: string;
  description: string | null;
  isRanked: boolean;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
  _count: { items: number };
}
