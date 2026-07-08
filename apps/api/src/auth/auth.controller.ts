import { Controller, Get } from "@nestjs/common";
import { CurrentUser } from "./current-user.decorator.js";
import type { AuthenticatedUser } from "./auth.types.js";

export interface WhoAmIResponse {
  clerkUserId: string;
  sessionId: string | undefined;
}

/**
 * Authenticated identity endpoint. Deliberately NOT `@Public()`, so it sits
 * behind the global `ClerkGuard` and doubles as the reference protected route:
 * it echoes the verified Clerk claims resolved by `@CurrentUser()`.
 */
@Controller("auth")
export class AuthController {
  @Get("me")
  me(@CurrentUser() user: AuthenticatedUser): WhoAmIResponse {
    return { clerkUserId: user.sub, sessionId: user.sid };
  }
}
