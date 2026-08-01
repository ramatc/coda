// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ReviewDetailView } from "../app/reviews/[id]/review-detail";
import type { ReviewComment, ReviewDetail } from "../lib/reviews";

// Render next/link as a plain anchor so the pure component renders without a
// router context (same pattern as the list-detail and feed-list tests).
// Every prop other than `href` is forwarded rather than dropped, so
// `data-testid` and friends survive into the DOM — without that, a
// `getByTestId` on a link silently fails and a `not.toContain(testid)`
// assertion passes for the wrong reason.
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
});

/** Builds a comment whose body doubles as its test identity. */
function comment(
  id: string,
  body: string,
  overrides: Partial<ReviewComment> = {},
): ReviewComment {
  return {
    id,
    body,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    author: { username: "jonny", displayName: "Jonny", avatarUrl: null },
    isOwn: false,
    ...overrides,
  };
}

/** Builds a review detail with the given overrides applied. */
function review(overrides: Partial<ReviewDetail> = {}): ReviewDetail {
  return {
    id: "review-1",
    body: "A slow burn that finally clicks on the fourth listen.",
    isSpoiler: false,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    album: {
      id: "album-1",
      title: "Kid A",
      coverUrl: null,
      primaryArtistName: "Radiohead",
    },
    author: { username: "thom", displayName: "Thom", avatarUrl: null },
    likeCount: 3,
    commentCount: 1,
    comments: [comment("comment-1", "Agreed on the fourth listen.")],
    viewer: { hasLiked: false, canInteract: false },
    ...overrides,
  };
}

/** The viewer block of an anonymous (logged-out) visitor. */
const ANONYMOUS = { hasLiked: false, canInteract: false };

/** The viewer block of a signed-in, synced visitor. */
const SIGNED_IN = { hasLiked: false, canInteract: true };

/** The comment bodies currently rendered, in row order. */
function renderedCommentBodies(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((row) => within(row).getByTestId("comment-body").textContent ?? "");
}

describe("ReviewDetailView", () => {
  it("renders the review body under the album it is about", () => {
    render(<ReviewDetailView review={review()} />);

    expect(screen.getByRole("heading", { name: "Kid A" })).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Kid A" }).getAttribute("href"),
    ).toBe("/albums/album-1");
    expect(screen.getByText("Radiohead")).not.toBeNull();
    expect(
      screen.getByText("A slow burn that finally clicks on the fourth listen."),
    ).not.toBeNull();
  });

  it("attributes the review to its author's profile", () => {
    render(<ReviewDetailView review={review()} />);

    const authorLink = screen.getByRole("link", { name: "Thom" });
    expect(authorLink.getAttribute("href")).toBe("/u/thom");
  });

  it("falls back to the @username when the author carries no display name", () => {
    render(
      <ReviewDetailView
        review={review({
          author: { username: "thom", displayName: "  ", avatarUrl: null },
        })}
      />,
    );

    expect(screen.getByRole("link", { name: "@thom" })).not.toBeNull();
  });

  it("warns before the body of a review flagged as a spoiler", () => {
    render(<ReviewDetailView review={review({ isSpoiler: true })} />);

    expect(screen.getByTestId("review-spoiler-warning").textContent).toBe(
      "Contains spoilers",
    );
  });

  it("shows no spoiler warning on an unflagged review", () => {
    render(<ReviewDetailView review={review({ isSpoiler: false })} />);

    expect(screen.queryByTestId("review-spoiler-warning")).toBeNull();
  });

  it("summarizes the like and comment counts", () => {
    render(
      <ReviewDetailView review={review({ likeCount: 3, commentCount: 1 })} />,
    );

    const counts = screen.getByTestId("review-counts").textContent ?? "";
    expect(counts).toContain("3 likes");
    expect(counts).toContain("1 comment");
    expect(counts).not.toContain("1 comments");
  });

  it("singularizes a lone like and pluralizes the comments", () => {
    render(
      <ReviewDetailView review={review({ likeCount: 1, commentCount: 2 })} />,
    );

    const counts = screen.getByTestId("review-counts").textContent ?? "";
    expect(counts).toContain("1 like");
    expect(counts).not.toContain("1 likes");
    expect(counts).toContain("2 comments");
  });

  it("renders every comment in payload order with its author", () => {
    render(
      <ReviewDetailView
        review={review({
          comments: [
            comment("c1", "First in."),
            comment("c2", "Second, actually.", {
              author: { username: "ed", displayName: "Ed", avatarUrl: null },
            }),
          ],
        })}
      />,
    );

    expect(renderedCommentBodies()).toEqual(["First in.", "Second, actually."]);
    expect(screen.getByRole("link", { name: "Ed" }).getAttribute("href")).toBe(
      "/u/ed",
    );
  });

  it("renders an empty state instead of a comment list when there are none", () => {
    render(<ReviewDetailView review={review({ comments: [] })} />);

    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.getByText("No comments yet.")).not.toBeNull();
  });

  it("renders the full read-only review for an anonymous visitor", () => {
    render(<ReviewDetailView review={review({ viewer: ANONYMOUS })} />);

    // The read path is identical for a logged-out visitor: body, counts and
    // comments all render. Only the live controls (handed down as slots) are
    // absent, because the server page has no islands to give an anonymous view.
    expect(
      screen.getByText("A slow burn that finally clicks on the fourth listen."),
    ).not.toBeNull();
    expect(screen.getByTestId("review-counts").textContent).toContain(
      "3 likes",
    );
    expect(renderedCommentBodies()).toEqual(["Agreed on the fourth listen."]);
    expect(screen.queryByTestId("like-island")).toBeNull();
    expect(screen.queryByTestId("comment-form-island")).toBeNull();
  });

  it("renders the live like and comment controls handed to a signed-in viewer", () => {
    render(
      <ReviewDetailView
        review={review({ viewer: SIGNED_IN })}
        likeAction={<button data-testid="like-island">Like</button>}
        commentForm={<form data-testid="comment-form-island" />}
      />,
    );

    expect(screen.getByTestId("like-island")).not.toBeNull();
    expect(screen.getByTestId("comment-form-island")).not.toBeNull();
    // The read-only content is unchanged by the presence of the islands.
    expect(screen.getByTestId("review-counts").textContent).toContain(
      "3 likes",
    );
  });

  it("hands each comment to the per-row control slot so the author's own row gets it", () => {
    render(
      <ReviewDetailView
        review={review({
          viewer: SIGNED_IN,
          comments: [
            comment("c1", "Mine.", { isOwn: true }),
            comment("c2", "Someone else's."),
          ],
        })}
        commentAction={(target) =>
          target.isOwn ? (
            <button data-testid={`edit-${target.id}`}>Edit</button>
          ) : null
        }
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByTestId("edit-c1")).not.toBeNull();
    expect(within(rows[1]!).queryByTestId("edit-c2")).toBeNull();
  });

  it("renders no per-row controls when no control slot is supplied", () => {
    render(
      <ReviewDetailView
        review={review({
          viewer: ANONYMOUS,
          comments: [comment("c1", "Mine.", { isOwn: true })],
        })}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
