// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ReviewCommentForm } from "../app/reviews/[id]/review-comment-form";
import {
  MAX_COMMENT_LENGTH,
  ReviewActionError,
  createComment,
} from "../lib/reviews";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
  SignInButton: ({ children }: { children: ReactNode }) => (
    <span data-testid="clerk-sign-in-button">{children}</span>
  ),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("../lib/reviews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/reviews")>();
  return { ...actual, createComment: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  refreshMock.mockClear();
  vi.mocked(createComment)
    .mockReset()
    .mockResolvedValue({
      id: "comment-1",
      body: "Nicely put.",
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
      author: { username: "ada", displayName: "Ada", avatarUrl: null },
      isOwn: true,
    });
});

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";

/** The form as a signed-in, synced viewer sees it. */
function renderSignedIn() {
  return render(<ReviewCommentForm reviewId={REVIEW_ID} canInteract={true} />);
}

/** The comment textarea. */
function textarea(): HTMLTextAreaElement {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

/** The submit button. */
function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Post comment",
  }) as HTMLButtonElement;
}

/** Types `value` into the textarea. */
function type(value: string) {
  fireEvent.change(textarea(), { target: { value } });
}

describe("ReviewCommentForm", () => {
  it("offers an anonymous visitor a way in instead of a dead form", () => {
    render(<ReviewCommentForm reviewId={REVIEW_ID} canInteract={false} />);

    expect(
      screen.getByRole("button", { name: "Sign in to comment" }),
    ).not.toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("starts with an empty draft and a disabled submit", () => {
    renderSignedIn();

    expect(textarea().value).toBe("");
    // The API answers 400 for an empty body; keeping submit disabled makes that
    // failure unreachable rather than merely handled.
    expect(submitButton().disabled).toBe(true);
  });

  it("enables submit once there is real content", () => {
    renderSignedIn();

    type("Nicely put.");

    expect(submitButton().disabled).toBe(false);
  });

  it("keeps submit disabled for a whitespace-only draft", () => {
    renderSignedIn();

    type("      ");

    expect(submitButton().disabled).toBe(true);
  });

  it("keeps submit disabled for a draft of only zero-width characters", () => {
    renderSignedIn();

    // Reachable by an ordinary clipboard paste, not just by abuse. A bare
    // `.trim()` check would call this non-empty and post a blank-looking
    // comment, which the API then rejects with a 400.
    type("\u200B\u200C\u200D\uFEFF");

    expect(submitButton().disabled).toBe(true);
  });

  it("counts down the remaining characters as the viewer types", () => {
    renderSignedIn();

    expect(screen.getByTestId("comment-remaining").textContent).toContain(
      String(MAX_COMMENT_LENGTH),
    );

    type("hello");

    expect(screen.getByTestId("comment-remaining").textContent).toContain(
      String(MAX_COMMENT_LENGTH - 5),
    );
  });

  it("accepts a draft of exactly the maximum length", () => {
    renderSignedIn();

    type("x".repeat(MAX_COMMENT_LENGTH));

    // The boundary itself is VALID — the API rejects only what exceeds it.
    expect(submitButton().disabled).toBe(false);
    expect(screen.getByTestId("comment-remaining").textContent).toContain("0");
  });

  it("blocks a draft one character past the maximum", () => {
    renderSignedIn();

    type("x".repeat(MAX_COMMENT_LENGTH + 1));

    expect(submitButton().disabled).toBe(true);
    expect(screen.getByTestId("comment-remaining").textContent).toContain("-1");
  });

  it("posts the comment, clears the draft and re-reads the page", async () => {
    renderSignedIn();

    type("  Nicely put.  ");
    fireEvent.click(submitButton());

    await waitFor(() =>
      // Trimmed exactly as the API would store it, so the optimistic UI and the
      // persisted row never disagree about leading/trailing space.
      expect(createComment).toHaveBeenCalledWith(
        "test-token",
        REVIEW_ID,
        "Nicely put.",
      ),
    );
    // The new comment arrives via the SERVER page, not by local insertion —
    // the list stays server-authoritative and correctly ordered.
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(textarea().value).toBe(""));
  });

  it("surfaces the API's validation message and KEEPS the draft", async () => {
    vi.mocked(createComment).mockRejectedValue(
      new ReviewActionError("body must be at most 500 characters.", 400),
    );
    renderSignedIn();

    type("Nicely put.");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "body must be at most 500 characters.",
      ),
    );
    // A validation 400 is the user's to fix — discarding their text would make
    // the error unrecoverable without retyping.
    expect(textarea().value).toBe("Nicely put.");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("surfaces a 404 when the review vanished before the comment landed, then refreshes", async () => {
    vi.mocked(createComment).mockRejectedValue(
      new ReviewActionError("Review not found.", 404),
    );
    renderSignedIn();

    type("Nicely put.");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Review not found."),
    );
    // The parent review is already gone — refreshing lets the server page
    // surface the not-found state instead of leaving a live comment form on a
    // dead review.
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("does not surface a refresh failure after a successful post", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const refreshFailure = new Error("refresh blew up");
    refreshMock.mockImplementationOnce(() => {
      throw refreshFailure;
    });
    renderSignedIn();

    type("Nicely put.");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(createComment).toHaveBeenCalledWith(
        "test-token",
        REVIEW_ID,
        "Nicely put.",
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The post already succeeded and the draft was already cleared — a
    // throwing `router.refresh()` must not be misreported as a failed
    // mutation via a false error banner, which would also block an obvious
    // retry on an already-emptied draft.
    await waitFor(() => expect(textarea().value).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();

    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("router.refresh()"),
      refreshFailure,
    );
  });

  it("ignores a second submit while the first is still in flight", async () => {
    vi.mocked(createComment).mockImplementation(
      () => new Promise(() => {}) as Promise<never>,
    );
    renderSignedIn();

    type("Nicely put.");
    const button = submitButton();
    fireEvent.click(button);
    fireEvent.click(button);

    // Two clicks must not post the same comment twice — there is no
    // idempotency key on comment creation.
    //
    // What actually stops the second click HERE is the `disabled` attribute:
    // React flushes a discrete event's state updates synchronously, so submit is
    // already disabled by the time the second `fireEvent.click` is dispatched,
    // and React does not dispatch clicks on disabled controls. The island's
    // synchronous ref guard is therefore NOT what this test observes — it is
    // unreachable from jsdom, and is pinned directly on the hook that owns it in
    // `use-async-action.test.tsx`.
    await waitFor(() => expect(createComment).toHaveBeenCalledTimes(1));
  });
});
