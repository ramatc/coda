import { Redis } from "ioredis";
import { DEFAULT_REDIS_URL } from "./catalog-import.constants.js";

/**
 * Builds an ioredis connection for BullMQ from `REDIS_URL`.
 *
 * BullMQ REQUIRES `maxRetriesPerRequest: null` on the connection its workers use
 * (it manages blocking commands itself and throws at startup otherwise), so this
 * factory centralizes that setting for both the producer queue and the worker
 * process. `enableReadyCheck: false` keeps startup resilient to a briefly
 * unavailable Redis.
 */
export function createBullConnection(url: string | undefined): Redis {
  return new Redis(url ?? DEFAULT_REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
