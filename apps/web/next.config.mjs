/** @type {import('next').NextConfig} */
const nextConfig = {
  // @mcp/db / @mcp/types are workspace TS packages compiled to JS in their dist — transpile is not needed,
  // but mark server-only deps external so the bundler doesn't try to client-bundle pg/bullmq.
  serverExternalPackages: ["bullmq", "postgres", "drizzle-orm"],
};
export default nextConfig;
