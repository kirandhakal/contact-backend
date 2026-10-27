import pg from "pg";

const countQuery = `select
  (select count(*) from tenants where created_at >= $1)::int as tenants,
  (select count(*) from admin_users where created_at >= $1)::int as admin_users,
  (select count(*) from pending_signups where created_at >= $1)::int as pending_signups,
  (select count(*) from auth_challenges where created_at >= $1)::int as auth_challenges,
  (select count(*) from auth_rate_limits where window_started_at >= $1)::int as auth_rate_limits`;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;
  if (!databaseUrl || !publicBaseUrl) throw new Error("DATABASE_URL and PUBLIC_BASE_URL are required.");

  const endpoint = `http://127.0.0.1:${process.env.PORT || 3100}/v1/auth/signup`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const startedAt = (await client.query("select clock_timestamp() as started_at")).rows[0].started_at;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: new URL(publicBaseUrl).origin },
      body: "{}",
      signal: AbortSignal.timeout(15000)
    });
    const payload = await response.json().catch(() => null);
    if (response.status !== 422) throw new Error(`Expected empty signup to return 422, received ${response.status}.`);
    if (!payload || payload.title !== "Invalid request" || payload.status !== 422) throw new Error("Empty signup returned an unexpected error payload.");

    const created = (await client.query(countQuery, [startedAt])).rows[0];
    const changed = Object.keys(created).filter(key => created[key] !== 0);
    if (changed.length) throw new Error(`Rejected signup created persistent records: ${changed.join(", ")}.`);
    console.log("Signup smoke test passed: empty payload rejected with 422 and no records were created.");
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`Signup smoke test failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
