import type { AppConfig } from "./config.js";
import { deliverJob } from "./delivery.js";
import { deleteFile } from "./storage.js";
import type { OutboxJob, Store } from "./types.js";

type WorkerStore = Pick<Store, "deleteExpiredSubmissions" | "deleteExpiredAuthData" | "deleteExpiredUploads" | "claimJobs" | "markJobDelivered" | "markJobFailed" | "claimSiteContactJobs" | "markSiteContactJobDelivered" | "markSiteContactJobFailed">;

export function createWorkerTick(store: WorkerStore, config: AppConfig, now = () => Date.now()) {
  let lastCleanup = 0;
  let lastUploadCleanup = 0;

  async function deliver(jobs: OutboxJob[], markDelivered: (id: string) => Promise<void>, markFailed: (id: string, attempts: number, error: string) => Promise<void>) {
    for (const job of jobs) {
      const attempts = job.attempts + 1;
      try {
        await deliverJob(job, config);
        await markDelivered(job.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markFailed(job.id, attempts, message);
      }
    }
  }

  return async function tick() {
    const timestamp = now();
    if (timestamp - lastCleanup > 24 * 60 * 60 * 1000) {
      await store.deleteExpiredSubmissions(new Date(timestamp));
      await store.deleteExpiredAuthData(new Date(timestamp));
      lastCleanup = timestamp;
    }

    if (timestamp - lastUploadCleanup > 10 * 60 * 1000) {
      const expired = await store.deleteExpiredUploads(new Date(timestamp));
      await Promise.all(expired.map(upload => deleteFile(upload.objectKey).catch(() => undefined)));
      lastUploadCleanup = timestamp;
    }

    await deliver(await store.claimJobs(10), store.markJobDelivered.bind(store), store.markJobFailed.bind(store));
    await deliver(await store.claimSiteContactJobs(10), store.markSiteContactJobDelivered.bind(store), store.markSiteContactJobFailed.bind(store));
  };
}

export async function runWorkerSafely(task: () => Promise<void>, onError: (error: unknown) => void = console.error) {
  try {
    await task();
  } catch (error) {
    onError(error);
  }
}
