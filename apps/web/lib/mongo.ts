import { MongoClient, type Collection } from "mongodb";

// Singleton connection - reused across requests in the same Next.js process.
let client: MongoClient | null = null;

function uri(): string | null {
  return process.env["MONGODB_URI"]?.trim() || null;
}

export function isMongoConfigured(): boolean {
  return Boolean(uri());
}

async function getClient(): Promise<MongoClient> {
  if (!client) client = new MongoClient(uri()!);
  return client.connect();
}

/** Returns the tools collection, or null if MONGODB_URI is not set. */
export async function toolsCollection(): Promise<Collection | null> {
  if (!uri()) return null;
  const c = await getClient();
  const db = c.db(process.env["MONGODB_DATABASE"] || "mcp_forge");
  return db.collection(process.env["MONGODB_COLLECTION"] || "tools");
}
