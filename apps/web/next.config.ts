import type { NextConfig } from "next";
import { config } from "dotenv";

// Next.js only auto-loads .env files from this package's own directory, but
// the repo keeps a single shared .env at the monorepo root (same one the API
// reads via ConfigModule's envFilePath). Load it explicitly so NEXT_PUBLIC_*
// vars (e.g. the Clerk publishable key) get inlined instead of falling back
// to Clerk's keyless dev mode.
config({ path: "../../.env" });

/**
 * Next.js configuration for the Coda web app (Fase 0 skeleton).
 *
 * Transpile the internal workspace packages so their source/dist resolve
 * cleanly under Next's server and client bundlers.
 */
const nextConfig: NextConfig = {
  transpilePackages: ["@coda/ui", "@coda/types"],
};

export default nextConfig;
