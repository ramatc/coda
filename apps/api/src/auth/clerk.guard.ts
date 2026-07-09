import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { verifyToken } from "@clerk/backend";
import { type AuthenticatedUser, IS_PUBLIC_KEY } from "./auth.types.js";

interface GuardedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

/**
 * Global authentication guard (registered as `APP_GUARD`, Decision #1).
 *
 * Fail-closed: every route requires a valid Clerk-issued session token unless
 * explicitly opted out with `@Public()`. The Bearer token is verified with
 * `@clerk/backend`'s `verifyToken`, which throws on a missing/expired/tampered
 * token; on success the verified payload is attached to `request.user` for
 * `@CurrentUser()`.
 *
 * This is the API's FIRST auth surface — Fase 0 had no guard (flagged
 * deviation).
 */
@Injectable()
export class ClerkGuard implements CanActivate {
  private readonly logger = new Logger(ClerkGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException("Missing bearer token");
    }

    try {
      const payload = await verifyToken(token, {
        secretKey: this.config.get<string>("CLERK_SECRET_KEY"),
        authorizedParties: this.getAuthorizedParties(),
      });
      request.user = payload;
      return true;
    } catch (err) {
      this.logger.warn(
        `Clerk token verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new UnauthorizedException("Invalid or expired token");
    }
  }

  /**
   * Origins allowed as the token's `azp` claim. Without this, `verifyToken`
   * only checks the signature/expiry, so a valid token minted for a
   * *different* frontend on the same Clerk instance would also pass. Reuses
   * `APP_URL` (the web app's own origin, already documented in the repo's env
   * vars) rather than introducing a redundant config key.
   */
  private getAuthorizedParties(): string[] | undefined {
    const appUrl = this.config.get<string>("APP_URL");
    if (!appUrl) {
      // Fails OPEN (skips the azp check) rather than closed: a missing
      // `APP_URL` here is an env misconfiguration, and failing closed would
      // turn it into a full API outage (every request rejected) rather than
      // the narrower risk it actually is — a token minted for a different
      // frontend on the same Clerk instance also being accepted. `verifyToken`
      // above still enforces signature + expiry regardless, so this only
      // widens the *origin* check, not authentication itself. Logged so the
      // gap is visible instead of silent.
      this.logger.warn(
        "APP_URL is not configured — authorizedParties check is disabled, any valid Clerk session token will be accepted regardless of origin",
      );
      return undefined;
    }
    return [appUrl];
  }

  private extractBearerToken(request: GuardedRequest): string | undefined {
    const header = request.headers?.authorization;
    if (typeof header !== "string") {
      return undefined;
    }
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      return undefined;
    }
    return token;
  }
}
