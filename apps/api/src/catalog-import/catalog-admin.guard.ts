import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import { CATALOG_ADMIN_USER_IDS_ENV } from "./catalog-import.constants.js";

interface RequestWithUser {
  user?: AuthenticatedUser;
}

/**
 * Authorizes the bulk-import trigger endpoint beyond the global {@link ClerkGuard}.
 *
 * The design doc leaves the import trigger's authorization scheme open ("admin
 * endpoint vs. CLI seed script — recommend guarded admin endpoint + npm
 * script") and Fase 1 has no role/claim model in the Clerk JWT yet, so a full
 * RBAC layer would be premature. This guard uses a lightweight env allowlist of
 * Clerk user ids (`CATALOG_ADMIN_USER_IDS`, comma-separated) checked against the
 * caller's verified `sub`.
 *
 * It fails CLOSED: an unset/empty allowlist denies EVERYONE. This is the
 * opposite of the ClerkGuard's `authorizedParties` fail-OPEN default (Decision
 * #13) — and deliberately so. There, a missing env var risked a full outage, so
 * failing open was the lesser evil. Here, the protected action is an expensive,
 * abusable bulk import (~100k albums, external API load); leaving it reachable
 * by every authenticated user on a misconfiguration is the far worse outcome, so
 * "no config ⇒ nobody" is correct. Trusted local/CI triggering goes through the
 * `seed:catalog` script (in-process, no HTTP), which bypasses this guard.
 */
@Injectable()
export class CatalogAdminGuard implements CanActivate {
  private readonly logger = new Logger(CatalogAdminGuard.name);
  private readonly allowlist: ReadonlySet<string>;

  constructor(config: ConfigService) {
    const raw = config.get<string>(CATALOG_ADMIN_USER_IDS_ENV) ?? "";
    const ids = raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    this.allowlist = new Set(ids);
    if (this.allowlist.size === 0) {
      // Computed once at construction (guard is singleton-scoped), mirroring
      // ClerkGuard's constructor-time warning, so this logs once rather than
      // per request.
      this.logger.warn(
        `${CATALOG_ADMIN_USER_IDS_ENV} is not configured — the catalog import endpoint is disabled (fails closed); trigger imports via the seed:catalog script instead`,
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const sub = request.user?.sub;
    if (typeof sub !== "string" || !this.allowlist.has(sub)) {
      throw new ForbiddenException(
        "You are not authorized to trigger a catalog import.",
      );
    }
    return true;
  }
}
