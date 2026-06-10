import type { JobsOptions, QueueOptions } from "bullmq";

function envInt(key: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const value = process.env[key]?.trim();
  if (!value) return fallback;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

export function queueJobDefaults(): JobsOptions {
  return {
    attempts: envInt("BULLMQ_JOB_ATTEMPTS", 1, 1, 5),
    removeOnComplete: {
      age: envInt("BULLMQ_COMPLETED_JOB_TTL_SECONDS", 24 * 60 * 60, 60),
      count: envInt("BULLMQ_COMPLETED_JOB_MAX_COUNT", 1000, 1),
    },
    removeOnFail: {
      age: envInt("BULLMQ_FAILED_JOB_TTL_SECONDS", 7 * 24 * 60 * 60, 60),
      count: envInt("BULLMQ_FAILED_JOB_MAX_COUNT", 1000, 1),
    },
    keepLogs: envInt("BULLMQ_JOB_LOG_MAX", 20, 0),
    stackTraceLimit: envInt("BULLMQ_JOB_STACKTRACE_MAX", 5, 0),
    sizeLimit: envInt("BULLMQ_JOB_DATA_MAX_BYTES", 750_000, 10_000),
  };
}

export function defaultQueueOptions(connection: QueueOptions["connection"]): QueueOptions {
  return {
    connection,
    defaultJobOptions: queueJobDefaults(),
    streams: { events: { maxLen: envInt("BULLMQ_EVENTS_MAX_LEN", 10_000, 100) } },
  };
}

export function generatorWorkerConcurrency(): number {
  const fallback = process.env.NODE_ENV === "production" ? 2 : 4;
  return envInt("GENERATOR_WORKER_CONCURRENCY", fallback, 1, 32);
}
