// Copy the generated Prisma client into dist so the built package is
// self-contained. `tsc` compiles src -> dist but excludes src/generated (the
// generator's output), leaving dist/client.js importing a ./generated/client
// path that would not exist at runtime for external consumers. This copy makes
// `@coda/db`'s dist importable by apps/api (and any future consumer).
import { cpSync, existsSync } from "node:fs";

const SRC = "src/generated";
const DEST = "dist/generated";

if (!existsSync(SRC)) {
  console.error(
    `[@coda/db] Expected generated client at ${SRC}. Run \`prisma generate\` (db:generate) first.`,
  );
  process.exit(1);
}

cpSync(SRC, DEST, { recursive: true });
