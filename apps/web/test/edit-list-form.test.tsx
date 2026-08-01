// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { EditListForm } from "../app/lists/[id]/edit-list-form";
import { updateList, type ListDetail } from "../lib/lists";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("../lib/lists", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/lists")>();
  return { ...actual, updateList: vi.fn() };
});

/** The list the form edits, with the given overrides applied. */
function list(overrides: Partial<ListDetail> = {}): ListDetail {
  return {
    id: "list-1",
    userId: "user-owner",
    title: "Best of 2026",
    description: "A ranked run through the year.",
    isRanked: true,
    isPublic: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    items: [],
    likeCount: 0,
    viewerHasLiked: false,
    ...overrides,
  };
}

/** Opens the collapsed form by clicking its trigger. */
function openForm(): void {
  fireEvent.click(screen.getByRole("button", { name: "Edit list" }));
}

/** The save button, which stays disabled until there is a valid change. */
function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Save changes",
  }) as HTMLButtonElement;
}

/** Types `value` into the field with the given accessible label. */
function type(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  refreshMock.mockClear();
  vi.mocked(updateList).mockReset().mockResolvedValue(list());
});

describe("EditListForm", () => {
  it("shows only a trigger until the owner opens it", () => {
    render(<EditListForm list={list()} />);

    expect(screen.getByRole("button", { name: "Edit list" })).not.toBeNull();
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("seeds every field from the list's current values", () => {
    render(<EditListForm list={list({ isRanked: false })} />);

    openForm();

    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Best of 2026",
    );
    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("A ranked run through the year.");
    expect(
      (screen.getByLabelText("Ranked list") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByLabelText("Visible to everyone") as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("seeds an empty description field for a list without one", () => {
    render(<EditListForm list={list({ description: null })} />);

    openForm();

    expect(
      (screen.getByLabelText("Description") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("sends ONLY the changed field, not the whole list", async () => {
    render(<EditListForm list={list()} />);

    openForm();
    type("Title", "Best of 2027");
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(updateList).toHaveBeenCalledWith("test-token", "list-1", {
        title: "Best of 2027",
      }),
    );
  });

  it("sends both flags and the description when only those change", async () => {
    render(<EditListForm list={list()} />);

    openForm();
    type("Description", "Now with commentary.");
    fireEvent.click(screen.getByLabelText("Ranked list"));
    fireEvent.click(screen.getByLabelText("Visible to everyone"));
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(updateList).toHaveBeenCalledWith("test-token", "list-1", {
        description: "Now with commentary.",
        isRanked: false,
        isPublic: false,
      }),
    );
  });

  it("trims the title and collapses a blanked description to null", async () => {
    render(<EditListForm list={list()} />);

    openForm();
    type("Title", "  Best of 2027  ");
    type("Description", "   ");
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(updateList).toHaveBeenCalledWith("test-token", "list-1", {
        title: "Best of 2027",
        description: null,
      }),
    );
  });

  it("keeps save disabled until something actually changes", () => {
    render(<EditListForm list={list()} />);

    openForm();

    // An unchanged form would build an empty patch, which the API rejects with
    // a 400 — so the request is made unreachable rather than surfaced.
    expect(saveButton().disabled).toBe(true);

    type("Title", "Best of 2027");
    expect(saveButton().disabled).toBe(false);

    type("Title", "Best of 2026");
    expect(saveButton().disabled).toBe(true);
  });

  it("keeps save disabled for a whitespace-only title", () => {
    render(<EditListForm list={list()} />);

    openForm();
    type("Title", "   ");

    expect(saveButton().disabled).toBe(true);
  });

  it("refreshes the server page and closes the form on success", async () => {
    render(<EditListForm list={list()} />);

    openForm();
    type("Title", "Best of 2027");
    fireEvent.click(saveButton());

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit list" })).not.toBeNull(),
    );
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("surfaces the API's message and keeps the form open on failure", async () => {
    vi.mocked(updateList).mockRejectedValue(
      new Error("title must be at most 120 characters."),
    );
    render(<EditListForm list={list()} />);

    openForm();
    type("Title", "Best of 2027");
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "title must be at most 120 characters.",
      ),
    );
    expect(refreshMock).not.toHaveBeenCalled();
    // The edits survive so the owner can correct and retry.
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Best of 2027",
    );
    expect(saveButton().disabled).toBe(false);
  });

  it("does not surface a refresh failure after a successful save", async () => {
    const consoleErrorMock = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const refreshFailure = new Error("refresh blew up");
    refreshMock.mockImplementationOnce(() => {
      throw refreshFailure;
    });
    render(<EditListForm list={list()} />);

    openForm();
    type("Title", "Best of 2027");
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(updateList).toHaveBeenCalledWith("test-token", "list-1", {
        title: "Best of 2027",
      }),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));

    // The save already persisted and the form already collapsed, so the
    // committed success state must survive the throwing refresh…
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit list" })).not.toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    // …and the failure must leave a diagnosable trace rather than vanishing
    // into an error state the collapsed branch never renders. Without the
    // local catch the exception silently sets `status` to "error" behind a
    // form that is no longer on screen: invisible today, and a false banner
    // the moment the collapsed branch learns to render one.
    expect(consoleErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("router.refresh()"),
      refreshFailure,
    );
  });

  it("discards edits on cancel and re-seeds from the list on the next open", () => {
    render(<EditListForm list={list()} />);

    openForm();
    type("Title", "Best of 2027");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(updateList).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Title")).toBeNull();

    openForm();

    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(
      "Best of 2026",
    );
  });
});
