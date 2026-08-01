// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { AlbumActions } from "../app/albums/[id]/album-actions";
import type { AlbumViewerState } from "../lib/albums";
import { addListItem, type ListDetail, type ListSummary } from "../lib/lists";
import {
  deleteListen,
  deleteRating,
  markListened,
  rateAlbum,
  writeReview,
} from "../lib/albums";
import { markWantToListen, unmarkWantToListen } from "../lib/want-to-listen";

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

vi.mock("../lib/albums", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/albums")>();
  return {
    ...actual,
    markListened: vi.fn(),
    deleteListen: vi.fn(),
    rateAlbum: vi.fn(),
    deleteRating: vi.fn(),
    writeReview: vi.fn(),
  };
});

vi.mock("../lib/lists", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/lists")>();
  return { ...actual, addListItem: vi.fn() };
});

vi.mock("../lib/want-to-listen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/want-to-listen")>();
  return {
    ...actual,
    markWantToListen: vi.fn(),
    unmarkWantToListen: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  refreshMock.mockClear();
  vi.mocked(markListened).mockReset().mockResolvedValue(undefined);
  vi.mocked(deleteListen).mockReset().mockResolvedValue(undefined);
  vi.mocked(rateAlbum).mockReset().mockResolvedValue(undefined);
  vi.mocked(deleteRating).mockReset().mockResolvedValue(undefined);
  vi.mocked(writeReview).mockReset().mockResolvedValue(undefined);
  vi.mocked(markWantToListen).mockReset().mockResolvedValue({
    id: "wtl-1",
    albumId: ALBUM_ID,
    createdAt: "2026-07-01T00:00:00.000Z",
  });
  vi.mocked(unmarkWantToListen).mockReset().mockResolvedValue(undefined);
  vi.mocked(addListItem).mockReset().mockResolvedValue(ADDED_LIST);
});

const ALBUM_ID = "album-1";

