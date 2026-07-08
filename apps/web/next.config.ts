import type { NextConfig } from "next";

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
