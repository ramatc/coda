import { describe, expect, it, vi } from "vitest";

const { clerkMiddleware } = vi.hoisted(() => ({
  clerkMiddleware: vi.fn(() => () => undefined),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware,
  createRouteMatcher: () => () => false,
}));

/**
 * `auth.protect()` resolves its redirect target on the SERVER, from the
 * middleware's own options (or `NEXT_PUBLIC_CLERK_SIGN_IN_URL`) — it never
 * sees the props on `<ClerkProvider>`. Without these options a signed-out
 * visitor to a protected route is sent to Clerk's hosted Account Portal
 * instead of the in-app `/sign-in` page.
 */
describe("middleware auth URLs", () => {
  it("points auth.protect() at the in-app sign-in and sign-up routes", async () => {
    await import("../middleware");

    expect(clerkMiddleware).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ signInUrl: "/sign-in", signUpUrl: "/sign-up" }),
    );
  });
});
