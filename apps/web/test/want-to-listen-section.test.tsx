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
import { WantToListenSection } from "../app/u/[username]/want-to-listen-section";
import {
  unmarkWantToListen,
  type WantToListenEntry,
} from "../lib/want-to-listen";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

vi.mock("../lib/want-to-listen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/want-to-listen")>();
  return { ...actual, unmarkWantToListen: vi.fn() };
});

/** Builds a backlog entry whose album title doubles as its test identity. */
function entry(id: string, title: string, artist = "Radiohead"): WantToListenEntry {
  return {
    id,
    albumId: `album-${id}`,
    createdAt: "2026-07-01T00:00:00.000Z",
    album: {
      id: `album-${id}`,
      title,
      coverUrl: null,
      primaryArtistName: artist,
    },
  };
}

const ENTRIES: WantToListenEntry[] = [
  entry("a", "Kid A"),
  entry("b", "Amnesiac"),
  entry("c", "In Rainbows"),
];

/** The album titles currently rendered, in row order. */
function renderedTitles(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => within(row).getByRole("link").textContent ?? "");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  refreshMock.mockClear();
  vi.mocked(unmarkWantToListen).mockReset().mockResolvedValue(undefined);
});

describe("WantToListenSection", () => {
  it("renders every entry with its album linked and its artist named", () => {
    render(<WantToListenSection entries={ENTRIES} isOwnProfile={false} />);

    expect(renderedTitles()).toEqual(["Kid A", "Amnesiac", "In Rainbows"]);
    expect(screen.getByRole("link", { name: "Kid A" }).getAttribute("href")).toBe(
      "/albums/album-a",
    );
    expect(screen.getAllByText("Radiohead")).toHaveLength(3);
  });

  it("renders as its own labelled section, distinct from the profile's other sections", () => {
    render(<WantToListenSection entries={ENTRIES} isOwnProfile={false} />);

    const section = screen.getByRole("region", { name: "Want to listen" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(section).getByRole("heading", { name: "Want to listen" }),
    ).not.toBeNull();
  });

  it("still renders the section with an empty state when nothing is marked", () => {
    render(<WantToListenSection entries={[]} isOwnProfile={true} />);

    // The section MUST exist per user even when empty — an absent section, not
    // an empty one, is the failure mode this guards against.
    expect(
      screen.getByRole("region", { name: "Want to listen" }),
    ).not.toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(
      screen.getByText("Nothing on the want-to-listen list yet."),
    ).not.toBeNull();
  });

  it("gives the owner one remove control per entry and nothing that acts on the section itself", () => {
    render(<WantToListenSection entries={ENTRIES} isOwnProfile={true} />);

    // Exactly one control per entry: the container is fixed — never renamed,
    // deleted or reordered — so no extra button may exist.
    expect(screen.getAllByRole("button")).toHaveLength(ENTRIES.length);
    expect(
      screen.getByRole("button", {
        name: "Remove Amnesiac by Radiohead from want to listen",
      }),
    ).not.toBeNull();
  });

  it("gives duplicate-titled entries distinct remove labels", () => {
    render(
      <WantToListenSection
        entries={[
          entry("x", "Greatest Hits", "Artist One"),
          entry("y", "Greatest Hits", "Artist Two"),
        ]}
        isOwnProfile={true}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Remove Greatest Hits by Artist One from want to listen",
      }),
    ).not.toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Remove Greatest Hits by Artist Two from want to listen",
      }),
    ).not.toBeNull();
  });

  it("offers a visitor no controls at all — the backlog is read-only to them", () => {
    render(<WantToListenSection entries={ENTRIES} isOwnProfile={false} />);

    expect(renderedTitles()).toEqual(["Kid A", "Amnesiac", "In Rainbows"]);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("drops the row optimistically, unmarks BY ALBUM id, then refreshes", async () => {
    render(<WantToListenSection entries={ENTRIES} isOwnProfile={true} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Amnesiac by Radiohead from want to listen",
      }),
    );

    // Optimistic: the row is gone before the request settles.
    expect(renderedTitles()).toEqual(["Kid A", "In Rainbows"]);

    await waitFor(() =>
      // Addressed by ALBUM id (the API scopes the delete to the caller's own
      // row for that album), never by the entry's own id.
      expect(unmarkWantToListen).toHaveBeenCalledWith("test-token", "album-b"),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("restores the row and surfaces the API message when the removal fails", async () => {
    vi.mocked(unmarkWantToListen).mockRejectedValue(
      new Error("Want-to-listen entry not found."),
    );
    render(<WantToListenSection entries={ENTRIES} isOwnProfile={true} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Kid A by Radiohead from want to listen",
      }),
    );

    expect(renderedTitles()).toEqual(["Amnesiac", "In Rainbows"]);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "Want-to-listen entry not found.",
      ),
    );
    // Rolled back — a rejected removal never leaves a phantom deletion.
    expect(renderedTitles()).toEqual(["Kid A", "Amnesiac", "In Rainbows"]);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("re-syncs from fresh server props after a refresh lands", () => {
    const { rerender } = render(
      <WantToListenSection entries={ENTRIES} isOwnProfile={true} />,
    );
    expect(renderedTitles()).toEqual(["Kid A", "Amnesiac", "In Rainbows"]);

    // The profile page re-fetched: the owner logged a Listen for "Amnesiac", so
    // read-time auto-resolve dropped it from the backlog.
    rerender(
      <WantToListenSection
        entries={[ENTRIES[0], ENTRIES[2]]}
        isOwnProfile={true}
      />,
    );

    expect(renderedTitles()).toEqual(["Kid A", "In Rainbows"]);
  });

  it("does not stomp an in-flight optimistic removal with stale server props", async () => {
    let settle: () => void = () => undefined;
    vi.mocked(unmarkWantToListen).mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve();
        }),
    );

    const { rerender } = render(
      <WantToListenSection entries={ENTRIES} isOwnProfile={true} />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Kid A by Radiohead from want to listen",
      }),
    );
    expect(renderedTitles()).toEqual(["Amnesiac", "In Rainbows"]);

    await waitFor(() => expect(unmarkWantToListen).toHaveBeenCalled());

    // A stale re-render still carrying the removed entry must not resurrect it
    // while the request is in flight.
    rerender(
      <WantToListenSection entries={[...ENTRIES]} isOwnProfile={true} />,
    );
    expect(renderedTitles()).toEqual(["Amnesiac", "In Rainbows"]);

    settle();
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
  });
});
