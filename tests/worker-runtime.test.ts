import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createWorkerRuntime } from "../src/worker.js";

function fakeProcess() {
  return Object.assign(new EventEmitter(), { exit: vi.fn() });
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("worker graceful shutdown", () => {
  it.each(["SIGINT", "SIGTERM"])("handles %s and closes the pool before exiting", async (signal) => {
    const close = vi.fn(async () => undefined);
    const proc = fakeProcess();
    const runtime = createWorkerRuntime({
      store: { close },
      tick: vi.fn(async () => undefined),
      config: { WORKER_POLL_MS: 1000, WORKER_SHUTDOWN_TIMEOUT_MS: 1000 },
      logger,
      processRef: proc as never
    });
    runtime.installSignalHandlers();

    proc.emit(signal);

    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledOnce();
  });

  it("waits for the active tick before closing the pool", async () => {
    let finishTick: (() => void) | undefined;
    const tick = vi.fn(() => new Promise<void>((resolve) => { finishTick = resolve; }));
    const close = vi.fn(async () => undefined);
    const runtime = createWorkerRuntime({
      store: { close },
      tick,
      config: { WORKER_POLL_MS: 1000, WORKER_SHUTDOWN_TIMEOUT_MS: 1000 },
      logger
    });

    runtime.start();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledOnce());
    const shutdown = runtime.shutdown("test");
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    finishTick?.();
    await shutdown;
    expect(close).toHaveBeenCalledOnce();
  });

  it("respects the shutdown timeout and does not schedule more ticks", async () => {
    let finishTick: (() => void) | undefined;
    const tick = vi.fn(() => new Promise<void>((resolve) => { finishTick = resolve; }));
    const close = vi.fn(async () => undefined);
    const runtime = createWorkerRuntime({
      store: { close },
      tick,
      config: { WORKER_POLL_MS: 1000, WORKER_SHUTDOWN_TIMEOUT_MS: 20 },
      logger
    });

    runtime.start();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledOnce());
    const startedAt = Date.now();
    const first = runtime.shutdown("test");
    const second = runtime.shutdown("test");
    expect(first).toBe(second);
    await first;

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
    expect(close).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ event: "worker_shutdown_timeout" }), expect.any(String));

    const calls = tick.mock.calls.length;
    await runtime.runTick();
    expect(tick).toHaveBeenCalledTimes(calls);
    finishTick?.();
  });
});
