import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
const deleteFile = vi.hoisted(() => vi.fn(async (_objectKey: string) => undefined));
vi.mock("../src/storage.js", () => ({ deleteFile }));
import { createWorkerTick, runWorkerSafely } from "../src/worker-loop.js";

const config = { WORKER_POLL_MS: 1000, WORKER_LEASE_SECONDS: 60, WORKER_BATCH_SIZE: 10 } as AppConfig;
const now = () => 24 * 60 * 60 * 1000 + 1;

function store() {
  return {
    deleteExpiredSubmissions: vi.fn().mockResolvedValue(0),
    deleteExpiredAuthData: vi.fn().mockResolvedValue(0),
    deleteExpiredUploads: vi.fn().mockResolvedValue([]),
    claimJobs: vi.fn().mockResolvedValue([]),
    markJobDelivered: vi.fn().mockResolvedValue(true),
    markJobFailed: vi.fn().mockResolvedValue(true),
    renewJobLease: vi.fn().mockResolvedValue(true),
    claimSiteContactJobs: vi.fn().mockResolvedValue([]),
    markSiteContactJobDelivered: vi.fn().mockResolvedValue(true),
    markSiteContactJobFailed: vi.fn().mockResolvedValue(true),
    renewSiteContactJobLease: vi.fn().mockResolvedValue(true),
    claimUploadDeletionJobs: vi.fn().mockResolvedValue([]),
    markUploadDeleted: vi.fn().mockResolvedValue(true),
    markUploadDeletionFailed: vi.fn().mockResolvedValue(true)
  };
}

beforeEach(() => {
  deleteFile.mockReset();
  deleteFile.mockResolvedValue(undefined);
});

describe("worker website auto-replies", () => {
  it("claims website jobs and records delivery failures", async () => {
    const fake = store();
    fake.claimSiteContactJobs.mockResolvedValueOnce([{
      id: "job-1", attempts: 0, leaseId: "lease-1",
      submission: { id: "message-1", tenantId: "", formId: "site-contact", formVersion: 1, payload: { name: "Alex", email: "alex@example.com", message: "Hello" }, status: "accepted", sourceIpHash: "", expiresAt: "", createdAt: "" },
      form: { id: "site-contact", name: "Website contact" },
      destination: { id: "destination-1", formId: "site-contact", kind: "email", config: { to: "alex@example.com", template: "Hi {{name}}" }, active: true }
    }]);
    const tick = createWorkerTick(fake, config, now);
    await tick();
    expect(fake.claimSiteContactJobs).toHaveBeenCalledTimes(1);
    expect(fake.markSiteContactJobFailed).toHaveBeenCalledWith("job-1", 1, expect.stringContaining("SMTP"), "lease-1");
    expect(fake.markSiteContactJobDelivered).not.toHaveBeenCalled();
  });
});

describe("worker cleanup", () => {
  it("logs cleanup failures and retries cleanup before claiming jobs", async () => {
    const fake = store(); const failure = new Error("cleanup failed");
    fake.deleteExpiredAuthData.mockRejectedValueOnce(failure);
    const tick = createWorkerTick(fake, config, now);
    const errors: unknown[] = [];

    await runWorkerSafely(tick, error => errors.push(error));
    expect(errors).toEqual([failure]);
    expect(fake.claimJobs).not.toHaveBeenCalled();

    await runWorkerSafely(tick, error => errors.push(error));
    expect(errors).toEqual([failure]);
    expect(fake.deleteExpiredAuthData).toHaveBeenCalledTimes(2);
    expect(fake.claimJobs).toHaveBeenCalledTimes(1);
  });

  it("retries failed upload cleanup on a later tick", async () => {
    const fake = store(); const failure = new Error("upload cleanup failed");
    fake.deleteExpiredUploads.mockRejectedValueOnce(failure);
    const tick = createWorkerTick(fake, config, now);

    await runWorkerSafely(tick, () => undefined);
    expect(fake.claimJobs).not.toHaveBeenCalled();
    expect(fake.claimUploadDeletionJobs).not.toHaveBeenCalled();

    await runWorkerSafely(tick, () => undefined);
    expect(fake.deleteExpiredUploads).toHaveBeenCalledTimes(2);
    expect(fake.claimJobs).toHaveBeenCalledTimes(1);
  });

  it("runs cleanup at most once per day", async () => {
    const fake = store(); let timestamp = now();
    const tick = createWorkerTick(fake, config, () => timestamp);

    await tick(); await tick();
    expect(fake.deleteExpiredAuthData).toHaveBeenCalledTimes(1);
    expect(fake.claimJobs).toHaveBeenCalledTimes(2);

    timestamp += 24 * 60 * 60 * 1000 + 1;
    await tick();
    expect(fake.deleteExpiredAuthData).toHaveBeenCalledTimes(2);
  });
});

describe("worker object deletion", () => {
  it("deletes queued objects and records success", async () => {
    const fake = store();
    fake.claimUploadDeletionJobs.mockResolvedValueOnce([{ uploadId: "upload-1", objectKey: "key-1", attempts: 0, leaseId: "lease-1" }]);
    const tick = createWorkerTick(fake, config, now);

    await tick();

    expect(deleteFile).toHaveBeenCalledOnce();
    expect(deleteFile).toHaveBeenCalledWith("key-1");
    expect(fake.markUploadDeleted).toHaveBeenCalledWith("upload-1", "lease-1");
    expect(fake.markUploadDeletionFailed).not.toHaveBeenCalled();
  });

  it("retries failed object deletion", async () => {
    const fake = store();
    deleteFile.mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValue(undefined);
    fake.claimUploadDeletionJobs
      .mockResolvedValueOnce([{ uploadId: "upload-1", objectKey: "key-1", attempts: 0, leaseId: "lease-1" }])
      .mockResolvedValueOnce([{ uploadId: "upload-1", objectKey: "key-1", attempts: 1, leaseId: "lease-2" }]);
    const tick = createWorkerTick(fake, config, now);

    await tick();
    expect(fake.markUploadDeletionFailed).toHaveBeenCalledWith("upload-1", "lease-1", 1, expect.stringContaining("storage unavailable"));

    await tick();
    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(fake.markUploadDeleted).toHaveBeenCalledWith("upload-1", "lease-2");
  });

  it("does not repeat a successful object deletion", async () => {
    const fake = store();
    fake.claimUploadDeletionJobs.mockResolvedValueOnce([{ uploadId: "upload-1", objectKey: "key-1", attempts: 0, leaseId: "lease-1" }]);
    const tick = createWorkerTick(fake, config, now);

    await tick();
    await tick();

    expect(deleteFile).toHaveBeenCalledOnce();
    expect(fake.markUploadDeleted).toHaveBeenCalledOnce();
    expect(fake.markUploadDeletionFailed).not.toHaveBeenCalled();
  });
});
