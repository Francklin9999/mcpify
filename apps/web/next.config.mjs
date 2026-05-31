import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Vercel builds the Next app from apps/web, but server functions import compiled workspace packages
  // from ../../packages and ../../services. Trace from the monorepo root so those files are packaged.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // @mcp/db / @mcp/types are workspace TS packages compiled to JS in their dist - transpile is not needed,
  // but mark server-only deps external so the bundler doesn't try to client-bundle pg/bullmq.
  serverExternalPackages: ["bullmq", "postgres", "drizzle-orm"],
};
export default nextConfig;
