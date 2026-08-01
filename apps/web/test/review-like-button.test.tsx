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
import { ReviewLikeButton } from "../app/reviews/[id]/review-like-button";
import { ReviewActionError, likeReview, unlikeReview } from "../lib/reviews";

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

// Only the two network functions are stubbed; `ReviewActionError` and the label
// helpers stay REAL so `instanceof` and the rendered copy are the production
// ones rather than test doubles.
vi.mock("../lib/reviews", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/reviews")>();
  return { ...actual, likeReview: vi.fn(), unlikeReview: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  refreshMock.mockClear();
  vi.mocked(likeReview)
    .mockReset()
    .mockResolvedValue({ likeCount: 4, hasLiked: true });
  vi.mocked(unlikeReview)
    .mockReset()
    .mockResolvedValue({ likeCount: 2, hasLiked: false });
});

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";

/** The island as a signed-in, synced viewer sees it. */
function renderSignedIn(
  overrides: { likeCount?: number; hasLiked?: boolean } = {},
) {
  return render(
    <ReviewLikeButton
      reviewId={REVIEW_ID}
      initialLikeCount={overrides.likeCount ?? 3}
      initialHasLiked={overrides.hasLiked ?? false}
      canInteract={true}
    />,
  );
}

/** The live count the island is currently showing. */
function likeCount(): string {
  return screen.getByTestId("like-count").textContent ?? "";
}

