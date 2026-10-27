import type { AppConfig } from "./config.js";
import { deliverJob } from "./delivery.js";
import type { Store } from "./types.js";

type WorkerStore = Pick<Store, "deleteExpiredSubmissions" | "deleteExpiredAuthData" | "claimJobs" | "markJobDelivered" | "markJobFailed">;

export function createWorkerTick(store: WorkerStore, config: AppConfig, now = () => Date.now()) {
  let lastCleanup = 0;
  return async function tick() {
    const timestamp = now();
    if (timestamp - lastCleanup > 24 * 60 * 60 * 1000) {
      await store.deleteExpiredSubmissions(new Date(timestamp));
      await store.deleteExpiredAuthData(new Date(timestamp));
      lastCleanup = timestamp;
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
  };
}

export async function runWorkerSafely(task: () => Promise<void>, onError: (error: unknown) => void = console.error) {
  try {
    await task();
  } catch (error) {
    onError(error);
  }
}
