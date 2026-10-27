import { getConfig } from "./config.js";
import { PostgresStore } from "./db/postgres-store.js";
import { createWorkerTick, runWorkerSafely } from "./worker-loop.js";

const config = getConfig();
const store = new PostgresStore(config.DATABASE_URL, config.DATA_ENCRYPTION_KEY);
const tick = createWorkerTick(store, config);

let running = false;
async function runTick() {
  if (running) return;
  running = true;
  try { await runWorkerSafely(tick); }
  finally { running = false; }
}
const interval = setInterval(() => { void runTick(); }, config.WORKER_POLL_MS);

process.on("SIGINT", async () => {
  clearInterval(interval);
  await store.close();
  process.exit(0);
});

void runTick();
