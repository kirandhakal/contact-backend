import { migrateDatabase } from "./db/migrate.js";
import { getConfig } from "./config.js";
import { buildApp } from "./app.js";
import { PostgresStore } from "./db/postgres-store.js";

const config = getConfig();
const store = new PostgresStore(config.DATABASE_URL);
const app = buildApp(config, store);

const shutdown = async () => {
  await app.close();
  await store.close();
};

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

async function start() {
  // Do not accept signups or logins until the current schema is available.
  await migrateDatabase(config.DATABASE_URL);
  await app.listen({ host: config.HOST, port: config.PORT });
}

start().catch(async (error) => {
  app.log.error(error);
  await store.close();
  process.exitCode = 1;
});