describe("ReviewLikeButton", () => {
  it("offers an anonymous visitor a way in instead of a dead control", () => {
    render(
      <ReviewLikeButton
        reviewId={REVIEW_ID}
        initialLikeCount={3}
        initialHasLiked={false}
        canInteract={false}
      />,
    );

    // The island owns its own anonymous branch — the view hands the slot down
    // unconditionally, so this is the ONLY thing standing between a logged-out
    // visitor and a button that would 401.
    expect(screen.getByTestId("clerk-sign-in-button")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Sign in to like" }),
    ).not.toBeNull();
    expect(screen.queryByTestId("like-count")).toBeNull();
  });

  it("likes optimistically, then settles on the server's authoritative count", async () => {
    vi.mocked(likeReview).mockResolvedValue({ likeCount: 9, hasLiked: true });
    renderSignedIn({ likeCount: 3, hasLiked: false });

    expect(likeCount()).toBe("3 likes");

    fireEvent.click(screen.getByRole("button"));

    // Optimistic: the count moves before the request settles.
    expect(likeCount()).toBe("4 likes");

    await waitFor(() =>
      expect(likeReview).toHaveBeenCalledWith("test-token", REVIEW_ID),
    );
    // The response is authoritative — other people's likes landed in the
    // meantime, so the optimistic +1 is corrected rather than trusted.
    await waitFor(() => expect(likeCount()).toBe("9 likes"));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(unlikeReview).not.toHaveBeenCalled();
  });

  it("unlikes optimistically when the viewer had already liked", async () => {
    renderSignedIn({ likeCount: 3, hasLiked: true });

    fireEvent.click(screen.getByRole("button"));

    expect(likeCount()).toBe("2 likes");

    await waitFor(() =>
      expect(unlikeReview).toHaveBeenCalledWith("test-token", REVIEW_ID),
    );
    expect(likeReview).not.toHaveBeenCalled();
  });

  it("singularizes a lone like", async () => {
    renderSignedIn({ likeCount: 0, hasLiked: false });

    fireEvent.click(screen.getByRole("button"));

    expect(likeCount()).toBe("1 like");
    expect(likeCount()).not.toBe("1 likes");
  });

  it("describes the action it would perform, not the state it is in", () => {
    renderSignedIn({ hasLiked: false });
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Like this review",
    );

    cleanup();

    renderSignedIn({ hasLiked: true });
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Unlike this review",
    );
  });

  it("rolls back and surfaces the error when the server fails outright", async () => {
    vi.mocked(likeReview).mockRejectedValue(
      new ReviewActionError("Could not like this review.", 500),
    );
    renderSignedIn({ likeCount: 3, hasLiked: false });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Could not like this review.",
      ),
    );
    // Rolled back — no phantom like survives a failed request.
    expect(likeCount()).toBe("3 likes");
    // A 5xx is a transient fault: nothing about the server state is known to
    // have changed, so there is nothing to reconcile.
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("rolls back AND reconciles when the like already existed (409)", async () => {
    vi.mocked(likeReview).mockRejectedValue(
      new ReviewActionError("You already liked this review.", 409),
    );
    renderSignedIn({ likeCount: 3, hasLiked: false });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "You already liked this review.",
      ),
    );
    expect(likeCount()).toBe("3 likes");
    // A 409 means the server already holds the like, so this island's idea of
    // the world is stale — refresh, unlike the 5xx case above.
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("rolls back AND reconciles when the review vanished under the viewer (404)", async () => {
    vi.mocked(likeReview).mockRejectedValue(
      new ReviewActionError("Review not found.", 404),
    );
    renderSignedIn({ likeCount: 3, hasLiked: false });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    // Refreshing lets the SERVER PAGE surface the not-found state, rather than
    // this island trying to render a "this is gone" story of its own.
    expect(likeCount()).toBe("3 likes");
  });

  it("re-syncs from fresh server props after a refresh lands", () => {
    const { rerender } = renderSignedIn({ likeCount: 3, hasLiked: false });
    expect(likeCount()).toBe("3 likes");

    rerender(
      <ReviewLikeButton
        reviewId={REVIEW_ID}
        initialLikeCount={7}
        initialHasLiked={true}
        canInteract={true}
      />,
    );

    expect(likeCount()).toBe("7 likes");
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Unlike this review",
    );
  });

  it("does not stomp an in-flight optimistic update with stale props", async () => {
    let resolveLike: (result: { likeCount: number; hasLiked: boolean }) => void;
    vi.mocked(likeReview).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLike = resolve;
        }),
    );

    const { rerender } = renderSignedIn({ likeCount: 3, hasLiked: false });
    fireEvent.click(screen.getByRole("button"));
    expect(likeCount()).toBe("4 likes");

    await waitFor(() => expect(likeReview).toHaveBeenCalled());

    // Props that CONTRADICT the optimistic state, arriving mid-flight. Without
    // the busy guard this would yank the count back to 3 before the request
    // settles, then jump forward again — a visible flicker on every click.
    rerender(
      <ReviewLikeButton
        reviewId={REVIEW_ID}
        initialLikeCount={3}
        initialHasLiked={false}
        canInteract={true}
      />,
    );
    expect(likeCount()).toBe("4 likes");

    resolveLike!({ likeCount: 4, hasLiked: true });
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("does not surface a refresh failure or roll back after a successful like", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(likeReview).mockResolvedValue({ likeCount: 9, hasLiked: true });
    const refreshFailure = new Error("refresh blew up");
    refreshMock.mockImplementationOnce(() => {
      throw refreshFailure;
    });
    renderSignedIn({ likeCount: 3, hasLiked: false });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(likeReview).toHaveBeenCalledWith("test-token", REVIEW_ID),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The like already succeeded and the server's authoritative count was
    // already committed — a throwing `router.refresh()` must not be
    // misreported as a failed mutation, which would otherwise unconditionally
    // roll back to the PRE-click optimistic values via `onError`.
    await waitFor(() => expect(likeCount()).toBe("9 likes"));
    expect(screen.queryByRole("alert")).toBeNull();

    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("router.refresh()"),
      refreshFailure,
    );
  });

  it("ignores a second click while the first is still in flight", async () => {
    vi.mocked(likeReview).mockImplementation(
      () => new Promise(() => {}) as Promise<never>,
    );
    renderSignedIn({ likeCount: 3, hasLiked: false });

    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    // Without SOME guard the three clicks would send like/unlike/like and the
    // final server state would depend on which response landed last.
    //
    // What actually stops clicks 2 and 3 HERE is the `disabled` attribute:
    // React flushes a discrete event's state updates synchronously, so the
    // button is already disabled by the time the next `fireEvent.click` is
    // dispatched, and React does not dispatch clicks on disabled controls. The
    // island's synchronous ref guard is therefore NOT what this test observes —
    // it is unreachable from jsdom, and is pinned directly on the hook that owns
    // it in `use-async-action.test.tsx`.
    await waitFor(() => expect(likeReview).toHaveBeenCalledTimes(1));
    expect(unlikeReview).not.toHaveBeenCalled();
  });
});
