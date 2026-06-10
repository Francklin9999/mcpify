import { createDb, type Database } from "@mcp/db";
import { Queue } from "bullmq";
import { QUEUE_NAME } from "@mcp/types";
import { defaultQueueOptions } from "@mcp/generator/dist/src/job-defaults.js";

// Lazy singletons so `next build` (which evaluates route modules) doesn't require a live DB/Redis.
let _db: Database | undefined;
let _queue: Queue | undefined;

export function db(): Database {
  if (!_db) _db = createDb(process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/mcp");
  return _db;
}

export function jobQueue(): Queue {
  if (!_queue) {
    const url = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    const connection = { host: url.hostname, port: Number(url.port || 6379) };
    _queue = new Queue(QUEUE_NAME, defaultQueueOptions(connection));
  }
  return _queue;
}
