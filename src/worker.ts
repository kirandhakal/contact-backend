import { getConfig } from "./config.js";
import { deliverJob } from "./delivery.js";
import { PostgresStore } from "./db/postgres-store.js";

const config = getConfig();
const store = new PostgresStore(config.DATABASE_URL, config.DATA_ENCRYPTION_KEY);
let lastCleanup = 0;

async function tick() {
  const now = Date.now();
  if (now - lastCleanup > 24 * 60 * 60 * 1000) {
    await store.deleteExpiredSubmissions(new Date());
    lastCleanup = now;
  }

  const jobs = await store.claimJobs(10);
  for (const job of jobs) {
    const attempts = job.attempts + 1;
    try {
      await deliverJob(job, config);
      await store.markJobDelivered(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.markJobFailed(job.id, attempts, message);
    }
  }
}

let running = false;
async function runTick() {
  if (running) return;
  running = true;
  try { await tick(); }
  catch (error) { console.error(error); }
  finally { running = false; }
}
const interval = setInterval(() => { void runTick(); }, config.WORKER_POLL_MS);

process.on("SIGINT", async () => {
  clearInterval(interval);
  await store.close();
  process.exit(0);
});

void runTick();
