// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CreateListForm } from "../app/lists/new/create-list-form";
import { createList, type ListDetail } from "../lib/lists";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("../lib/lists", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/lists")>();
  return { ...actual, createList: vi.fn() };
});

const CREATED: ListDetail = {
  id: "list-42",
  userId: "user-1",
  title: "Best of 2026",
  description: null,
  isRanked: false,
  isPublic: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  items: [],
  likeCount: 0,
  viewerHasLiked: false,
};

/** The submit button, which is disabled until the form is valid. */
function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Create list" }) as HTMLButtonElement;
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
  pushMock.mockClear();
  vi.mocked(createList).mockReset().mockResolvedValue(CREATED);
});

describe("CreateListForm", () => {
  it("keeps submit disabled until a title is typed", () => {
    render(<CreateListForm />);

    expect(submitButton().disabled).toBe(true);

    type("Title", "Best of 2026");

    expect(submitButton().disabled).toBe(false);
  });

  it("keeps submit disabled for a whitespace-only title", () => {
    render(<CreateListForm />);

    type("Title", "   ");

    expect(submitButton().disabled).toBe(true);
  });

  it("creates a public, unranked, description-less list by default and opens it", async () => {
    render(<CreateListForm />);

    type("Title", "Best of 2026");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(createList).toHaveBeenCalledWith("test-token", {
        title: "Best of 2026",
        description: null,
        isRanked: false,
        isPublic: true,
      }),
    );
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/lists/list-42"));
  });

  it("sends the typed description and both flipped flags", async () => {
    render(<CreateListForm />);

    type("Title", "Ranked private picks");
    type("Description", "Only for me.");
    fireEvent.click(screen.getByLabelText("Ranked list"));
    fireEvent.click(screen.getByLabelText("Visible to everyone"));
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(createList).toHaveBeenCalledWith("test-token", {
        title: "Ranked private picks",
        description: "Only for me.",
        isRanked: true,
        isPublic: false,
      }),
    );
  });

  it("trims the title and description before sending them", async () => {
    render(<CreateListForm />);

    type("Title", "  Best of 2026  ");
    type("Description", "   ");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(createList).toHaveBeenCalledWith("test-token", {
        title: "Best of 2026",
        description: null,
        isRanked: false,
        isPublic: true,
      }),
    );
  });

  it("surfaces the API's message and stays put when creation fails", async () => {
    vi.mocked(createList).mockRejectedValue(
      new Error("title must be at most 120 characters."),
    );
    render(<CreateListForm />);

    type("Title", "Best of 2026");
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "title must be at most 120 characters.",
      ),
    );
    expect(pushMock).not.toHaveBeenCalled();
    // The form stays usable so the user can correct and retry.
    expect(submitButton().disabled).toBe(false);
  });
});
