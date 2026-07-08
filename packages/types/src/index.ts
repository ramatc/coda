import { z } from "zod";

/**
 * Shared domain types and runtime schemas for the Coda monorepo.
 *
 * Fase 0 keeps this intentionally small: it exists to prove the shared-types
 * package builds and is consumable by the apps. Domain models grow in later
 * phases alongside the Prisma schema (`@coda/db`).
 */

/** ISO-8601 timestamp string. */
export type IsoDateTime = string;

/** Branded identifier types keep primitive IDs from being mixed up. */
export type UserId = string & { readonly __brand: "UserId" };
export type AlbumId = string & { readonly __brand: "AlbumId" };

/** Runtime-validated email, reused across API boundaries. */
export const emailSchema = z.string().email();
export type Email = z.infer<typeof emailSchema>;

/** Standard cursor pagination parameters for list endpoints. */
export const paginationParamsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
export type PaginationParams = z.infer<typeof paginationParamsSchema>;

/** Health payload shape shared between the API and its consumers. */
export const healthStatusSchema = z.object({
  status: z.literal("ok"),
  uptime: z.number().nonnegative(),
});
export type HealthStatus = z.infer<typeof healthStatusSchema>;
