import { Redis } from "ioredis";
import { DEFAULT_REDIS_URL } from "./catalog-import.constants.js";

/**
 * Bounded-retry connection count for a BullMQ Queue/producer (see
 * {@link createBullProducerConnection}). Finite so a Redis outage during
 * `queue.add()`/`addBulk()` fails the request instead of hanging it forever.
 */
const PRODUCER_MAX_RETRIES_PER_REQUEST = 5;

/**
 * Builds an ioredis connection for BullMQ from `REDIS_URL`.
 *
 * BullMQ REQUIRES `maxRetriesPerRequest: null` on the connection its Workers use
 * (it manages blocking commands itself and throws at startup otherwise), so
 * `createBullConnection` defaults to that. A Queue/producer connection is a
 * DIFFERENT case (judgment-day issue #6): `catalog-queue.ts`'s `CatalogQueue` is
 * reachable synchronously from the admin HTTP request path (`queue.add()`/
 * `addBulk()`), so it must NOT inherit the Worker-only unbounded-retry setting
 * — combined with ioredis's default indefinite reconnect strategy, `null` there
 * would let a Redis outage hang the admin request forever. `enableReadyCheck:
 * false` keeps startup resilient to a briefly unavailable Redis either way.
 */
export function createBullConnection(
  url: string | undefined,
  maxRetriesPerRequest: number | null = null,
): Redis {
  return new Redis(url ?? DEFAULT_REDIS_URL, {
    maxRetriesPerRequest,
    enableReadyCheck: false,
  });
}

/**
 * Bounded-retry connection for a BullMQ Queue/producer (judgment-day issue #6)
 * — use this instead of {@link createBullConnection}'s default for any
 * connection reachable synchronously from an HTTP request path.
 */
export function createBullProducerConnection(url: string | undefined): Redis {
  return createBullConnection(url, PRODUCER_MAX_RETRIES_PER_REQUEST);
}
