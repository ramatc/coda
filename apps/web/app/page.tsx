import type { IsoDateTime } from "@coda/types";
import { Button } from "@coda/ui";

/**
 * Public landing page. Renders without authentication and exercises the shared
 * `@coda/ui` (Button) and `@coda/types` packages so their workspace resolution
 * is proven under a real Next build, not just typecheck.
 */
const builtAt: IsoDateTime = "2026-07-08T00:00:00.000Z";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <h1 className="text-4xl font-semibold text-brand-600">Coda</h1>
      <p className="text-lg">Track, rate, and review the music you love.</p>
      <div className="flex gap-3">
        <Button>Get started</Button>
        <Button variant="outline">Learn more</Button>
      </div>
      <p className="text-sm opacity-60" data-testid="built-at">
        Fase 0 skeleton · {builtAt}
      </p>
    </main>
  );
}
