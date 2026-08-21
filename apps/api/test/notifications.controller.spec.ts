import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { AppModule } from "../src/app.module.js";
import { IS_PUBLIC_KEY } from "../src/auth/auth.types.js";
import { NotificationsController } from "../src/notifications/notifications.controller.js";
import { NotificationsModule } from "../src/notifications/notifications.module.js";
import { NotificationsService } from "../src/notifications/notifications.service.js";

/**
 * The handlers this controller exposes, in DECLARATION order, paired with the
 * absolute route and HTTP verb each one carries. Declaration order is
 * load-bearing, not cosmetic: Nest matches routes in the order they are
 * registered, so the day a `notifications/:id/read` handler is added it MUST
 * come after all three static segments below or `unread-count` and `read-all`
 * would be swallowed as an `:id` (design "Route-order note"). Pinning the
 * triples here forces that decision to be made deliberately, not by accident.
 *
 * The verb is part of the pin because `read-all` is the module's first non-GET
 * route: it is a POST (the action-verb convention this codebase already uses for
 * like/dismiss/follow), which makes the explicit 200 below necessary.
 */
const ROUTES = [
  ["list", "notifications", RequestMethod.GET],
  ["getUnreadCount", "notifications/unread-count", RequestMethod.GET],
  ["markAllRead", "notifications/read-all", RequestMethod.POST],
] as const;

/** The handler names this controller currently exposes (own prototype methods). */
function handlerNames(): string[] {
  return Object.getOwnPropertyNames(NotificationsController.prototype).filter(
    (name) => name !== "constructor",
  );
}

/**
 * Unit test for {@link NotificationsController} and the module that wires it.
 * Three jobs:
 *
 * 1. Prove each handler is a thin pass-through to {@link NotificationsService} —
 *    the read logic itself is covered in `notifications.service.spec.ts`.
 * 2. Pin the route shape: absolute paths on a prefix-less controller, static
 *    segments only, in an order that leaves no `:id` shadowing hazard.
 * 3. Pin the AUTH POSTURE. A notification is private to its recipient, so this
 *    module has NO anonymous surface: no `@Public()`, no `OptionalClerkGuard`,
 *    on any handler and on the class. `ClerkGuard` resolves both with
 *    `getAllAndOverride([handler, class])`, so a class-level exemption would
 *    expose every route added here later.
 */