/** Builds a compact list row; the title doubles as its test identity. */
function summary(id: string, title: string, isPublic = true): ListSummary {
  return {
    id,
    title,
    description: null,
    isRanked: false,
    isPublic,
    itemCount: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

/** The viewer's own lists, as the album page server-fetches them. */
const OWN_LISTS: ListSummary[] = [
  summary("list-1", "Best of 2026"),
  summary("list-2", "Private drafts", false),
];

/** The refreshed list `addListItem` resolves with (the island ignores it). */
const ADDED_LIST: ListDetail = {
  id: "list-2",
  userId: "user-1",
  title: "Private drafts",
  description: null,
  isRanked: false,
  isPublic: false,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  items: [],
  likeCount: 0,
  viewerHasLiked: false,
};

const UNTRACKED: AlbumViewerState = {
  listened: false,
  listenId: null,
  score: null,
  review: null,
  resolved: false,
  wantToListenId: null,
};

/**
 * Builds a viewer state from {@link UNTRACKED} with the given overrides applied,
 * mirroring the `list(overrides)` helper in `list-detail.test.tsx`, so each test
 * states only the fields it cares about.
 */
function viewerState(overrides: Partial<AlbumViewerState> = {}): AlbumViewerState {
  return { ...UNTRACKED, ...overrides };
}

function renderActions(
  overrides: Partial<AlbumViewerState>,
  ownLists: ListSummary[] = OWN_LISTS,
) {
  return render(
    <AlbumActions
      albumId={ALBUM_ID}
      viewer={viewerState(overrides)}
      ownLists={ownLists}
    />,
  );
}

describe("AlbumActions", () => {
  it("reflects the viewer's existing rating and review when they have tracked the album", () => {
    renderActions({
      listened: true,
      listenId: "listen-1",
      score: 8,
      review: "A landmark record.",
    });

    // Existing listen state → the remove control, not "Mark as listened".
    expect(screen.getByText(/Listened/)).toBeTruthy();
    expect(screen.queryByText("Mark as listened")).toBeNull();

    // Existing rating is the selected value.
    const rating = screen.getByLabelText("Your rating") as HTMLSelectElement;
    expect(rating.value).toBe("8");

    // Existing review pre-fills the textarea and the button reads "Update".
    const review = screen.getByLabelText("Your review") as HTMLTextAreaElement;
    expect(review.value).toBe("A landmark record.");
    expect(review.disabled).toBe(false);
    expect(screen.getByText("Update review")).toBeTruthy();
  });

  it("offers a listen control and gates the review when the viewer has not tracked the album", () => {
    renderActions({
      listened: false,
      listenId: null,
      score: null,
      review: null,
    });

    expect(screen.getByText("Mark as listened")).toBeTruthy();

    const rating = screen.getByLabelText("Your rating") as HTMLSelectElement;
    expect(rating.value).toBe("");

    // The review textarea is disabled until the album is rated (the API
    // subordinates a review to a rating).
    const review = screen.getByLabelText("Your review") as HTMLTextAreaElement;
    expect(review.disabled).toBe(true);
    expect(screen.getByText("Save review")).toBeTruthy();
  });

  it("calls markListened with the viewer's token and album id, then refreshes", async () => {
    renderActions(UNTRACKED);

    fireEvent.click(screen.getByText("Mark as listened"));

    await waitFor(() =>
      expect(markListened).toHaveBeenCalledWith("test-token", ALBUM_ID),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("calls deleteListen with the viewer's listenId when removing a listen", async () => {
    renderActions({
      listened: true,
      listenId: "listen-1",
      score: null,
      review: null,
    });

    fireEvent.click(screen.getByText(/Listened/));

    await waitFor(() =>
      expect(deleteListen).toHaveBeenCalledWith("test-token", "listen-1"),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("calls rateAlbum with the selected numeric score", async () => {
    renderActions(UNTRACKED);

    fireEvent.change(screen.getByLabelText("Your rating"), {
      target: { value: "8" },
    });

    await waitFor(() =>
      expect(rateAlbum).toHaveBeenCalledWith("test-token", ALBUM_ID, 8),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("calls deleteRating when the rating is cleared", async () => {
    renderActions({ listened: false, listenId: null, score: 8, review: null });

    fireEvent.change(screen.getByLabelText("Your rating"), {
      target: { value: "" },
    });

    await waitFor(() =>
      expect(deleteRating).toHaveBeenCalledWith("test-token", ALBUM_ID),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("calls writeReview with the trimmed draft text and refreshes on success", async () => {
    renderActions({ listened: false, listenId: null, score: 8, review: null });

    fireEvent.change(screen.getByLabelText("Your review"), {
      target: { value: "  Great album.  " },
    });
    fireEvent.click(screen.getByText("Save review"));

    await waitFor(() =>
      expect(writeReview).toHaveBeenCalledWith(
        "test-token",
        ALBUM_ID,
        "Great album.",
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("renders the error banner when a mutation rejects, and does not refresh", async () => {
    vi.mocked(markListened).mockRejectedValue(
      new Error("Your account is still syncing — try again in a moment."),
    );
    renderActions(UNTRACKED);

    fireEvent.click(screen.getByText("Mark as listened"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Your account is still syncing — try again in a moment.",
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("keeps the review textarea disabled until the refreshed viewer props land, even if the user resumes editing first (judgment-day PR9 round 3, finding #2 regression)", async () => {
    const { rerender } = renderActions({
      listened: false,
      listenId: null,
      score: 8,
      review: "Original review.",
    });

    const review = screen.getByLabelText("Your review") as HTMLTextAreaElement;
    fireEvent.change(review, { target: { value: "Updated review." } });
    fireEvent.click(screen.getByText("Update review"));

    // The mutation resolves and `router.refresh()` fires, but its refetch is
    // fire-and-forget — the refreshed props have not landed yet.
    await waitFor(() =>
      expect(writeReview).toHaveBeenCalledWith(
        "test-token",
        ALBUM_ID,
        "Updated review.",
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The textarea must still be disabled in this gap — re-enabling it here
    // would let the user resume typing only to have it clobbered once the
    // (now-stale) server value arrives. `busy` alone (tied to `status`) is
    // already back to "idle" at this point, so this only holds if the
    // `pendingRefresh` gate is doing its job.
    expect(review.disabled).toBe(true);

    // Now the refresh actually lands: the parent re-renders with a fresh
    // `viewer` object reflecting the saved review.
    rerender(
      <AlbumActions
        albumId={ALBUM_ID}
        viewer={viewerState({ score: 8, review: "Updated review." })}
        ownLists={OWN_LISTS}
      />,
    );

    expect(review.disabled).toBe(false);
    expect(review.value).toBe("Updated review.");
  });

  it("does not surface a refresh failure after a successful review save, and releases the draft gate", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const refreshFailure = new Error("refresh blew up");
    refreshMock.mockImplementationOnce(() => {
      throw refreshFailure;
    });
    renderActions({ score: 8, review: "Original review." });

    const review = screen.getByLabelText("Your review") as HTMLTextAreaElement;
    fireEvent.change(review, { target: { value: "Updated review." } });
    fireEvent.click(screen.getByText("Update review"));

    await waitFor(() =>
      expect(writeReview).toHaveBeenCalledWith(
        "test-token",
        ALBUM_ID,
        "Updated review.",
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The review itself already saved — a throwing `router.refresh()` must not
    // be misreported as a failed mutation via a false error banner.
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    // The `pendingRefresh` gate was armed FOR the refresh that just failed, so
    // no refreshed `viewer` prop will ever land to clear it. Leaving it armed
    // would brick the textarea for the rest of the page's life — and now
    // silently, since the error banner is (correctly) gone.
    await waitFor(() => expect(review.disabled).toBe(false));

    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("router.refresh()"),
      refreshFailure,
    );
  });

  it("does not release the review draft gate when an unrelated action's refresh fails (cross-action race regression)", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    renderActions({
      listened: false,
      listenId: null,
      score: 8,
      review: "Original review.",
    });

    // Save a review. Its own `router.refresh()` succeeds, so `pendingRefresh`
    // stays armed while the (fire-and-forget) refetch is still in flight.
    const review = screen.getByLabelText("Your review") as HTMLTextAreaElement;
    fireEvent.change(review, { target: { value: "Updated review." } });
    fireEvent.click(screen.getByText("Update review"));

    await waitFor(() =>
      expect(writeReview).toHaveBeenCalledWith(
        "test-token",
        ALBUM_ID,
        "Updated review.",
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(review.disabled).toBe(true);

    // Before that refetch lands, the user clicks a DIFFERENT, still-enabled
    // control. Its own `router.refresh()` throws.
    const refreshFailure = new Error("refresh blew up");
    refreshMock.mockImplementationOnce(() => {
      throw refreshFailure;
    });
    fireEvent.click(screen.getByText("Mark as listened"));

    await waitFor(() =>
      expect(markListened).toHaveBeenCalledWith("test-token", ALBUM_ID),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(2));

    // The unrelated action's failure must NOT release the gate that is still
    // legitimately protecting the first (still in-flight) review refresh —
    // otherwise the user could resume typing and have it silently clobbered
    // once that refresh eventually lands.
    expect(review.disabled).toBe(true);

    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("router.refresh()"),
      refreshFailure,
    );
  });

  it("re-syncs the review draft when a cascade-delete clears the viewer's review (Finding 1 regression)", () => {
    const { rerender } = renderActions({
      listened: false,
      listenId: null,
      score: 8,
      review: "A landmark record.",
    });

    expect(
      (screen.getByLabelText("Your review") as HTMLTextAreaElement).value,
    ).toBe("A landmark record.");

    // Simulate: the viewer deleted their rating, the server cascade-deleted
    // the review too (Decision #12), and `router.refresh()` brought in fresh
    // server props — `viewer.review` is now null.
    rerender(
      <AlbumActions
        albumId={ALBUM_ID}
        viewer={viewerState()}
        ownLists={OWN_LISTS}
      />,
    );

    expect(
      (screen.getByLabelText("Your review") as HTMLTextAreaElement).value,
    ).toBe("");
  });
});

describe("AlbumActions — want to listen", () => {
  it("offers the add state when the album is neither resolved nor already marked", async () => {
    renderActions({ resolved: false, wantToListenId: null });

    fireEvent.click(screen.getByText("+ Want to listen"));

    await waitFor(() =>
      expect(markWantToListen).toHaveBeenCalledWith("test-token", ALBUM_ID),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("offers the remove state — addressed BY ALBUM — when a row already exists", async () => {
    renderActions({ resolved: false, wantToListenId: "wtl-1" });

    expect(screen.queryByText("+ Want to listen")).toBeNull();
    fireEvent.click(screen.getByText(/Want to listen ✓/));

    // The entry's own id ("wtl-1") is deliberately NOT part of the call: the
    // API scopes `DELETE /want-to-listen/:albumId` to the caller's own row.
    await waitFor(() =>
      expect(unmarkWantToListen).toHaveBeenCalledWith("test-token", ALBUM_ID),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("hides the control entirely once the album is resolved, even while the row survives", () => {
    // `resolved` covers listened OR rated; the row is never deleted on resolve,
    // so this combination is reachable and hide must win over remove.
    renderActions({ resolved: true, wantToListenId: "wtl-1" });

    expect(screen.queryByText(/Want to listen/)).toBeNull();
    // The other controls are untouched by the hide branch.
    expect(screen.getByText("Mark as listened")).toBeTruthy();
  });

  it("hides the control when the album is resolved and was never marked", () => {
    renderActions({ resolved: true, wantToListenId: null });

    expect(screen.queryByText(/Want to listen/)).toBeNull();
  });

  it("surfaces the API's message when marking fails, and does not refresh", async () => {
    vi.mocked(markWantToListen).mockRejectedValue(
      new Error("This album is already on your want-to-listen list."),
    );
    renderActions({ resolved: false, wantToListenId: null });

    fireEvent.click(screen.getByText("+ Want to listen"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "This album is already on your want-to-listen list.",
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe("AlbumActions — add to list", () => {
  it("offers one option per own list, private ones included", () => {
    renderActions({});

    const picker = screen.getByLabelText("Add to list") as HTMLSelectElement;
    const options = within(picker).getAllByRole("option");

    expect(options.map((option) => option.textContent)).toEqual([
      "Add to list…",
      "Best of 2026",
      "Private drafts",
    ]);
  });

  it("adds the album to the picked list and confirms which one", async () => {
    renderActions({});

    fireEvent.change(screen.getByLabelText("Add to list"), {
      target: { value: "list-2" },
    });

    await waitFor(() =>
      expect(addListItem).toHaveBeenCalledWith("test-token", "list-2", ALBUM_ID),
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Added to Private drafts.",
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("resets the picker to its placeholder so a second list can be picked", async () => {
    renderActions({});

    const picker = screen.getByLabelText("Add to list") as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: "list-1" } });

    await waitFor(() =>
      expect(addListItem).toHaveBeenCalledWith("test-token", "list-1", ALBUM_ID),
    );
    expect(picker.value).toBe("");

    fireEvent.change(picker, { target: { value: "list-2" } });

    await waitFor(() =>
      expect(addListItem).toHaveBeenCalledWith("test-token", "list-2", ALBUM_ID),
    );
    expect(addListItem).toHaveBeenCalledTimes(2);
  });

  it("surfaces the API's duplicate-add message instead of a confirmation", async () => {
    vi.mocked(addListItem).mockRejectedValue(
      new Error("This album is already on the list."),
    );
    renderActions({});

    fireEvent.change(screen.getByLabelText("Add to list"), {
      target: { value: "list-1" },
    });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "This album is already on the list.",
      ),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("still confirms the add when router.refresh throws afterwards", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const refreshFailure = new Error("refresh blew up");
    refreshMock.mockImplementationOnce(() => {
      throw refreshFailure;
    });
    renderActions({});

    fireEvent.change(screen.getByLabelText("Add to list"), {
      target: { value: "list-2" },
    });

    await waitFor(() =>
      expect(addListItem).toHaveBeenCalledWith(
        "test-token",
        "list-2",
        ALBUM_ID,
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The album IS on the list — `addListItem` resolved. A throwing
    // `router.refresh()` afterwards must neither raise a false error banner…
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Added to Private drafts.",
      ),
    );
    // …nor swallow the confirmation by making `run` report the add as failed:
    // this action's success has NO other visible trace on the page.
    expect(screen.queryByRole("alert")).toBeNull();

    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("router.refresh()"),
      refreshFailure,
    );
  });

  it("points a viewer with no lists at the create page instead of hiding the control", () => {
    renderActions({}, []);

    expect(screen.queryByLabelText("Add to list")).toBeNull();

    const link = screen.getByText("create one") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/lists/new");
    expect(screen.getByText(/You have no lists yet/)).toBeTruthy();
  });

  it("clears a stale confirmation when the next action starts", async () => {
    renderActions({});

    fireEvent.change(screen.getByLabelText("Add to list"), {
      target: { value: "list-1" },
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Added to Best of 2026.",
      ),
    );

    fireEvent.click(screen.getByText("Mark as listened"));

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
