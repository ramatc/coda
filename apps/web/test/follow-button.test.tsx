// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FollowButton } from "../app/u/[username]/follow-button";
import { followUser, unfollowUser } from "../lib/social";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("../lib/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/social")>();
  return {
    ...actual,
    followUser: vi.fn(),
    unfollowUser: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  refreshMock.mockClear();
  vi.mocked(followUser).mockReset().mockResolvedValue(undefined);
  vi.mocked(unfollowUser).mockReset().mockResolvedValue(undefined);
});

const USERNAME = "ada";

describe("FollowButton", () => {
  it("shows 'Follow' when not following, flips optimistically and calls followUser on click", async () => {
    render(<FollowButton username={USERNAME} initialFollowing={false} />);

    const button = screen.getByRole("button");
    expect(button.textContent).toBe("Follow");

    fireEvent.click(button);

    // Optimistic flip: the label switches immediately, before the request settles.
    expect(screen.getByRole("button").textContent).toBe("Following");

    await waitFor(() =>
      expect(followUser).toHaveBeenCalledWith("test-token", USERNAME),
    );
    // The server re-fetches so the follower count on the profile updates in place.
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(unfollowUser).not.toHaveBeenCalled();
  });

  it("shows 'Following' when already following, flips optimistically and calls unfollowUser on click", async () => {
    render(<FollowButton username={USERNAME} initialFollowing={true} />);

    const button = screen.getByRole("button");
    expect(button.textContent).toBe("Following");

    fireEvent.click(button);

    expect(screen.getByRole("button").textContent).toBe("Follow");

    await waitFor(() =>
      expect(unfollowUser).toHaveBeenCalledWith("test-token", USERNAME),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(followUser).not.toHaveBeenCalled();
  });

  it("exposes an action-describing aria-label for the current follow state", () => {
    render(<FollowButton username={USERNAME} initialFollowing={false} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      `Follow ${USERNAME}`,
    );

    cleanup();

    render(<FollowButton username={USERNAME} initialFollowing={true} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
      `Unfollow ${USERNAME}`,
    );
  });

  it("rolls back the optimistic flip and surfaces an error when the follow request fails", async () => {
    vi.mocked(followUser).mockRejectedValue(
      new Error("Could not follow this user."),
    );
    render(<FollowButton username={USERNAME} initialFollowing={false} />);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Could not follow this user.",
      ),
    );
    // Rolled back to the pre-click "Follow" state — no phantom follow persists.
    expect(screen.getByRole("button").textContent).toBe("Follow");
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("re-syncs the displayed state when the initialFollowing prop changes on re-render", () => {
    // Simulates a `router.refresh()` result: the same component instance
    // receives fresh server-authoritative props without unmounting.
    const { rerender } = render(
      <FollowButton username={USERNAME} initialFollowing={false} />,
    );
    expect(screen.getByRole("button").textContent).toBe("Follow");

    rerender(<FollowButton username={USERNAME} initialFollowing={true} />);
    expect(screen.getByRole("button").textContent).toBe("Following");

    rerender(<FollowButton username={USERNAME} initialFollowing={false} />);
    expect(screen.getByRole("button").textContent).toBe("Follow");
  });

  it("does not stomp an in-flight optimistic toggle when initialFollowing re-renders stale", async () => {
    // While the unfollow request is in flight (busy), re-renders carrying a
    // fresh `initialFollowing` prop — even one that contradicts the optimistic
    // state — must not override the optimistic flip until the request settles.
    let resolveUnfollow: () => void;
    vi.mocked(unfollowUser).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveUnfollow = resolve;
        }),
    );

    const { rerender } = render(
      <FollowButton username={USERNAME} initialFollowing={true} />,
    );
    expect(screen.getByRole("button").textContent).toBe("Following");

    fireEvent.click(screen.getByRole("button"));
    // Optimistic flip: unfollow in flight.
    expect(screen.getByRole("button").textContent).toBe("Follow");

    // Wait for the in-flight request to actually be underway (busy) before
    // exercising the stale re-renders.
    await waitFor(() => expect(unfollowUser).toHaveBeenCalled());

    // A real dependency change that happens to agree with the optimistic
    // value — no observable effect either way.
    rerender(<FollowButton username={USERNAME} initialFollowing={false} />);
    expect(screen.getByRole("button").textContent).toBe("Follow");

    // A real dependency change that CONTRADICTS the current optimistic state.
    // If the `busy` guard were missing, this would force the label back to
    // "Following" right now, before the request settles.
    rerender(<FollowButton username={USERNAME} initialFollowing={true} />);
    expect(screen.getByRole("button").textContent).toBe("Follow");

    resolveUnfollow!();
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button").textContent).toBe("Follow");
  });
});
