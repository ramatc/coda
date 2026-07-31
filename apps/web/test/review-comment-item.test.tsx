// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ReviewCommentItem } from "../app/reviews/[id]/review-comment-item";
import {
  MAX_COMMENT_LENGTH,
  ReviewActionError,
  deleteComment,
  updateComment,
  type ReviewComment,
} from "../lib/reviews";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("../lib/reviews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/reviews")>();
  return { ...actual, updateComment: vi.fn(), deleteComment: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const COMMENT_ID = "22222222-2222-4222-8222-222222222222";

/** Builds a comment row, owned by the viewer unless overridden. */
function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: COMMENT_ID,
    body: "Agreed on the fourth listen.",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    author: { username: "ada", displayName: "Ada", avatarUrl: null },
    isOwn: true,
    ...overrides,
  };
}

beforeEach(() => {
  refreshMock.mockClear();
  vi.mocked(updateComment).mockReset().mockResolvedValue(comment());
  vi.mocked(deleteComment).mockReset().mockResolvedValue(undefined);
});

/** Renders the island for a comment the viewer owns. */
function renderOwn(overrides: Partial<ReviewComment> = {}) {
  return render(
    <ReviewCommentItem reviewId={REVIEW_ID} comment={comment(overrides)} />,
  );
}

/** Opens the inline editor. */
function openEditor() {
  fireEvent.click(screen.getByRole("button", { name: "Edit comment" }));
}

/** The inline edit textarea. */
function editor(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

/** The save button of the open editor. */
function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Save comment",
  }) as HTMLButtonElement;
}

