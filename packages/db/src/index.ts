export { prisma } from "./client.js";
export { resolveSingleton, type ClientContainer } from "./singleton.js";

// Re-export the generated Prisma types (models, enums, input types) so
// consumers depend only on `@coda/db`, never on the generated output path.
export * from "./generated/client/index.js";
