import {
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ClerkGuard } from "./clerk.guard.js";

/**
 * Optional-authentication guard: resolves the caller when they present a valid
 * Bearer token, and lets them through as ANONYMOUS when they do not.
 *
 * ## Why this exists
 *
 * `ClerkGuard` is registered as a global `APP_GUARD` and returns `true` on a
 * `@Public()` route *before* it ever parses the Authorization header. On such a
 * route `request.user` is therefore never populated and `@CurrentUser("sub")`
 * is `undefined` for EVERY caller — including a signed-in user holding a valid
 * token. This guard closes that gap: it runs after the global guard, ignores
 * `IS_PUBLIC_KEY`, and performs the inherited verification whenever an
 * Authorization header is present.
 *
 * Use it TOGETHER with `@Public()`, never instead of it: `@Public()` tells the
 * global fail-closed guard not to reject anonymous callers, while this guard
 * still resolves the viewer when a token was sent.
 *
 * ## Scope — read before reusing
 *
 * This is the codebase's FIRST and ONLY optional-auth guard, and it is scoped
 * to exactly ONE route: `GET /reviews/:id` (anonymous review-detail read).
 * Every other route keeps the fail-closed global `ClerkGuard`.
 *
 * - It MUST NEVER be registered as an `APP_GUARD` — that would make the whole
 *   API anonymous-tolerant.
 * - It MUST NEVER be applied to a write endpoint, nor at class level on a
 *   controller that owns write endpoints.
 * - Any new `@UseGuards(OptionalClerkGuard)` requires its own threat review.
 */
@Injectable()
export class OptionalClerkGuard extends ClerkGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      return await this.authenticate(context);
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        return true; // anonymous, not rejected
      }
      // Defensive / future-proofing only — NOT reachable today. Every failure
      // path inside the inherited `authenticate()` (missing token, and the
      // `verifyToken` catch) is normalized into `UnauthorizedException` before
      // it leaves the method, so nothing else can arrive here unless a future
      // change to `authenticate()` throws a different error type. Kept so such
      // a change surfaces as a real error instead of being swallowed as
      // "anonymous". Intentionally untested: the branch cannot be reached
      // without mangling the guard.
      throw err;
    }
  }
}
