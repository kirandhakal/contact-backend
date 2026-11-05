import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { getConfig } from "../config.js";

const { Client } = pg;

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationDir = join(root, "migrations");

export interface MigrationStatus {
  filename: string;
  checksum: string;
  appliedAt: string | null;
  durationMs: number | null;
  status: "applied" | "pending" | "changed";
}

async function migrationFiles(): Promise<string[]> {
  return (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

async function ensureMigrationTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    )
  `);
}

export async function migrateDatabase(databaseUrl: string) {
  const files = await migrationFiles();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(742019631)");
    await ensureMigrationTable(client);

    const applied = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations"
    );
    const appliedByName = new Map(applied.rows.map((row) => [row.filename, row.checksum]));

    for (const migrationFile of files) {
      const sql = await readFile(join(migrationDir, migrationFile), "utf8");
      const sum = checksum(sql);
      const previous = appliedByName.get(migrationFile);
      if (previous !== undefined) {
        if (previous !== sum) {
          throw new Error(
            `Migration ${migrationFile} changed after it was applied. ` +
            "Create a new migration instead of editing an applied one."
          );
        }
        continue;
      }
      const startedAt = Date.now();
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(filename, checksum, duration_ms) VALUES($1, $2, $3)",
        [migrationFile, sum, Date.now() - startedAt]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

export async function migrationStatus(databaseUrl: string): Promise<MigrationStatus[]> {
  const files = await migrationFiles();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const exists = await client.query<{ present: boolean }>(
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present"
    );
    const applied = exists.rows[0]?.present
      ? await client.query<{ filename: string; checksum: string; applied_at: Date | string; duration_ms: number }>(
          "SELECT filename, checksum, applied_at, duration_ms FROM schema_migrations"
        )
      : { rows: [] };
    const appliedByName = new Map(applied.rows.map((row) => [row.filename, row]));
    return Promise.all(files.map(async (filename) => {
      const sql = await readFile(join(migrationDir, filename), "utf8");
      const sum = checksum(sql);
      const row = appliedByName.get(filename);
      return {
        filename,
        checksum: sum,
        appliedAt: row ? new Date(row.applied_at).toISOString() : null,
        durationMs: row ? Number(row.duration_ms) : null,
        status: row ? (row.checksum === sum ? "applied" as const : "changed" as const) : "pending" as const
      };
    }));
  } finally {
    await client.end();
  }
}

function printStatusTable(rows: MigrationStatus[]) {
  const headers = ["Migration", "Status", "Applied at", "Duration"];
  const body = rows.map((row) => [
    row.filename,
    row.status,
    row.appliedAt ?? "—",
    row.durationMs === null ? "—" : `${row.durationMs} ms`
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...body.map((row) => row[index].length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  console.log(line(headers));
  console.log(line(widths.map((width) => "-".repeat(width))));
  for (const row of body) console.log(line(row));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const databaseUrl = getConfig().DATABASE_URL;
  if (process.argv.includes("--status")) {
    migrationStatus(databaseUrl).then((rows) => {
      printStatusTable(rows);
      if (rows.some((row) => row.status === "changed")) process.exitCode = 1;
    }).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  } else {
    migrateDatabase(databaseUrl).then(() => console.log("Migrations applied")).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
