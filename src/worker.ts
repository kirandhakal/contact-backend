import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getConfig } from "./config.js";
import { PostgresStore } from "./db/postgres-store.js";
import { createWorkerTick, runWorkerSafely } from "./worker-loop.js";

type WorkerLogger = Pick<Console, "error" | "info" | "warn">;
type SignalProcess = Pick<NodeJS.Process, "on" | "once" | "off"> & { exit?: (code?: number) => void };

export interface WorkerRuntimeOptions {
  store: { close(): Promise<void> };
  tick: () => Promise<void>;
  config: { WORKER_POLL_MS: number; WORKER_SHUTDOWN_TIMEOUT_MS?: number };
  logger?: WorkerLogger;
  processRef?: SignalProcess;
}

export interface WorkerRuntime {
  start(): void;
  runTick(): Promise<void>;
  shutdown(signal?: string): Promise<void>;
  handleSignal(signal: string): Promise<void>;
  installSignalHandlers(): () => void;
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const { store, tick, config } = options;
  const logger = options.logger ?? console;
  const processRef = options.processRef ?? process;
  let interval: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  let exited = false;

  function runTick(): Promise<void> {
    if (stopping) return Promise.resolve();
    if (active) return active;
    const current = (async () => {
      try {
        await runWorkerSafely(tick, (error) => logger.error(error));
      } finally {
        active = undefined;
      }
    })();
    active = current;
    return current;
  }

  function start() {
    if (interval || stopping) return;
    interval = setInterval(() => { void runTick(); }, config.WORKER_POLL_MS);
    void runTick();
  }

  function shutdown(signal = "shutdown"): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      stopping = true;
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      const activeTick = active;
      if (activeTick) {
        const timeoutMs = config.WORKER_SHUTDOWN_TIMEOUT_MS ?? 30000;
        let timeout: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([
          activeTick.then(() => false, () => false),
          new Promise<boolean>((resolveTimeout) => {
            timeout = setTimeout(() => resolveTimeout(true), timeoutMs);
          })
        ]);
        if (timeout) clearTimeout(timeout);
        if (timedOut) {
          logger.error({ event: "worker_shutdown_timeout", signal, timeoutMs }, "Worker shutdown timed out; closing the pool and leaving expired leases for recovery");
        }
      }
      try {
        await store.close();
      } catch (error) {
        logger.error({ event: "worker_close_failed", signal, reason: error instanceof Error ? error.message.slice(0, 200) : String(error) }, "Failed to close the PostgreSQL pool");
      }
      logger.info({ event: "worker_stopped", signal }, "Worker stopped");
    })();
    return shutdownPromise;
  }

  async function handleSignal(signal: string): Promise<void> {
    await shutdown(signal);
    if (!exited) {
      exited = true;
      processRef.exit?.(0);
    }
  }

  function installSignalHandlers(): () => void {
    const handlers = new Map<string, () => void>();
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => { void handleSignal(signal); };
      processRef.once(signal, handler);
      handlers.set(signal, handler);
    }
    return () => {
      for (const [signal, handler] of handlers) processRef.off(signal, handler);
    };
  }

  return { start, runTick, shutdown, handleSignal, installSignalHandlers };
}

export function createWorkerId(config: { WORKER_ID?: string }): string {
  return config.WORKER_ID || `${hostname()}:${process.pid}:${randomUUID()}`;
}

function main() {
  const config = getConfig();
  const store = new PostgresStore(config.DATABASE_URL, config.DATA_ENCRYPTION_KEY);
  const workerId = createWorkerId(config);
  const tick = createWorkerTick(store, config, undefined, { workerId });
  const runtime = createWorkerRuntime({ store, tick, config });
  const removeHandlers = runtime.installSignalHandlers();
  process.once("exit", removeHandlers);
  runtime.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
