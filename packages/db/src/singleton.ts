/**
 * Container used to cache a single long-lived client instance across module
 * reloads. Kept generic and free of any Prisma import so the caching logic can
 * be unit-tested in isolation.
 */
export interface ClientContainer<T> {
  client?: T;
}

/**
 * Resolve a singleton instance, reusing a cached one when present.
 *
 * In every non-production environment the created instance is stored on the
 * provided container. This prevents dev-server hot reloads (Next.js, ts-node
 * watch, Vitest) from opening a fresh connection pool on each reload, which
 * would otherwise exhaust database connections. In production a new instance is
 * always returned and never cached on the container, so a single process owns a
 * single client for its whole lifetime.
 */
export function resolveSingleton<T>(
  container: ClientContainer<T>,
  factory: () => T,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): T {
  const instance = container.client ?? factory();

  if (nodeEnv !== "production") {
    container.client = instance;
  }

  return instance;
}
