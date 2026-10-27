import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { createWorkerTick, runWorkerSafely } from "../src/worker-loop.js";

const config = { WORKER_POLL_MS: 1000 } as AppConfig;
const now = () => 24 * 60 * 60 * 1000 + 1;

function store() {
  return {
    deleteExpiredSubmissions: vi.fn().mockResolvedValue(0),
    deleteExpiredAuthData: vi.fn().mockResolvedValue(0),
    claimJobs: vi.fn().mockResolvedValue([]),
    markJobDelivered: vi.fn().mockResolvedValue(undefined),
    markJobFailed: vi.fn().mockResolvedValue(undefined)
  };
}

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
