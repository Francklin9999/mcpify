// Cross-language enqueue seam: start the Node shim, have the REAL Go HTTPEnqueuer POST a job to it, and
// assert the job landed in BullMQ with the right shape (Go -> Node shim -> Redis/BullMQ).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startEnqueueServer } from "../../dist/src/index.js";

// IMPORTANT: use async spawn, NOT spawnSync - spawnSync blocks the event loop, so the in-process HTTP
// shim can't handle the Go subprocess's POST (deadlock). spawn keeps the loop free.
function runGo(cwd, env) {
  return new Promise((resolve) => {
    const child = spawn("go", ["run", "./cmd/enqueue-once"], { cwd, env, encoding: "utf8" });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ status: code, stderr }));
  });
}

const REDIS = { host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379) };
const PORT = 8099;
const monitorDir = fileURLToPath(new URL("../../../monitor", import.meta.url));

const { server, queue } = startEnqueueServer(PORT, REDIS);
try {
  await queue.drain();

  const res = await runGo(monitorDir, { ...process.env, ENQUEUE_URL: `http://127.0.0.1:${PORT}/enqueue` });
  if (res.status !== 0) {
    console.error("FAIL: go enqueue-once errored\n", res.stderr);
    process.exit(1);
  }

  const jobs = await queue.getJobs(["wait", "waiting", "delayed", "active"]);
  const regen = jobs.find((j) => j.data?.kind === "regenerate");
  if (!regen) {
    console.error("FAIL: no regenerate job in BullMQ after Go enqueue; saw", jobs.map((j) => j.data?.kind));
    process.exit(1);
  }
  if (regen.data.reason !== "large_drift") {
    console.error("FAIL: job shape wrong", regen.data);
    process.exit(1);
  }
  console.log("SEAM OK: Go HTTPEnqueuer -> Node shim -> BullMQ (regenerate/large_drift) validated by the contract");
} finally {
  await queue.close();
  server.close();
}
