import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
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
 * absolute route each one carries. Declaration order is load-bearing, not
 * cosmetic: Nest matches routes in the order they are registered, so the day a
 * `notifications/:id/read` handler is added it MUST come after both static
 * segments below or `unread-count` would be swallowed as an `:id` (design
 * "Route-order note"). Pinning the pairs here forces that decision to be made
 * deliberately instead of by accident.
 */
const ROUTES = [
  ["list", "notifications"],
  ["getUnreadCount", "notifications/unread-count"],
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
  let controller: NotificationsController;

  beforeEach(() => {
    list = vi
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null, unreadCount: 0 });
    getUnreadCount = vi.fn().mockResolvedValue({ unreadCount: 4 });
    controller = new NotificationsController({
      list,
      getUnreadCount,
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

  it("mounts both routes as absolute GET paths on a prefix-less controller", () => {
    // No class-level prefix (matches `ReviewsController`/`SocialController`):
    // Nest's default for a bare `@Controller()` is "/", so each handler carries
    // its own absolute path.
    expect(Reflect.getMetadata(PATH_METADATA, NotificationsController)).toBe(
      "/",
    );

    for (const [name, path] of ROUTES) {
      const handler = NotificationsController.prototype[name];
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
        RequestMethod.GET,
      );
    }
  });

  it("exposes exactly the two read handlers, static routes first", () => {
    // Pinning the surface so any handler added here later has to extend the
    // negative auth assertions below deliberately, rather than silently
    // inheriting no coverage. `read-all` (PR1b-iii) and any future
    // `notifications/:id/*` route land AFTER these two.
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
