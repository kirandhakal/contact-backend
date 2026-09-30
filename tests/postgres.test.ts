import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { getConfig } from "../src/config.js";
import { migrateDatabase } from "../src/db/migrate.js";
import { PostgresStore } from "../src/db/postgres-store.js";
import { hashPassword, hashSessionToken } from "../src/admin-auth.js";
import type { ListQuery } from "../src/management.js";

// Explicit opt-in only: point TEST_DATABASE_URL at a disposable PostgreSQL database.
describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL management integration", () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  let pool: pg.Pool; let store: PostgresStore; let tenantId: string; let key: string;
  const query: ListQuery = { page: 1, limit: 1, q: "", sort: "most-used" };
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const setup = new pg.Client({ connectionString: url.toString() }); await setup.connect();
    await setup.query(`create schema ${schema}`); await setup.end();
    url.searchParams.set("options", `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: url.toString() }); store = new PostgresStore(url.toString());
    for (let pass = 0; pass < 2; pass++) for (const file of (await readdir(new URL("../migrations/", import.meta.url))).filter(f => f.endsWith(".sql")).sort()) await pool.query(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    tenantId = (await store.createSiteAccount("SQL studio", `${schema}@example.com`, await hashPassword("original-password"))).tenantId;
    key = `cf_${randomUUID()}`;
    const form = await store.createForm({ tenantName: "SQL studio", tenantId, name: "Popular form", allowedOrigins: ["https://example.com"], schema: { type: "object" } }, key);
    await store.createForm({ tenantName: "SQL studio", tenantId, name: "Empty form", allowedOrigins: ["https://example.com"], schema: { type: "object" } }, `cf_${randomUUID()}`);
    for (const status of ["accepted", "spam", "deleted"] as const) await store.createSubmission({ form, payload: { message: status }, status, sourceIpHash: "test", accessTokenHash: "test", expiresAt: new Date(Date.now() + 86400000) });
  });
  afterAll(async () => {
    await store?.close(); if (pool) { await pool.query(`drop schema ${schema} cascade`); await pool.end(); }
  });
  it("reproduces login failure without the lockout migration and repairs signup/login by migrating", async () => {
    const config = getConfig({ NODE_ENV: "test", DATABASE_URL: pool.options.connectionString!,
      ADMIN_API_KEY: "test-admin-key-at-least-24-characters", DATA_ENCRYPTION_KEY: "a".repeat(64), PUBLIC_BASE_URL: "http://localhost:3100" });
    const app = buildApp(config, store);
    const headers = { origin: config.PUBLIC_BASE_URL };
    const email = `${randomUUID()}@example.com`;
    const credentials = { email, password: "signup-test-password", portal: "tenant" };
    try {
      await pool.query("DROP TABLE login_lockouts");
      const signup = await app.inject({ method: "POST", url: "/v1/auth/signup", headers, payload: { workspaceName: "Café & Company", email, password: credentials.password } });
      expect(signup.statusCode).toBe(202);
      expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers, payload: credentials })).statusCode).toBe(500);
      await migrateDatabase(pool.options.connectionString!);
      const login = await app.inject({ method: "POST", url: "/v1/admin/login", headers, payload: credentials });
      expect(login.statusCode).toBe(200);
      const me = await app.inject({ url: "/v1/admin/me", headers: { cookie: login.headers["set-cookie"] as string } });
      expect(me.json()).toMatchObject({ email, role: "tenant" });
      const { rows } = await pool.query("SELECT name FROM tenants WHERE id=$1", [me.json().tenantId]);
      expect(rows[0].name).toBe("cafe-and-company");
      // Keep this account out of the management aggregate fixtures below.
      await pool.query("DELETE FROM tenants WHERE id=$1", [me.json().tenantId]);
    } finally { await app.close(); }
  });
  it("handles concurrent successful logins without losing the locking row", async () => {
    const { checkLogin } = await import("../src/login-lockout.js");
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.withLoginState(key, state => checkLogin(state, async () => true))));
    expect(results.every(result => result.allowed)).toBe(true);
  });
  it("serializes concurrent login failures and persists across store instances", async () => {
    const { checkLogin } = await import("../src/login-lockout.js");
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => store.withLoginState(key, state => checkLogin(state, async () => false))));
    expect(results.filter(result => result.retryAfterSeconds === 60)).toHaveLength(1);
    const second = new PostgresStore(pool.options.connectionString!);
    try {
      const result = await second.withLoginState(key, state => checkLogin(state, async () => true));
      expect(result.allowed).toBe(false);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    } finally { await second.close(); }
  });
  it("paginates SQL aggregates and preserves totals on out-of-range pages", async () => {
    const page = await store.managementPage("forms", { ...query, tenantId });
    expect(page.pagination.total).toBe(2); expect(page.items[0]).toMatchObject({ publicKey: key, submissionCount: 2, acceptedCount: 1, spamCount: 1 });
    const beyond = await store.managementPage("forms", { ...query, tenantId, page: 9 });
    expect(beyond.items).toEqual([]); expect(beyond.pagination.total).toBe(2);
    const injection = await store.managementPage("forms", { ...query, q: "' OR 1=1 --" }); expect(injection.items).toEqual([]);
  });
  it("filters submissions and exposes scoped tenant activity and analytics", async () => {
    const messages = await store.managementPage("submissions", { ...query, tenantId, status: "spam", q: "spam" }, key);
    expect(messages.pagination.total).toBe(1); expect(messages.items[0].status).toBe("spam");
    const future = await store.managementPage("submissions", { ...query, from: "2100-01-01T00:00:00Z" }, key); expect(future.items).toEqual([]);
    const tenants = await store.managementPage("tenants", { ...query, tenantId, status: "active" }); expect(tenants.items[0]).toMatchObject({ activeFormCount: 2, totalSubmissions: 2 });
    const stats = await store.analytics(tenantId); expect(stats).toMatchObject({ forms: 2, submissions: 2, accepted: 1, spam: 1, activeTenants: 1 });
    expect((stats.mostUsedForms as { publicKey: string }[])[0].publicKey).toBe(key);
    expect((await store.analytics(randomUUID())).submissions).toBe(0);
  });
  it("atomically revokes all sessions when a password changes", async () => {
    const account = await store.getAdminByEmail(`${schema}@example.com`);
    const token = hashSessionToken(randomUUID()); await store.createAdminSession(account!.id, token, new Date(Date.now() + 60000));
    expect(await store.getAdminBySession(token)).not.toBeNull();
    await store.updateAdminPassword(account!.id, await hashPassword("replacement-password"));
    expect(await store.getAdminBySession(token)).toBeNull();
  });
});
