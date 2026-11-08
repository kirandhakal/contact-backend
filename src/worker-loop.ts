import type { AppConfig } from "./config.js";
import { deliverJob } from "./delivery.js";
import { deleteFile } from "./storage.js";
import type { OutboxJob, Store, UploadDeletionJob } from "./types.js";

type WorkerLogger = Pick<Console, "error" | "info" | "warn">;

type WorkerStore = Pick<Store,
  | "deleteExpiredSubmissions"
  | "deleteExpiredAuthData"
  | "deleteExpiredUploads"
  | "claimJobs"
  | "markJobDelivered"
  | "markJobFailed"
  | "renewJobLease"
  | "claimSiteContactJobs"
  | "markSiteContactJobDelivered"
  | "markSiteContactJobFailed"
  | "renewSiteContactJobLease"
  | "claimUploadDeletionJobs"
  | "markUploadDeleted"
  | "markUploadDeletionFailed"
>;

interface JobHandlers {
  markDelivered: (id: string, leaseId: string) => Promise<boolean>;
  markFailed: (id: string, attempts: number, error: string, leaseId: string) => Promise<boolean>;
  renewLease: (id: string, leaseId: string, leaseSeconds: number) => Promise<boolean>;
}

export interface WorkerTickOptions {
  workerId?: string;
  leaseSeconds?: number;
  batchSize?: number;
  logger?: WorkerLogger;
  removeObject?: (objectKey: string) => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_CLEANUP_MS = 10 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkerTick(store: WorkerStore, config: AppConfig, now = () => Date.now(), options: WorkerTickOptions = {}) {
  let lastCleanup = 0;
  let lastUploadCleanup = 0;
  const logger = options.logger ?? console;
  const workerId = options.workerId || config.WORKER_ID || `worker-${process.pid}`;
  const leaseSeconds = options.leaseSeconds ?? config.WORKER_LEASE_SECONDS ?? 60;
  const batchSize = options.batchSize ?? config.WORKER_BATCH_SIZE ?? 10;
  const removeObject = options.removeObject ?? deleteFile;

  function startLeaseRenewal(id: string, leaseId: string, renewLease: JobHandlers["renewLease"]) {
    const interval = setInterval(() => {
      void renewLease(id, leaseId, leaseSeconds).then((owned) => {
        if (!owned) logger.warn({ event: "worker_lease_lost", jobId: id }, "Job lease is no longer owned");
      }).catch((error) => {
        logger.error({ event: "worker_lease_renewal_failed", jobId: id, reason: errorMessage(error).slice(0, 200) }, "Job lease renewal failed");
      });
    }, Math.max(1000, Math.floor(leaseSeconds * 1000 / 3)));
    interval.unref?.();
    return () => clearInterval(interval);
  }

  async function deliver(jobs: OutboxJob[], handlers: JobHandlers) {
    for (const job of jobs) {
      if (!job.leaseId) {
        logger.warn({ event: "worker_missing_lease", jobId: job.id }, "Skipping claimed job without a lease");
        continue;
      }
      const leaseId = job.leaseId;
      const attempts = job.attempts + 1;
      const stopRenewal = startLeaseRenewal(job.id, leaseId, handlers.renewLease);
      try {
        await deliverJob(job, config);
      } catch (error) {
        stopRenewal();
        const message = errorMessage(error);
        const owned = await handlers.markFailed(job.id, attempts, message, leaseId);
        if (!owned) logger.warn({ event: "worker_stale_failure", jobId: job.id }, "Failure result ignored because the job lease changed");
        continue;
      }
      stopRenewal();
      const owned = await handlers.markDelivered(job.id, leaseId);
      if (!owned) logger.warn({ event: "worker_stale_ack", jobId: job.id }, "Delivery result ignored because the job lease changed");
    }
  }

  async function deleteObjects() {
    const jobs: UploadDeletionJob[] = await store.claimUploadDeletionJobs(batchSize, workerId, leaseSeconds);
    for (const job of jobs) {
      const attempts = job.attempts + 1;
      try {
        await removeObject(job.objectKey);
        const owned = await store.markUploadDeleted(job.uploadId, job.leaseId);
        if (!owned) logger.warn({ event: "upload_deletion_stale_ack", uploadId: job.uploadId }, "Object deletion result ignored because the lease changed");
      } catch (error) {
        const message = errorMessage(error);
        logger.error({
          event: "upload_deletion_failed",
          uploadId: job.uploadId,
          attempts,
          reason: message.slice(0, 200)
        }, "Object deletion failed; it will be retried");
        const owned = await store.markUploadDeletionFailed(job.uploadId, job.leaseId, attempts, message);
        if (!owned) logger.warn({ event: "upload_deletion_stale_failure", uploadId: job.uploadId }, "Object deletion failure ignored because the lease changed");
      }
    }
  }

  return async function tick() {
    const timestamp = now();
    if (timestamp - lastCleanup > DAY_MS) {
      await store.deleteExpiredSubmissions(new Date(timestamp));
      await store.deleteExpiredAuthData(new Date(timestamp));
      lastCleanup = timestamp;
    }

    if (timestamp - lastUploadCleanup > UPLOAD_CLEANUP_MS) {
      await store.deleteExpiredUploads(new Date(timestamp));
      lastUploadCleanup = timestamp;
    }

    await deleteObjects();

    await deliver(await store.claimJobs(batchSize, workerId, leaseSeconds), {
      markDelivered: store.markJobDelivered.bind(store),
      markFailed: store.markJobFailed.bind(store),
      renewLease: store.renewJobLease.bind(store)
    });
    await deliver(await store.claimSiteContactJobs(batchSize, workerId, leaseSeconds), {
      markDelivered: store.markSiteContactJobDelivered.bind(store),
      markFailed: store.markSiteContactJobFailed.bind(store),
      renewLease: store.renewSiteContactJobLease.bind(store)
    });
  };
}

export async function runWorkerSafely(task: () => Promise<void>, onError: (error: unknown) => void = console.error) {
  try {
    await task();
  } catch (error) {
    onError(error);
  }
}
