// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ListLikeButton } from "../app/lists/[id]/list-like-button";
import { ListActionError, likeList, unlikeList } from "../lib/lists";

// Only `useAuth` is stubbed. Unlike `review-like-button.test.tsx`, no
// `SignInButton` double is needed: `/lists(.*)` is in `protectedRoutePatterns`,
// so this island never renders an anonymous branch — importing one would be dead
// code, and the missing double here is what would fail loudly if it appeared.
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

// Only the two network functions are stubbed; `ListActionError` stays REAL so
// the `instanceof` check the island reconciles on is the production one rather
// than a test double.
vi.mock("../lib/lists", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/lists")>();
  return { ...actual, likeList: vi.fn(), unlikeList: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  refreshMock.mockClear();
  vi.mocked(likeList)
    .mockReset()
    .mockResolvedValue({ likeCount: 4, hasLiked: true });
  vi.mocked(unlikeList)
    .mockReset()
    .mockResolvedValue({ likeCount: 2, hasLiked: false });
});

const LIST_ID = "22222222-2222-4222-8222-222222222222";

/** The island as the list page hands it down — for owner and visitor alike. */
function renderButton(
  overrides: { likeCount?: number; hasLiked?: boolean } = {},
) {
  return render(
    <ListLikeButton
      listId={LIST_ID}
      initialLikeCount={overrides.likeCount ?? 3}
      initialHasLiked={overrides.hasLiked ?? false}
    />,
  );
}

/** The live count the island is currently showing. */
function likeCount(): string {
  return screen.getByTestId("list-like-count").textContent ?? "";
}

