import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@coda/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  extractUniqueConstraintField,
  isForeignKeyViolation,
  isRecordNotFound,
  isUniqueConstraintViolation,
} from "../prisma/prisma-error.util.js";
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
  /** Total likes on this list, from a nested `_count` in the same query. */
  likeCount: number;
  /**
   * Whether the RESOLVED caller has liked this list. `false` for an unsynced
   * caller, who has no local `User.id` to key the composite lookup on.
   */
  viewerHasLiked: boolean;
}

/**
 * The counter projection returned by {@link ListsService.likeList} /
 * {@link ListsService.unlikeList}. Deliberately NOT a created-resource
 * representation — hence `@HttpCode(200)` on both verbs, matching the review
 * like endpoints.
 */
export interface ListLikeResult {
  likeCount: number;
  hasLiked: boolean;
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

    // A list that did not exist a moment ago cannot have been liked, so the
    // viewer projection is a constant here — no `_count` select and no like
    // lookup are needed just to write two zeroes.
    return this.toDetail(list as unknown as ListRow, false);
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
    return this.toDetail(
      list as unknown as ListRow,
      await this.hasLikedList(callerId, id),
    );
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

    return this.getListByIdOrThrow(id, userId);
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
   * mapped to a 409. The new item is appended at `existing.length + 1`, which is
   * already a contiguous position since it's added to an already-contiguous set
   * — no renumbering needed. An `albumId` that doesn't reference a real `Album`
   * violates the `ListItem.albumId` FK (P2003) and is mapped to a 404.
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
      });
    } catch (err) {
      if (
        isUniqueConstraintViolation(err) &&
        extractUniqueConstraintField(err) === "list_id"
      ) {
        throw new ConflictException("This album is already on the list.");
      }
      if (isForeignKeyViolation(err)) {
        throw new NotFoundException("Album not found.");
      }
      throw err;
    }

    return this.getListByIdOrThrow(id, userId);
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

    return this.getListByIdOrThrow(id, userId);
  }

  /**
   * Reorders the caller's own list to the exact order given by `itemIds`. The
   * client (dnd-kit) sends the FULL desired order; the service validates that the
   * array is a permutation of the list's current items — same length, every
   * element unique, and set-equal to the stored ids (set equality alone is
   * insufficient: `[id1, id1, id2]` on a 3-item list must be rejected because the
   * duplicate masks a dropped item). The cheap length check runs BEFORE the
   * per-element UUID-shape validation so a length mismatch short-circuits with a
   * 400 immediately, without validating every element of an arbitrarily large
   * array. A valid order assigns `position = index + 1` per row in one
   * transaction; the per-row updates run in canonical `id` ascending order
   * (rather than the caller-supplied order) so two concurrent reorder requests
   * on the same list always acquire row locks in the same sequence, avoiding a
   * lock-order deadlock (Postgres 55P03). A per-row update racing a concurrent
   * delete/move (P2025) is mapped to a 409 rather than an uncaught 500. A
   * single-item list is a valid no-op. Non-owner access is rejected by
   * {@link loadListForOwnerAction} (403 public / 404 private) before any write.
   */
  async reorder(
    clerkUserId: string,
    listId: unknown,
    input: ReorderInput,
  ): Promise<ListDetail> {
    const id = this.validateListId(listId);
    const userId = await this.requireCallerId(clerkUserId);
    await this.loadListForOwnerAction(userId, id);
    const rawItemIds = this.validateItemIdsShape(input.itemIds);

    await this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.listItem.findMany({
        where: { listId: id },
        select: { id: true },
      });

      if (rawItemIds.length !== existing.length) {
        throw new BadRequestException(
          "itemIds must list every item on the list exactly once.",
        );
      }

      const itemIds = rawItemIds.map((entry) => this.validateItemId(entry));
      const existingIds = new Set(existing.map((item) => item.id));
      const requestedIds = new Set(itemIds);

      const isPermutation =
        requestedIds.size === itemIds.length &&
        itemIds.every((itemId) => existingIds.has(itemId));
      if (!isPermutation) {
        throw new BadRequestException(
          "itemIds must list every item on the list exactly once.",
        );
      }

      const positionByItemId = new Map<string, number>();
      itemIds.forEach((itemId, index) => {
        positionByItemId.set(itemId, index + 1);
      });

      const canonicalOrder = [...itemIds].sort();
      for (const itemId of canonicalOrder) {
        try {
          await tx.listItem.update({
            where: { id: itemId },
            data: { position: positionByItemId.get(itemId) },
          });
        } catch (err) {
          if (isRecordNotFound(err)) {
            throw new ConflictException(
              "The list changed concurrently. Please retry.",
            );
          }
          throw err;
        }
      }
    });

    return this.getListByIdOrThrow(id, userId);
  }

  /**
   * Likes a list on the caller's behalf. Access is gated by
   * {@link loadListForViewer} — the READ rule, deliberately NOT
   * {@link loadListForOwnerAction} — because liking is a VISITOR action:
   * gating on ownership would 403 every non-owner, the exact inverse of the
   * requirement. The read rule yields precisely the required matrix: owner → ok
   * (self-liking is allowed), public → ok, private + non-owner → 404.
   *
   * The write is a plain `create()` with the database as the single arbiter —
   * no `findUnique` pre-check (which would open a TOCTOU window surfacing as a
   * raw P2002 500 under concurrency) and deliberately NOT `follow()`'s
   * `upsert` + empty `update`, because the spec's duplicate-like scenario
   * normatively requires a 409. Idempotency is guaranteed at the DATA layer
   * instead: `@@id([userId, listId])` means a second row can never exist.
   *
   * One thing NOT to "fix" here: **no `extractUniqueConstraintField`
   * discrimination.** That composite PK is the SOLE unique constraint on
   * `list_likes`, so a bare {@link isUniqueConstraintViolation} is
   * unambiguous. `addItem` needs the discrimination only because `ListItem`
   * carries both a surrogate `@id` and `@@unique([listId, albumId])`; here it
   * would match on the non-discriminating leading column (`user_id`) and add
   * brittleness for nothing.
   *
   * The access check above and `create()` below ARE, however, two separate,
   * non-transactional round trips — not one atomic operation. If the list is
   * deleted in that window (e.g. the owner deletes it from another tab while
   * a like request is in flight), `create()` raises a genuine P2003, so the
   * FK branch below is reachable and must be mapped to 404, mirroring
   * `addItem` and `reviews.likeReview`.
   */
  async likeList(
    clerkUserId: string,
    listId: unknown,
  ): Promise<ListLikeResult> {
    const id = this.validateListId(listId);
    const userId = await this.requireCallerId(clerkUserId);
    await this.loadListForViewer(userId, id);

    try {
      await this.prisma.client.listLike.create({
        data: { userId, listId: id },
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        throw new ConflictException("You already liked this list.");
      }
      if (isForeignKeyViolation(err)) {
        throw new NotFoundException("List not found.");
      }
      throw err;
    }

    return { likeCount: await this.countListLikes(id), hasLiked: true };
  }

  /**
   * Removes the caller's like. Tolerant by design: `deleteMany` scoped to the
   * caller's own row means unliking something never liked is a 200 no-op rather
   * than a 409/404. The spec only ever constrains the duplicate-LIKE direction,
   * so the 409 must NOT be mirrored here — matching the follow/unfollow
   * precedent, where only `unfollow` uses the tolerant `deleteMany`.
   *
   * The visibility check still runs first: unlike obeys the SAME access rule as
   * like, so a private list stays a 404 for a non-owner rather than leaking its
   * existence through a differently-shaped response.
   */
  async unlikeList(
    clerkUserId: string,
    listId: unknown,
  ): Promise<ListLikeResult> {
    const id = this.validateListId(listId);
    const userId = await this.requireCallerId(clerkUserId);
    await this.loadListForViewer(userId, id);

    await this.prisma.client.listLike.deleteMany({
      where: { userId, listId: id },
    });

    return { likeCount: await this.countListLikes(id), hasLiked: false };
  }

  /** Current like total for a list, read back after a like/unlike write. */
  private async countListLikes(listId: string): Promise<number> {
    return this.prisma.client.listLike.count({ where: { listId } });
  }

  /**
   * Whether the resolved caller has liked this list. A `null` caller (unsynced,
   * so no local `User` row) never reaches Prisma — there is no local id to key
   * the composite lookup on, and passing `undefined` into the `userId_listId`
   * compound `where` would raise a `PrismaClientValidationError`.
   */
  private async hasLikedList(
    callerId: string | null,
    listId: string,
  ): Promise<boolean> {
    if (callerId === null) {
      return false;
    }
    const like = await this.prisma.client.listLike.findUnique({
      where: { userId_listId: { userId: callerId, listId } },
      select: { userId: true },
    });
    return like !== null;
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
   * by the current `position` (preserving relative order), with `id` as a
   * secondary tiebreak so ordering stays deterministic if two rows transiently
   * share the same `position` (the column has no unique constraint). Per-row
   * updates are collision-free and need no two-phase temp-position dance. Runs
   * inside the caller's `$transaction`. A per-row update racing a concurrent
   * delete/move (P2025) is mapped to a 409 rather than an uncaught 500.
   */
  private async renumberItems(
    tx: Prisma.TransactionClient,
    listId: string,
  ): Promise<void> {
    const items = await tx.listItem.findMany({
      where: { listId },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    let position = 1;
    for (const item of items) {
      try {
        await tx.listItem.update({
          where: { id: item.id },
          data: { position },
        });
      } catch (err) {
        if (isRecordNotFound(err)) {
          throw new ConflictException(
            "The list changed concurrently. Please retry.",
          );
        }
        throw err;
      }
      position += 1;
    }
  }

  /**
   * Re-reads a full list detail by id after a mutation (owner already
   * authorized). `callerId` is threaded through so the returned detail's
   * `viewerHasLiked` describes the ACTUAL caller — an owner has usually not
   * liked their own list, so this must not be assumed either way.
   */
  private async getListByIdOrThrow(
    id: string,
    callerId: string,
  ): Promise<ListDetail> {
    const list = await this.prisma.client.list.findUnique({
      where: { id },
      select: LIST_DETAIL_SELECT,
    });
    if (!list) {
      throw new NotFoundException("List not found.");
    }
    return this.toDetail(
      list as unknown as ListRow,
      await this.hasLikedList(callerId, id),
    );
  }

  /**
   * Maps a persisted list row (with items) to the API detail shape. `_count` is
   * optional for the same reason `items` is: the `create` path returns a bare
   * row with neither selected, and a brand-new list has zero of both.
   */
  private toDetail(list: ListRow, viewerHasLiked: boolean): ListDetail {
    return {
      id: list.id,
      userId: list.userId,
      title: list.title,
      description: list.description,
      isRanked: list.isRanked,
      isPublic: list.isPublic,
      createdAt: list.createdAt.toISOString(),
      updatedAt: list.updatedAt.toISOString(),
      likeCount: list._count?.likes ?? 0,
      viewerHasLiked,
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

  /**
   * Validates the reorder payload is an array, without validating each
   * element's UUID shape yet. {@link reorder} checks this array's length
   * against the list's actual item count BEFORE running the (relatively
   * expensive, per-element) UUID-shape validation, so a length mismatch on an
   * arbitrarily large array short-circuits with a 400 immediately.
   */
  private validateItemIdsShape(value: unknown): unknown[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException("itemIds must be an array.");
    }
    return value;
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
  // Nested aggregate in the SAME query — no extra round-trip, no N+1, and no
  // denormalized counter column to drift out of sync.
  _count: { select: { likes: true } },
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
  /** Absent on the `create` path, which selects neither items nor counts. */
  _count?: { likes: number };
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
