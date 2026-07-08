import type { verifyToken } from "@clerk/backend";

/**
 * Shape of a verified Clerk session token payload.
 *
 * Derived from `@clerk/backend`'s `verifyToken` return type so it stays in sync
 * with the SDK (JWT claims: `sub` = Clerk user id, `sid` = session id, etc.)
 * without importing an internal type by name.
 */
export type AuthenticatedUser = Awaited<ReturnType<typeof verifyToken>>;

/** Metadata key set by the `@Public()` decorator and read by `ClerkGuard`. */
export const IS_PUBLIC_KEY = "isPublic";