describe("ReviewCommentItem", () => {
  it("renders no controls at all on someone else's comment", () => {
    const { container } = render(
      <ReviewCommentItem
        reviewId={REVIEW_ID}
        comment={comment({ isOwn: false })}
      />,
    );

    // `isOwn` is resolved SERVER-side against the viewer's local user id, so
    // this is the authoritative answer, not a guess — and the API re-checks it
    // anyway (403 for a non-author).
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("offers edit and delete on the viewer's own comment", () => {
    renderOwn();

    expect(screen.getByRole("button", { name: "Edit comment" })).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Delete comment" }),
    ).not.toBeNull();
    // Collapsed by default: a comment list is for reading.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("seeds the editor with the comment's current body", () => {
    renderOwn();

    openEditor();

    expect(editor().value).toBe("Agreed on the fourth listen.");
  });

  it("re-seeds from the latest props every time it opens", () => {
    const { rerender } = renderOwn();
    openEditor();
    fireEvent.change(editor(), { target: { value: "Abandoned draft." } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // A `router.refresh()` landed with a newer body while the row was closed.
    rerender(
      <ReviewCommentItem
        reviewId={REVIEW_ID}
        comment={comment({ body: "Updated elsewhere." })}
      />,
    );
    openEditor();

    // No long-lived local copy survives to go stale against the server.
    expect(editor().value).toBe("Updated elsewhere.");
  });

  it("cancelling collapses the editor without calling the API", () => {
    renderOwn();
    openEditor();

    fireEvent.change(editor(), { target: { value: "Never mind." } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(updateComment).not.toHaveBeenCalled();
  });

  it("blocks saving a blank or zero-width-only edit", () => {
    renderOwn();
    openEditor();

    fireEvent.change(editor(), { target: { value: "    " } });
    expect(saveButton().disabled).toBe(true);

    // Same emptiness rule as the create form and the API itself.
    fireEvent.change(editor(), {
      target: { value: "\u200B\u200C\u200D\uFEFF" },
    });
    expect(saveButton().disabled).toBe(true);
  });

  it("blocks saving an edit past the maximum length", () => {
    renderOwn();
    openEditor();

    fireEvent.change(editor(), {
      target: { value: "x".repeat(MAX_COMMENT_LENGTH + 1) },
    });
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(editor(), {
      target: { value: "x".repeat(MAX_COMMENT_LENGTH) },
    });
    expect(saveButton().disabled).toBe(false);
  });

  it("saves the edit scoped to its parent review, then collapses and refreshes", async () => {
    renderOwn();
    openEditor();

    fireEvent.change(editor(), { target: { value: "  Sharper on rewind.  " } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      // Both ids travel: the API loads the comment by `{ id, reviewId }` so a
      // comment belonging to another review cannot be edited through this call.
      expect(updateComment).toHaveBeenCalledWith(
        "test-token",
        REVIEW_ID,
        COMMENT_ID,
        "Sharper on rewind.",
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });

  it("keeps the editor open with the draft intact when the save is refused", async () => {
    vi.mocked(updateComment).mockRejectedValue(
      new ReviewActionError("You can only edit your own comment.", 403),
    );
    renderOwn();
    openEditor();

    fireEvent.change(editor(), { target: { value: "Sharper on rewind." } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "You can only edit your own comment.",
      ),
    );
    expect(editor().value).toBe("Sharper on rewind.");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("reconciles via refresh when a save 404s because the comment vanished", async () => {
    vi.mocked(updateComment).mockRejectedValue(
      new ReviewActionError("Comment not found.", 404),
    );
    renderOwn();
    openEditor();

    fireEvent.change(editor(), { target: { value: "Sharper on rewind." } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Comment not found."),
    );
    // The comment (or its parent review) is already gone — refreshing lets the
    // server page drop the stale row instead of leaving a dead editor open.
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("deletes after confirmation and re-reads the page", async () => {
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderOwn();

    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(deleteComment).toHaveBeenCalledWith(
        "test-token",
        REVIEW_ID,
        COMMENT_ID,
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("dismissing the confirmation is a true no-op", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderOwn();

    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));

    // No request, and the button never enters a busy state it cannot leave.
    expect(deleteComment).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("surfaces a failed delete and reconciles via refresh when the row already vanished", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(deleteComment).mockRejectedValue(
      new ReviewActionError("Comment not found.", 404),
    );
    renderOwn();

    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Comment not found."),
    );
    // A 404 means the comment (or its parent review) is already gone —
    // refreshing lets the server page drop the stale row instead of leaving a
    // dead Delete button on screen indefinitely.
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The server has already confirmed this comment is gone, so — same as a
    // successful delete — the button must stay disabled in the window before
    // `router.refresh()`'s effect lands. Re-enabling here would reopen the
    // ghost-row window: a second click landing on an already-deleted comment.
    const deleteButton = screen.getByRole("button", {
      name: "Delete comment",
    }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);

    fireEvent.click(deleteButton);
    expect(deleteComment).toHaveBeenCalledTimes(1);
  });

  it("keeps a non-reconcilable delete failure inline without refreshing", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(deleteComment).mockRejectedValue(
      new ReviewActionError("You can only delete your own comment.", 403),
    );
    renderOwn();

    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "You can only delete your own comment.",
      ),
    );
    // A 403 is not a stale-world signal — no refresh, and the failure path
    // re-enables Delete so the author can retry.
    expect(refreshMock).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("button", {
          name: "Delete comment",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("keeps Delete disabled after a successful delete instead of re-enabling it", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderOwn();

    fireEvent.click(screen.getByRole("button", { name: "Delete comment" }));

    // The API call has resolved, but `router.refresh()` is fire-and-forget —
    // the row has not actually been removed from the DOM yet at this point.
    await waitFor(() =>
      expect(deleteComment).toHaveBeenCalledWith(
        "test-token",
        REVIEW_ID,
        COMMENT_ID,
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The button must stay disabled in this window — never re-enabled on
    // success — so a second click cannot dispatch a delete against a comment
    // that no longer exists server-side.
    const deleteButton = screen.getByRole("button", {
      name: "Delete comment",
    }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);

    fireEvent.click(deleteButton);
    expect(deleteComment).toHaveBeenCalledTimes(1);
  });
});
