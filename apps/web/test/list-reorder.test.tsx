// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ListReorder, moveListItem } from "../app/lists/[id]/list-reorder";
import { reorderListItems, type ListItem } from "../lib/lists";

// Captures the `onDragEnd` handler the island hands to dnd-kit so a test can
// fire a drag WITHOUT a real pointer/layout engine (jsdom has no layout, so
// dnd-kit's real sensors can never produce a drop). Everything else in
// `@dnd-kit/core` stays REAL — only the drag transport is stubbed.
const dnd: { onDragEnd?: (event: unknown) => void } = {};

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: ReactNode;
      onDragEnd: (event: unknown) => void;
    }) => {
      dnd.onDragEnd = onDragEnd;
      return <div>{children}</div>;
    },
  };
});

// `useSortable` needs a live measuring/droppable registry that only exists
// under a real DndContext, so the row hook is stubbed to inert values. The
// real `arrayMove` and `verticalListSortingStrategy` are preserved.
vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: () => undefined,
      transform: null,
      transition: undefined,
      isDragging: false,
    }),
  };
});

// Every prop other than `href` is forwarded rather than dropped, so
// `data-testid` and friends survive into the DOM — without that, a
// `getByTestId` on a link silently fails and a `not.toContain(testid)`
// assertion passes for the wrong reason.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("../lib/lists", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/lists")>();
  return { ...actual, reorderListItems: vi.fn() };
});

const LIST_ID = "list-1";

/** Builds a list item whose album title doubles as its test identity. */
function item(id: string, position: number, title: string): ListItem {
  return {
    id,
    position,
    note: null,
    album: {
      id: `album-${id}`,
      title,
      coverUrl: null,
      primaryArtistName: "Radiohead",
    },
  };
}

const ITEMS: ListItem[] = [
  item("a", 1, "Kid A"),
  item("b", 2, "Amnesiac"),
  item("c", 3, "In Rainbows"),
];

/**
 * Fires a dnd-kit-shaped drag-end for dropping `activeId` onto `overId`. Wrapped
 * in `act` because the handler is invoked directly (not through `fireEvent`), so
 * the OPTIMISTIC state update it makes before its first `await` would otherwise
 * not be flushed to the DOM by the time the next assertion runs.
 */
function dropOn(activeId: string, overId: string | null): void {
  act(() => {
    dnd.onDragEnd?.({
      active: { id: activeId },
      over: overId ? { id: overId } : null,
    });
  });
}

/** The album titles currently rendered, in row order. */
function renderedTitles(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => within(row).getByRole("link").textContent ?? "");
}

/** The leading ordinal of each rendered row, in row order. */
function renderedOrdinals(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => (row.textContent ?? "").trim().slice(0, 2));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  dnd.onDragEnd = undefined;
  refreshMock.mockClear();
  vi.mocked(reorderListItems).mockReset().mockResolvedValue({
    id: LIST_ID,
    userId: "owner-1",
    title: "Best of 2026",
    description: null,
    isRanked: true,
    isPublic: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    items: ITEMS,
    likeCount: 0,
    viewerHasLiked: false,
  });
});

