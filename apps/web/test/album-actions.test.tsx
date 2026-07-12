// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AlbumActions } from "../app/albums/[id]/album-actions";
import type { AlbumViewerState } from "../lib/albums";
import {
  deleteListen,
  deleteRating,
  markListened,
  rateAlbum,
  writeReview,
} from "../lib/albums";

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
});

const ALBUM_ID = "album-1";

function renderActions(viewer: AlbumViewerState) {
  return render(<AlbumActions albumId={ALBUM_ID} viewer={viewer} />);
}

const UNTRACKED: AlbumViewerState = {
  listened: false,
  listenId: null,
  score: null,
  review: null,
};

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
        viewer={{
          listened: false,
          listenId: null,
          score: 8,
          review: "Updated review.",
        }}
      />,
    );

    expect(review.disabled).toBe(false);
    expect(review.value).toBe("Updated review.");
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
        viewer={{ listened: false, listenId: null, score: null, review: null }}
      />,
    );

    expect(
      (screen.getByLabelText("Your review") as HTMLTextAreaElement).value,
    ).toBe("");
  });
});
