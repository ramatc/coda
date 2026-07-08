import { SetMetadata } from "@nestjs/common";
import { IS_PUBLIC_KEY } from "./auth.types.js";

/**
 * Marks a route (or an entire controller) as reachable without a Clerk JWT.
 *
 * The global {@link import("./clerk.guard.js").ClerkGuard} protects EVERY route
 * by default. Apply `@Public()` to the exceptions that authenticate by other
 * means or not at all: health/readiness probes (orchestrators and load
 * balancers have no user session) and the Clerk webhook endpoint (verified via
 * a Standard Webhooks / svix signature, not a session token).
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
