import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { getConfig } from "../config.js";

const { Client } = pg;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationDir = join(root, "migrations");

async function main() {
  const config = getConfig();
  const migrationFiles = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    for (const migrationFile of migrationFiles) {
      await client.query(await readFile(join(migrationDir, migrationFile), "utf8"));
    }
    console.log("Migrations applied");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
