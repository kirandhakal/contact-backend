import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createWorkerTick, runWorkerSafely } from "../src/worker-loop.js";

const config = { WORKER_POLL_MS: 1000 } as AppConfig;
const now = () => 24 * 60 * 60 * 1000 + 1;

function store() {
  return {
    deleteExpiredSubmissions: vi.fn().mockResolvedValue(0),
    deleteExpiredAuthData: vi.fn().mockResolvedValue(0),
    deleteExpiredUploads: vi.fn().mockResolvedValue([]),
    claimJobs: vi.fn().mockResolvedValue([]),
    markJobDelivered: vi.fn().mockResolvedValue(undefined),
    markJobFailed: vi.fn().mockResolvedValue(undefined),
    claimSiteContactJobs: vi.fn().mockResolvedValue([]),
    markSiteContactJobDelivered: vi.fn().mockResolvedValue(undefined),
    markSiteContactJobFailed: vi.fn().mockResolvedValue(undefined)
  };
}

describe("worker website auto-replies", () => {
  it("claims website jobs and records delivery failures", async () => {
    const fake = store();
    fake.claimSiteContactJobs.mockResolvedValueOnce([{
      id: "job-1", attempts: 0,
      submission: { id: "message-1", tenantId: "", formId: "site-contact", formVersion: 1, payload: { name: "Alex", email: "alex@example.com", message: "Hello" }, status: "accepted", sourceIpHash: "", expiresAt: "", createdAt: "" },
      form: { id: "site-contact", name: "Website contact" },
      destination: { id: "destination-1", formId: "site-contact", kind: "email", config: { to: "alex@example.com", template: "Hi {{name}}" }, active: true }
    }]);
    const tick = createWorkerTick(fake, config, now);
    await tick();
    expect(fake.claimSiteContactJobs).toHaveBeenCalledTimes(1);
    expect(fake.markSiteContactJobFailed).toHaveBeenCalledWith("job-1", 1, expect.stringContaining("SMTP"));
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
