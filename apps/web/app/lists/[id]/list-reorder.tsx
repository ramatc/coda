"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { reorderListItems, type ListItem } from "../../../lib/lists";

interface ListReorderProps {
  /** The list being reordered (path param for the API call). */
  listId: string;
  /** The owner's items in their server-stored order. */
  items: ListItem[];
}

/**
 * Returns `items` with `activeId` moved into `overId`'s slot, shifting the rest.
 * Pure and total: when the two ids are the same, or either is not on the list,
 * it returns the ORIGINAL array reference so the caller can cheaply detect a
 * no-op drag and skip the request entirely.
 */
export function moveListItem<T extends { id: string }>(
  items: T[],
  activeId: string,
  overId: string,
): T[] {
  const from = items.findIndex((item) => item.id === activeId);
  const to = items.findIndex((item) => item.id === overId);
  if (from === -1 || to === -1 || from === to) {
    return items;
  }
  return arrayMove(items, from, to);
}

/**
 * Drag-and-drop reorder island (client), rendered ONLY for the list owner — the
 * server page composes it in place of the read-only item list, and every reorder
 * is re-authorized server-side regardless.
 *
 * The order flips OPTIMISTICALLY on drop for instant feedback, then the request
 * settles: on success it `router.refresh()`es so the server page re-reads the
 * now-renumbered list; on failure it ROLLS BACK to the pre-drag order and
 * surfaces the API's message, so a rejected reorder never leaves a phantom
 * order on screen. The API owns renumbering — the island always sends the FULL
 * desired order (`itemIds`), which the service validates as a permutation of the
 * list's current items before assigning `position = index + 1`.
 *
 * Like `follow-button.tsx`, the order lives in local state so it can flip
 * optimistically, so a `useEffect` re-syncs it from fresh server props — except
 * while a reorder is in flight, so it never stomps a pending optimistic move.
 * The rendered ordinal is the LOCAL index, not the server `position`, so the
 * numbering renumbers in step with the optimistic move.
 */
export function ListReorder({ listId, items }: ListReorderProps) {
  const { getToken } = useAuth();
  const router = useRouter();
  const [order, setOrder] = useState<ListItem[]>(items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Re-sync from fresh server props after this island's own `router.refresh()`
  // lands. Skipped while `busy` so it doesn't stomp an in-flight optimistic
  // move. Deliberately keyed only on `items` — reacting to `busy` too would
  // re-run the moment a reorder finishes, racing the rollback in `onDragEnd`.
  useEffect(() => {
    if (!busy) {
      setOrder(items);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    // Dropped outside any target — dnd-kit reports a null `over`.
    if (!over) {
      return;
    }

    const previous = order;
    const next = moveListItem(previous, String(active.id), String(over.id));
    // Same reference means the drag was a no-op (self-drop or an id that is no
    // longer on the list) — nothing to persist.
    if (next === previous) {
      return;
    }

    setOrder(next);
    setBusy(true);
    setError(null);

    try {
      const token = await getToken();
      await reorderListItems(
        token,
        listId,
        next.map((entry) => entry.id),
      );
      // The server re-reads the renumbered list so positions stay authoritative.
      router.refresh();
    } catch (err) {
      setOrder(previous);
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (order.length === 0) {
    return (
      <p className="text-sm italic opacity-50">No albums on this list yet.</p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => void onDragEnd(event)}
      >
        <SortableContext
          items={order.map((entry) => entry.id)}
          strategy={verticalListSortingStrategy}
        >
          <ol className="flex flex-col divide-y divide-brand-100">
            {order.map((entry, index) => (
              <SortableRow
                key={entry.id}
                item={entry}
                position={index + 1}
                disabled={busy}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface SortableRowProps {
  item: ListItem;
  /** The 1-based ordinal of this row in the CURRENT (possibly optimistic) order. */
  position: number;
  disabled: boolean;
}

/**
 * One draggable row. The handle carries dnd-kit's listeners rather than the
 * whole row, so the album link stays clickable and the drag stays keyboard
 * reachable through a real `<button>` (dnd-kit's `KeyboardSensor` activates on
 * the focused handle).
 */
function SortableRow({ item, position, disabled }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  return (
    <li
      ref={setNodeRef}
      style={{
        // Built by hand rather than with `CSS.Transform.toString` so the island
        // needs no `@dnd-kit/utilities` dependency (it is not a declared peer of
        // `@dnd-kit/sortable` and does not resolve under pnpm's strict layout).
        transform: transform
          ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
          : undefined,
        transition,
        opacity: isDragging ? 0.6 : undefined,
      }}
      className="flex items-center gap-3 bg-white py-2 text-sm"
    >
      <span className="w-8 shrink-0 text-right tabular-nums opacity-50">
        {position}.
      </span>
      <span className="flex flex-1 flex-col">
        <Link href={`/albums/${item.album.id}`} className="font-medium">
          {item.album.title}
        </Link>
        <span className="opacity-70">{item.album.primaryArtistName}</span>
        {item.note ? (
          <span className="text-xs italic opacity-60">{item.note}</span>
        ) : null}
      </span>
      <button
        type="button"
        aria-label={`Reorder ${item.album.title}`}
        disabled={disabled}
        className="cursor-grab rounded-card border border-brand-200 px-2 py-1 opacity-70"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
    </li>
  );
}