describe("ListLikeButton", () => {
  it("gives every viewer a live control, the list's own owner included", async () => {
    // Self-like is allowed server-side (`loadListForViewer` gates on READ
    // visibility, never on ownership), so this island deliberately takes NO
    // ownership prop and NO `canInteract` prop: the page hands it down
    // unconditionally, and `/lists(.*)` being a protected route means the viewer
    // is always authenticated by the time it renders.
    renderButton({ likeCount: 3, hasLiked: false });

    const button = screen.getByRole("button");
    expect(button.hasAttribute("disabled")).toBe(false);

    fireEvent.click(button);

    await waitFor(() =>
      expect(likeList).toHaveBeenCalledWith("test-token", LIST_ID),
    );
  });

  it("likes optimistically, then settles on the server's authoritative count", async () => {
    vi.mocked(likeList).mockResolvedValue({ likeCount: 9, hasLiked: true });
    renderButton({ likeCount: 3, hasLiked: false });

    expect(likeCount()).toBe("3 likes");

    fireEvent.click(screen.getByRole("button"));

    // Optimistic: the count moves before the request settles.
    expect(likeCount()).toBe("4 likes");

    await waitFor(() =>
      expect(likeList).toHaveBeenCalledWith("test-token", LIST_ID),
    );
    // The response is authoritative — other people's likes may have landed in
    // the meantime, so the optimistic +1 is corrected rather than trusted.
    await waitFor(() => expect(likeCount()).toBe("9 likes"));
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(unlikeList).not.toHaveBeenCalled();
  });

  it("unlikes optimistically when the viewer had already liked", async () => {
    renderButton({ likeCount: 3, hasLiked: true });

    fireEvent.click(screen.getByRole("button"));

    expect(likeCount()).toBe("2 likes");

    await waitFor(() =>
      expect(unlikeList).toHaveBeenCalledWith("test-token", LIST_ID),
    );
    expect(likeList).not.toHaveBeenCalled();
  });

  it("singularizes a lone like", async () => {
    renderButton({ likeCount: 0, hasLiked: false });

    fireEvent.click(screen.getByRole("button"));

    expect(likeCount()).toBe("1 like");
    expect(likeCount()).not.toBe("1 likes");
  });

  it("describes the action it would perform, not the state it is in", () => {
    renderButton({ hasLiked: false });
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Like this list",
    );

    cleanup();

    renderButton({ hasLiked: true });
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Unlike this list",
    );
  });

  it("rolls back and surfaces the error when the server fails outright", async () => {
    vi.mocked(likeList).mockRejectedValue(
      new ListActionError("Could not like this list.", 500),
    );
    renderButton({ likeCount: 3, hasLiked: false });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Could not like this list.",
      ),
    );
    // Rolled back — no phantom like survives a failed request.
    expect(likeCount()).toBe("3 likes");
    // A 5xx is a transient fault: nothing about the server state is known to
    // have changed, so there is nothing to reconcile.
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("rolls back AND reconciles when the like already existed (409)", async () => {
    vi.mocked(likeList).mockRejectedValue(
      new ListActionError("You already liked this list.", 409),
    );
    renderButton({ likeCount: 3, hasLiked: false });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "You already liked this list.",
      ),
    );
    expect(likeCount()).toBe("3 likes");
    // A 409 means the server already holds the like, so this island's idea of
    // the world is stale — refresh, unlike the 5xx case above.
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("rolls back AND reconciles when the list vanished under the viewer (404)", async () => {
    vi.mocked(likeList).mockRejectedValue(
      new ListActionError("List not found.", 404),
    );
    renderButton({ likeCount: 3, hasLiked: false });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    // The API's access check and its write are separate, non-transactional round
    // trips, so a list deleted (or made private) in that window answers 404 even
    // though the page rendered fine. Refreshing lets the SERVER PAGE tell that
    // story instead of this island inventing one.
    expect(likeCount()).toBe("3 likes");
  });

  it("clears the stale error banner once the re-sync from a refresh lands", async () => {
    vi.mocked(likeList).mockRejectedValue(
      new ListActionError("You already liked this list.", 409),
    );
    const { rerender } = renderButton({ likeCount: 3, hasLiked: false });

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "You already liked this list.",
      ),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The props `router.refresh()` would have produced: the like already
    // existed server-side, so the server's truth is `hasLiked: true`.
    rerender(
      <ListLikeButton
        listId={LIST_ID}
        initialLikeCount={4}
        initialHasLiked={true}
      />,
    );

    // The stale error banner must clear along with the state it described,
    // not linger until the viewer clicks the button again.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("re-syncs from fresh server props after a refresh lands", () => {
    const { rerender } = renderButton({ likeCount: 3, hasLiked: false });
    expect(likeCount()).toBe("3 likes");

    rerender(
      <ListLikeButton
        listId={LIST_ID}
        initialLikeCount={7}
        initialHasLiked={true}
      />,
    );

    expect(likeCount()).toBe("7 likes");
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      "Unlike this list",
    );
  });

  it("does not stomp an in-flight optimistic update with stale props", async () => {
    let resolveLike: (result: { likeCount: number; hasLiked: boolean }) => void;
    vi.mocked(likeList).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLike = resolve;
        }),
    );

    const { rerender } = renderButton({ likeCount: 3, hasLiked: false });
    fireEvent.click(screen.getByRole("button"));
    expect(likeCount()).toBe("4 likes");

    await waitFor(() => expect(likeList).toHaveBeenCalled());

    // Props that CONTRADICT the optimistic state, arriving mid-flight. Without
    // the in-flight guard this would yank the count back to 3 before the request
    // settles, then jump forward again — a visible flicker on every click.
    rerender(
      <ListLikeButton
        listId={LIST_ID}
        initialLikeCount={3}
        initialHasLiked={false}
      />,
    );
    expect(likeCount()).toBe("4 likes");

    resolveLike!({ likeCount: 4, hasLiked: true });
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });

  it("ignores a second click while the first is still in flight", async () => {
    vi.mocked(likeList).mockImplementation(
      () => new Promise(() => {}) as Promise<never>,
    );
    renderButton({ likeCount: 3, hasLiked: false });

    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    // Without this guard the three clicks would send like/unlike/like and the
    // final server state would depend on which response landed last.
    await waitFor(() => expect(likeList).toHaveBeenCalledTimes(1));
    expect(unlikeList).not.toHaveBeenCalled();
  });
});
