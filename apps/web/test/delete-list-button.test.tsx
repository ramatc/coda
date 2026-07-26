// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DeleteListButton } from "../app/lists/[id]/delete-list-button";
import { deleteList } from "../lib/lists";
import { HOME_PATH } from "../lib/onboarding";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("../lib/lists", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/lists")>();
  return { ...actual, deleteList: vi.fn() };
});

const LIST = { id: "list-1", title: "Best of 2026" };

/**
 * The island's only button. Queried without a name so the same helper works
 * after its label switches to the in-flight one.
 */
function deleteButton(): HTMLButtonElement {
  return screen.getByRole("button") as HTMLButtonElement;
}

let confirmMock: ReturnType<typeof vi.spyOn>;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  pushMock.mockClear();
  vi.mocked(deleteList).mockReset().mockResolvedValue(undefined);
  confirmMock = vi
    .spyOn(window, "confirm")
    .mockReturnValue(true) as unknown as ReturnType<typeof vi.spyOn>;
});

describe("DeleteListButton", () => {
  it("asks for confirmation, naming the list and its items", () => {
    render(<DeleteListButton list={LIST} />);

    expect(deleteButton().textContent).toBe("Delete list");

    fireEvent.click(deleteButton());

    expect(confirmMock).toHaveBeenCalledWith(
      'Delete "Best of 2026"? This removes the list and every album on it, and cannot be undone.',
    );
  });

  it("deletes nothing when the confirmation is dismissed", async () => {
    confirmMock.mockReturnValue(false);
    render(<DeleteListButton list={LIST} />);

    fireEvent.click(deleteButton());

    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(deleteList).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(deleteButton().disabled).toBe(false);
  });

  it("deletes the list and leaves for home once confirmed", async () => {
    render(<DeleteListButton list={LIST} />);

    fireEvent.click(deleteButton());

    await waitFor(() =>
      expect(deleteList).toHaveBeenCalledWith("test-token", "list-1"),
    );
    // There is no list index to return to, so home is the destination.
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(HOME_PATH));
  });

  it("stays disabled after a successful delete so it cannot fire twice", async () => {
    render(<DeleteListButton list={LIST} />);

    fireEvent.click(deleteButton());

    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    // The navigation is already under way; re-enabling would allow a second
    // delete against a list that no longer exists.
    expect(deleteButton().disabled).toBe(true);
  });

  it("surfaces the API's message and stays put when the delete fails", async () => {
    vi.mocked(deleteList).mockRejectedValue(
      new Error("You do not own this list."),
    );
    render(<DeleteListButton list={LIST} />);

    fireEvent.click(deleteButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "You do not own this list.",
      ),
    );
    expect(pushMock).not.toHaveBeenCalled();
    // Re-enabled so the owner can retry after a transient failure.
    expect(deleteButton().disabled).toBe(false);
  });
});
