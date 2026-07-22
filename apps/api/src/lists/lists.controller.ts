import { Controller } from "@nestjs/common";
import { ListsService } from "./lists.service.js";

/**
 * Curated-list endpoints (Fase 2 slice 2), all behind the global `ClerkGuard`.
 * `@CurrentUser("sub")` yields the verified Clerk user id, which the service
 * maps to the local `User.id`. Routes are wired in a follow-up task; the domain
 * logic lives entirely in {@link ListsService}.
 */
@Controller()
export class ListsController {
  constructor(private readonly lists: ListsService) {}
}
