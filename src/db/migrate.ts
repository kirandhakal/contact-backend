import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { getConfig } from "../config.js";

const { Client } = pg;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationDir = join(root, "migrations");

export async function migrateDatabase(databaseUrl: string) {
  const migrationFiles = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(742019631)");
    for (const migrationFile of migrationFiles) {
      await client.query(await readFile(join(migrationDir, migrationFile), "utf8"));
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  migrateDatabase(getConfig().DATABASE_URL).then(() => console.log("Migrations applied")).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