describe("moveListItem", () => {
  it("moves the dragged item into the drop target's slot, shifting the rest", () => {
    const result = moveListItem(ITEMS, "c", "a");

    expect(result.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("moves an item downwards when dropped on a later target", () => {
    const result = moveListItem(ITEMS, "a", "c");

    expect(result.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });

  it("returns the original array untouched when the item is dropped on itself", () => {
    expect(moveListItem(ITEMS, "b", "b")).toBe(ITEMS);
  });

  it("returns the original array untouched when either id is not on the list", () => {
    expect(moveListItem(ITEMS, "ghost", "a")).toBe(ITEMS);
    expect(moveListItem(ITEMS, "a", "ghost")).toBe(ITEMS);
  });

  it("does not mutate the input array", () => {
    const original = [...ITEMS];

    moveListItem(ITEMS, "c", "a");

    expect(ITEMS).toEqual(original);
  });
});

describe("ListReorder", () => {
  it("renders every item in its stored order with a 1-based ordinal", () => {
    render(<ListReorder listId={LIST_ID} items={ITEMS} />);

    expect(renderedTitles()).toEqual(["Kid A", "Amnesiac", "In Rainbows"]);
    expect(renderedOrdinals()).toEqual(["1.", "2.", "3."]);
  });

  it("links each row to its album detail page", () => {
    render(<ListReorder listId={LIST_ID} items={ITEMS} />);

    expect(
      screen.getByRole("link", { name: "Kid A" }).getAttribute("href"),
    ).toBe("/albums/album-a");
  });

  it("renders an empty state instead of a list when there are no items", () => {
    render(<ListReorder listId={LIST_ID} items={[]} />);

    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(
      screen.getByText("No albums on this list yet."),
    ).not.toBeNull();
  });

  it("exposes a keyboard-reachable drag handle per row", () => {
    render(<ListReorder listId={LIST_ID} items={ITEMS} />);

    expect(
      screen.getByRole("button", {
        name: "Reorder Amnesiac by Radiohead, position 2",
      }),
    ).not.toBeNull();
  });

  it("gives duplicate-titled rows distinct drag-handle labels", () => {
    const duplicateTitleItems: ListItem[] = [
      {
        id: "x",
        position: 1,
        note: null,
        album: {
          id: "album-x",
          title: "Greatest Hits",
          coverUrl: null,
          primaryArtistName: "Artist One",
        },
      },
      {
        id: "y",
        position: 2,
        note: null,
        album: {
          id: "album-y",
          title: "Greatest Hits",
          coverUrl: null,
          primaryArtistName: "Artist Two",
        },
      },
    ];
    render(<ListReorder listId={LIST_ID} items={duplicateTitleItems} />);

    expect(
      screen.getByRole("button", {
        name: "Reorder Greatest Hits by Artist One, position 1",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Reorder Greatest Hits by Artist Two, position 2",
      }),
    ).not.toBeNull();
  });

  it("reorders optimistically, PATCHes the full new order, then refreshes", async () => {
    render(<ListReorder listId={LIST_ID} items={ITEMS} />);

    dropOn("c", "a");

    // Optimistic: the new order (and its renumbering) is on screen before the
    // request settles.
    expect(renderedTitles()).toEqual(["In Rainbows", "Kid A", "Amnesiac"]);
    expect(renderedOrdinals()).toEqual(["1.", "2.", "3."]);

    await waitFor(() =>
      expect(reorderListItems).toHaveBeenCalledWith("test-token", LIST_ID, [
        "c",
        "a",
        "b",
      ]),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rolls back to the previous order and surfaces the API message on failure", async () => {
    vi.mocked(reorderListItems).mockRejectedValue(
      new Error("The list changed concurrently. Please retry."),
    );
    render(<ListReorder listId={LIST_ID} items={ITEMS} />);

    dropOn("c", "a");

    expect(renderedTitles()).toEqual(["In Rainbows", "Kid A", "Amnesiac"]);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "The list changed concurrently. Please retry.",
      ),
    );
    // Rolled back — no phantom order survives a rejected reorder.
    expect(renderedTitles()).toEqual(["Kid A", "Amnesiac", "In Rainbows"]);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("keeps the persisted order when router.refresh throws after a successful reorder", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const refreshFailure = new Error("refresh blew up");
    refreshMock.mockImplementationOnce(() => {
      throw refreshFailure;
    });
    render(<ListReorder listId={LIST_ID} items={ITEMS} />);

    dropOn("c", "a");

    await waitFor(() =>
      expect(reorderListItems).toHaveBeenCalledWith("test-token", LIST_ID, [
        "c",
        "a",
        "b",
      ]),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The server ALREADY renumbered the list, so rolling back here would put a
    // phantom PRE-drag order on screen that contradicts what was persisted —
    // the exact inverse of the rollback-on-failure guarantee above.
    expect(renderedTitles()).toEqual(["In Rainbows", "Kid A", "Amnesiac"]);
    expect(renderedOrdinals()).toEqual(["1.", "2.", "3."]);
    // …and no banner may claim the reorder failed.
    expect(screen.queryByRole("alert")).toBeNull();

    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("router.refresh()"),
      refreshFailure,
    );
  });

  it("does not call the API when an item is dropped on itself", async () => {
    render(<ListReorder listId={LIST_ID} items={ITEMS} />);

    dropOn("b", "b");

    await waitFor(() => expect(renderedTitles()).toEqual([
      "Kid A",
      "Amnesiac",
      "In Rainbows",
    ]));
    expect(reorderListItems).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("does not call the API when the drag is cancelled outside any target", async () => {
    render(<ListReorder listId={LIST_ID} items={ITEMS} />);

    dropOn("c", null);

    await waitFor(() => expect(renderedTitles()).toEqual([
      "Kid A",
      "Amnesiac",
      "In Rainbows",
    ]));
    expect(reorderListItems).not.toHaveBeenCalled();
  });

  it("re-syncs from fresh server props after a refresh lands", () => {
    const { rerender } = render(
      <ListReorder listId={LIST_ID} items={ITEMS} />,
    );
    expect(renderedTitles()).toEqual(["Kid A", "Amnesiac", "In Rainbows"]);

    const server: ListItem[] = [
      item("b", 1, "Amnesiac"),
      item("a", 2, "Kid A"),
      item("c", 3, "In Rainbows"),
    ];
    rerender(<ListReorder listId={LIST_ID} items={server} />);

    expect(renderedTitles()).toEqual(["Amnesiac", "Kid A", "In Rainbows"]);
  });

  it("does not stomp an in-flight optimistic reorder with stale server props", async () => {
    let settle: () => void = () => undefined;
    vi.mocked(reorderListItems).mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({} as never);
        }),
    );

    const { rerender } = render(
      <ListReorder listId={LIST_ID} items={ITEMS} />,
    );
    dropOn("c", "a");
    expect(renderedTitles()).toEqual(["In Rainbows", "Kid A", "Amnesiac"]);

    await waitFor(() => expect(reorderListItems).toHaveBeenCalled());

    // A stale re-render carrying the PRE-drag server order must not undo the
    // optimistic move while the request is still in flight.
    rerender(<ListReorder listId={LIST_ID} items={[...ITEMS]} />);
    expect(renderedTitles()).toEqual(["In Rainbows", "Kid A", "Amnesiac"]);

    settle();
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });
});
