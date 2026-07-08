import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthenticatedUser } from "./auth.types.js";

interface RequestWithUser {
  user?: AuthenticatedUser;
}

/**
 * Injects the authenticated Clerk user (the verified JWT payload) into a
 * handler parameter. Populated by {@link import("./clerk.guard.js").ClerkGuard}
 * after it verifies the Bearer token.
 *
 * Usage:
 *   `@CurrentUser() user: AuthenticatedUser`      → full payload
 *   `@CurrentUser("sub") clerkUserId: string`      → a single claim
 *
 * On a `@Public()` route the guard never runs, so `user` is undefined there.
 *
 * The factory's parameter and return types are deliberately kept off the
 * Clerk-internal `JwtPayload` type so the exported decorator's inferred type
 * stays portable (TS2742); handlers annotate the parameter type explicitly.
 */
export const CurrentUser = createParamDecorator(
  (field: string | undefined, ctx: ExecutionContext): unknown => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (!user) {
      return undefined;
    }
    return field ? (user as Record<string, unknown>)[field] : user;
  },
);