describe("NotificationsController", () => {
  let list: ReturnType<typeof vi.fn>;
  let getUnreadCount: ReturnType<typeof vi.fn>;
  let markAllRead: ReturnType<typeof vi.fn>;
  let controller: NotificationsController;

  beforeEach(() => {
    list = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 });
    getUnreadCount = vi.fn().mockResolvedValue({ unreadCount: 4 });
    markAllRead = vi.fn().mockResolvedValue({ unreadCount: 0 });
    controller = new NotificationsController({
      list,
      getUnreadCount,
      markAllRead,
    } as unknown as NotificationsService);
  });

  it("GET /notifications forwards the caller id plus cursor and limit query params", async () => {
    const page = {
      items: [{ id: "n1" }],
      nextCursor: "n1",
      unreadCount: 7,
    };
    list.mockResolvedValueOnce(page);

    const result = await controller.list("clerk_1", "cursor-abc", "10");

    expect(list).toHaveBeenCalledWith("clerk_1", {
      cursor: "cursor-abc",
      limit: "10",
    });
    // Returned by identity: the controller adds no mapping of its own, so the
    // service's page shape IS the wire shape.
    expect(result).toBe(page);
  });

  it("GET /notifications forwards undefined cursor/limit when the query params are absent", async () => {
    const result = await controller.list("clerk_1");

    // Absent params must stay `undefined` rather than being coerced to "" —
    // the service distinguishes "no cursor" from "malformed cursor" (400).
    expect(list).toHaveBeenCalledWith("clerk_1", {
      cursor: undefined,
      limit: undefined,
    });
    expect(result).toEqual({ items: [], nextCursor: null, unreadCount: 0 });
  });

  it("GET /notifications/unread-count forwards the caller id and returns the badge payload", async () => {
    const result = await controller.getUnreadCount("clerk_1");

    // The polled endpoint takes NO query params — it is a bare count keyed on
    // the authenticated caller alone (design Decision 12).
    expect(getUnreadCount).toHaveBeenCalledWith("clerk_1");
    expect(result).toEqual({ unreadCount: 4 });
  });

  it("POST /notifications/read-all forwards the caller id and returns the cleared badge", async () => {
    const result = await controller.markAllRead("clerk_1");

    // Like the polled count route this takes NO body and NO params: "read
    // everything addressed to me" is fully determined by the authenticated
    // caller. Per-item read is deliberately out of v1 scope (design Decision 13).
    expect(markAllRead).toHaveBeenCalledWith("clerk_1");
    expect(result).toEqual({ unreadCount: 0 });
  });

  it("mounts every route as an absolute path on a prefix-less controller", () => {
    // No class-level prefix (matches `ReviewsController`/`SocialController`):
    // Nest's default for a bare `@Controller()` is "/", so each handler carries
    // its own absolute path.
    expect(Reflect.getMetadata(PATH_METADATA, NotificationsController)).toBe(
      "/",
    );

    for (const [name, path, verb] of ROUTES) {
      const handler = NotificationsController.prototype[name];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(verb);
    }
  });

  it("answers read-all with 200, not Nest's default 201 for a POST", () => {
    // `read-all` is idempotent and creates nothing, so 201 would be a lie about
    // the resource model — the same reasoning that makes follow/unfollow 200
    // in `SocialController`. Without the explicit `@HttpCode(200)` Nest would
    // return 201 here and the web client's status check would drift.
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        NotificationsController.prototype.markAllRead,
      ),
    ).toBe(200);

    // ...and the reads stay on Nest's GET default rather than being pinned by
    // accident, which is what proves the assertion above is specific.
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        NotificationsController.prototype.list,
      ),
    ).toBe(undefined);
  });

  it("exposes exactly the three handlers, static routes first", () => {
    // Pinning the surface so any handler added here later has to extend the
    // negative auth assertions below deliberately, rather than silently
    // inheriting no coverage. Declaration order matters: any future
    // `notifications/:id/*` route lands AFTER all three static segments.
    expect(handlerNames()).toEqual(ROUTES.map(([name]) => name));
  });

  it("keeps every handler fail-closed: no @Public() and no guard override", () => {
    for (const [name] of ROUTES) {
      const handler = NotificationsController.prototype[name];
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(undefined);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBe(undefined);
    }
    // Nothing at class level either. `OptionalClerkGuard` exists for
    // `GET /reviews/:id` and must never be copied onto this module: a
    // notification list is private data, and an anonymous-tolerant read here
    // would hand `@CurrentUser("sub")` an `undefined` caller instead of 401-ing.
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, NotificationsController)).toBe(
      undefined,
    );
    expect(Reflect.getMetadata(GUARDS_METADATA, NotificationsController)).toBe(
      undefined,
    );
  });
});

describe("NotificationsModule", () => {
  it("declares the controller and provides the service", () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, NotificationsModule),
    ).toEqual([NotificationsController]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, NotificationsModule),
    ).toEqual([NotificationsService]);
  });

  it("exports NotificationsService so the hook-site modules can inject it", () => {
    // PR2 makes `SocialModule` and `ReviewsModule` import this module to call
    // `notifyFollow`/`notifyComment`. Without the export, that injection fails
    // at bootstrap — this assertion is the contract those slices depend on.
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, NotificationsModule),
    ).toEqual([NotificationsService]);
  });

  it("imports no other module, which is what keeps the dependency graph acyclic", () => {
    // Deliberately empty, and provably so: `PrismaModule` and `ConfigModule`
    // are global, so this module needs no import to reach them. Since
    // `SocialModule`/`ReviewsModule` will import THIS module in PR2, any import
    // added back here toward a feature module would close a cycle.
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, NotificationsModule) ?? [],
    ).toEqual([]);
  });

  it("is registered in AppModule so the routes are actually reachable", () => {
    // The service and controller can be perfect and still serve 404s if the
    // module never reaches the root graph.
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[],
    ).toContain(NotificationsModule);
  });
});
