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
    url.searchParams.set("options", `-c search_path=${schema}`);
    pool = new pg.Pool({ connectionString: url.toString() }); store = new PostgresStore(url.toString(), "b".repeat(64));
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
  it("stores website messages separately and deduplicates concurrent retries", async () => {
    const input = { name: "Website visitor", email: "visitor@example.com", message: "Help with the service please." };
    const requestId = randomUUID();
    await Promise.all(Array.from({ length: 5 }, () => store.saveSiteContact(input, requestId)));
    const result = await store.listSiteContacts(1, 20);
    expect(result.total).toBe(1); expect(result.messages[0]).toMatchObject(input);
    expect((await store.listSiteContacts(2, 20)).messages).toEqual([]);
    expect(await store.deleteSiteContact(result.messages[0].id)).toBe(true);
    expect((await store.listSiteContacts(1, 20)).total).toBe(0);
  });
  it("reproduces login failure without the lockout migration and repairs signup/login by migrating", async () => {
    const config = getConfig({ NODE_ENV: "test", DATABASE_URL: pool.options.connectionString!,
      ADMIN_API_KEY: "test-admin-key-at-least-24-characters", DATA_ENCRYPTION_KEY: "a".repeat(64), PUBLIC_BASE_URL: "http://localhost:3100" });
    const messages: import("../src/auth-email.js").AuthEmailMessage[] = [];
    const app = buildApp(config, store, { sendAuthEmail: async (message) => { messages.push(message); } });
    const headers = { origin: config.PUBLIC_BASE_URL };
    const email = `${randomUUID()}@example.com`;
    const credentials = { email, password: "signup-test-password", portal: "tenant" };
    try {
      await pool.query(`DROP TABLE ${schema}.login_lockouts`);
      const signup = await app.inject({ method: "POST", url: "/v1/auth/signup", headers, payload: { workspaceName: "Café & Company", email, password: credentials.password } });
      expect(signup.statusCode).toBe(202);
      const code = messages.find(message => message.to === email && message.kind === "signup_code");
      if (!code || !("code" in code)) throw new Error("Signup code was not created");
      const verify = await app.inject({ method: "POST", url: "/v1/auth/signup/verify", headers, payload: { challengeId: signup.json().challengeId, code: code.code } });
      expect(verify.statusCode).toBe(200);
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
  it("cleans expired authentication records without deleting active or recent records", async () => {
    const now = new Date("2020-01-01T00:00:00Z");
    const ago = (milliseconds: number) => new Date(now.getTime() - milliseconds);
    const ahead = (milliseconds: number) => new Date(now.getTime() + milliseconds);
    const expiredChallenge = randomUUID(); const oldConsumedChallenge = randomUUID();
    const recentExpiredChallenge = randomUUID(); const activeChallenge = randomUUID(); const resetChallenge = randomUUID();
    const expiredSignup = randomUUID(); const activeSignup = randomUUID();
    const expiredLimit = `expired:${randomUUID()}`; const activeLimit = `active:${randomUUID()}`;
    try {
      for (const [id, email, expiresAt, consumedAt] of [
        [expiredChallenge, `${expiredChallenge}@example.com`, ago(2 * 86400000), null],
        [oldConsumedChallenge, `${oldConsumedChallenge}@example.com`, ahead(86400000), ago(2 * 86400000)],
        [recentExpiredChallenge, `${recentExpiredChallenge}@example.com`, ago(3600000), null],
        [activeChallenge, `${activeChallenge}@example.com`, ahead(86400000), null]
      ] as const) {
        await pool.query(`INSERT INTO auth_challenges (id,purpose,email,otp_hash,expires_at,resend_available_at,consumed_at)
          VALUES ($1,'signup',$2,'hash',$3,$4,$5)`, [id, email, expiresAt, ago(60000), consumedAt]);
      }
      await pool.query(`INSERT INTO auth_challenges (id,purpose,email,otp_hash,expires_at,resend_available_at,consumed_at,reset_token_hash,reset_token_expires_at)
        VALUES ($1,'password_reset',$2,'hash',$3,$4,$5,$6,$7)`, [resetChallenge, `${resetChallenge}@example.com`,
        ago(1200000), ago(60000), ago(1800000), `reset-${resetChallenge}`, ahead(300000)]);
      await pool.query(`INSERT INTO pending_signups (id,email,workspace_name,password_hash,expires_at) VALUES ($1,$2,'Expired','hash',$3),($4,$5,'Active','hash',$6)`,
        [expiredSignup, `${expiredSignup}@example.com`, ago(1000), activeSignup, `${activeSignup}@example.com`, ahead(3600000)]);
      await pool.query(`INSERT INTO auth_rate_limits (key,window_started_at,count,expires_at) VALUES ($1,$2,1,$3),($4,$2,1,$5)`,
        [expiredLimit, ago(3600000), ago(1000), activeLimit, ahead(3600000)]);

      expect(await store.deleteExpiredAuthData(now)).toBe(4);
      expect(await store.deleteExpiredAuthData(now)).toBe(0);

      const { rows: challengeRows } = await pool.query("SELECT id FROM auth_challenges WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[expiredChallenge, oldConsumedChallenge, recentExpiredChallenge, activeChallenge, resetChallenge]]);
      expect(challengeRows.map(row => row.id).sort()).toEqual([recentExpiredChallenge, activeChallenge, resetChallenge].sort());
      expect((await pool.query("SELECT id FROM pending_signups WHERE id = ANY($1::uuid[])", [[expiredSignup, activeSignup]])).rows.map(row => row.id)).toEqual([activeSignup]);
      expect((await pool.query("SELECT key FROM auth_rate_limits WHERE key = ANY($1::text[])", [[expiredLimit, activeLimit]])).rows.map(row => row.key)).toEqual([activeLimit]);
    } finally {
      await pool.query("DELETE FROM auth_challenges WHERE id = ANY($1::uuid[])", [[expiredChallenge, oldConsumedChallenge, recentExpiredChallenge, activeChallenge, resetChallenge]]);
      await pool.query("DELETE FROM pending_signups WHERE id = ANY($1::uuid[])", [[expiredSignup, activeSignup]]);
      await pool.query("DELETE FROM auth_rate_limits WHERE key = ANY($1::text[])", [[expiredLimit, activeLimit]]);
    }
  });

  it("handles concurrent successful logins without losing the locking row", async () => {
    const { checkLogin } = await import("../src/login-lockout.js");
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.withLoginState(key, state => checkLogin(state, async () => true))));
    expect(results.every(result => result.allowed)).toBe(true);
  });
  it("encrypts integration credentials, decrypts worker jobs, and atomically replaces destinations", async () => {
    const tenant = await store.createTenant("Integration tests");
    const publicKey = `frm_${randomUUID()}`;
    try {
      const form = await store.createForm({ tenantName: "Integration tests", tenantId: tenant, name: "Notifications", allowedOrigins: ["https://example.com"], schema: { type: "object" },
        destinations: [{ kind: "discord", config: { template: "New {{form.name}}" }, secret: "https://discord.com/api/webhooks/123/private-token" }] }, publicKey);
      const raw = await pool.query("SELECT config,secret FROM destinations WHERE form_id=$1", [form.id]);
      expect(JSON.stringify(raw.rows)).not.toContain("private-token");
      expect(raw.rows[0].secret).toBeNull();
      expect((await store.getFormDestinations(publicKey))[0].secret).toContain("private-token");
      await store.createSubmission({ form, payload: {}, status: "accepted", sourceIpHash: "test", accessTokenHash: "token", expiresAt: new Date(Date.now() + 60000) });
      await store.updateForm(publicKey, { destinations: [] });
      expect(await store.getFormDestinations(publicKey)).toEqual([]);
      const jobs = await store.claimJobs(10);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].destination.secret).toContain("private-token");
      await store.markJobDelivered(jobs[0].id);
      await store.createSubmission({ form, payload: {}, status: "accepted", sourceIpHash: "test", accessTokenHash: "token2", expiresAt: new Date(Date.now() + 60000) });
      expect(await store.claimJobs(10)).toEqual([]);
    } finally { await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]); }
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
  it("queues automatic rules only, supports manual bulk replies, rejects foreign submissions, and deduplicates retries", async () => {
    const tenant = await store.createTenant("Reply tests");
    const publicKey = `frm_${randomUUID()}`;
    try {
      const form = await store.createForm({ tenantName: "Reply tests", tenantId: tenant, name: "Replies", allowedOrigins: ["https://example.com"], schema: { type: "object" }, destinations: [
        { kind: "email", config: { recipientField: "email", deliveryMode: "manual", template: "Manual" } },
        { kind: "discord", config: { deliveryMode: "automatic", template: "New submission" }, secret: "https://discord.com/api/webhooks/123/test-token" }
      ] }, publicKey);
      const result = await store.createSubmission({ form, payload: { name: "Alex Morgan", email: "alex@example.com" }, status: "accepted", sourceIpHash: "test", accessTokenHash: "test", expiresAt: new Date(Date.now() + 60000) });
      const initial = await store.deliveryStatus(publicKey, result.submission.id);
      expect(initial).toHaveLength(1); expect(initial[0].kind).toBe("discord");
      const destinations = await store.getFormDestinations(publicKey);
      const ids = destinations.map(d => d.id);
      await expect(store.queueReplies(publicKey, [randomUUID()], ids, "Hello", randomUUID())).rejects.toThrow(/accepted/);
      await expect(store.queueReplies(publicKey, [result.submission.id], [randomUUID()], "Hello", randomUUID())).rejects.toThrow(/integrations/);
      const requestId = randomUUID();
      expect(await Promise.all([1, 2].map(() => store.queueReplies(publicKey, [result.submission.id], ids, "Hello {{name}}", requestId)))).toEqual([2, 2]);
      expect(await store.deliveryStatus(publicKey, result.submission.id)).toHaveLength(3);
      expect(await store.getFormDestinations(publicKey)).toHaveLength(2);
      const jobs = await store.claimJobs(20);
      expect(jobs.filter(j => j.destination.config.template === "Hello {{name}}")).toHaveLength(2);
      expect(jobs.every(j => j.submission.id === result.submission.id)).toBe(true);
      for (const job of jobs) await store.markJobDelivered(job.id);
      expect((await store.deliveryStatus(publicKey, result.submission.id)).every(d => d.status === "delivered")).toBe(true);
    } finally { await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]); }
  });
  it("paginates SQL aggregates and preserves totals on out-of-range pages", async () => {
    const page = await store.managementPage("forms", { ...query, tenantId });
    expect(page.pagination.total).toBe(2); expect(page.items[0]).toMatchObject({ publicKey: key, submissionCount: 2, acceptedCount: 1, spamCount: 1 });
    const beyond = await store.managementPage("forms", { ...query, tenantId, page: 9 });
    expect(beyond.items).toEqual([]); expect(beyond.pagination.total).toBe(2);
    const injection = await store.managementPage("forms", { ...query, q: "' OR 1=1 --" }); expect(injection.items).toEqual([]);
  });
  it("tests selected manual integrations and replies to filtered submissions across pages while skipping invalid recipients", async () => {
    const tenant = await store.createTenant("Filtered replies");
    const publicKey = `frm_${randomUUID()}`;
    const config = getConfig({ NODE_ENV: "test", DATABASE_URL: pool.options.connectionString!, ADMIN_API_KEY: "test-admin-key-at-least-24-characters", DATA_ENCRYPTION_KEY: "b".repeat(64), PUBLIC_BASE_URL: "http://localhost:3100", MAIL_HOST:"", MAIL_PORT:587 as any, MAIL_AUTH:true as any, MAIL_USERNAME:"", MAIL_USER:"", MAIL_PASSWORD:"", MAIL_PASS:"", MAIL_FROM:"", ENABLE_EMAIL:true as any, ENABLE_SMS:true as any, ENABLE_WHATSAPP:true as any, ENABLE_DISCORD:true as any, ENABLE_WEBHOOK:true as any, ENABLE_MAIL:true as any });
    const app = buildApp(config, store);
    const headers = { authorization: `Bearer ${config.ADMIN_API_KEY}` };
    try {
      const form = await store.createForm({ tenantName: "Filtered replies", tenantId: tenant, name: "Admissions", allowedOrigins: ["https://example.com"], schema: { type: "object", required: ["email"], properties: { name: { type: "string" }, email: { type: "string" }, education: { type: "string", enum: ["SEE", "+2"] }, groups: { type: "array", items: { type: "string", enum: ["Rai", "Limbu"] } } } }, destinations: [
        { kind: "email", config: { recipientField: "email", deliveryMode: "manual", template: "Thanks {{name}}", subject: "Confirmation" } },
        { kind: "discord", config: { deliveryMode: "automatic", template: "Admissions" }, secret: "https://discord.com/api/webhooks/123/test-token" }
      ] }, publicKey);
      const destinations = await store.getFormDestinations(publicKey);
      const email = destinations.find(d => d.kind === "email")!;
      const sample = { name: "Alex Morgan", email: "alex@example.com", education: "SEE", groups: ["Rai"], _website: "" };
      const testBody = { payload: sample, send: true, destinationIds: [email.id], requestId: randomUUID() };
      const first = await app.inject({ method: "POST", url: `/v1/admin/forms/${publicKey}/test`, headers, payload: testBody });
      expect(first.statusCode).toBe(202);
      const repeated = await app.inject({ method: "POST", url: `/v1/admin/forms/${publicKey}/test`, headers, payload: testBody });
      expect(repeated.json().submissionId).toBe(first.json().submissionId);
      expect(await store.deliveryStatus(publicKey, first.json().submissionId)).toMatchObject([{ kind: "email" }]);
      expect((await store.listSubmissions(publicKey, 10))[0].payload).toEqual({ name: "Alex Morgan", email: "alex@example.com", education: "SEE", groups: ["Rai"] });
      for (let i = 0; i < 24; i++) await store.createSubmission({ form, payload: { name: `Applicant ${i}`, email: i < 2 ? "invalid" : `person${i}@example.com`, education: i < 22 ? "SEE" : "+2", groups: ["Rai"] }, skipAutomatic: true, status: "accepted", sourceIpHash: "test", accessTokenHash: "test", expiresAt: new Date(Date.now() + 60000) });
      const fields = { education: ["SEE"], groups: ["Rai"] };
      const page = await store.managementPage("submissions", { page: 1, limit: 10, q: "", sort: "newest", fields }, publicKey);
      expect(page.pagination.total).toBe(23); expect(page.items).toHaveLength(10);
      const path = `/v1/admin/forms/${publicKey}/replies`;
      const preview = await app.inject({ method: "POST", url: `${path}/preview`, headers, payload: { q: "", fields } });
      expect(preview.json()).toMatchObject({ matched: 23, overLimit: false });
      const payload = { filters: { q: "", fields }, destinationIds: destinations.map(d => d.id), message: "Update for {{name}}", subject: "Admission update", requestId: randomUUID() };
      const sent = await app.inject({ method: "POST", url: path, headers, payload });
      expect(sent.statusCode).toBe(202); expect(sent.json().queued).toBe(44);
      expect((await app.inject({ method: "POST", url: path, headers, payload })).json().queued).toBe(44);
      const jobs = await store.claimJobs(100);
      expect(jobs).toHaveLength(45);
      expect(jobs.filter(j => j.destination.config.subject === "Admission update")).toHaveLength(21);
      expect(await store.findReplySubmissions(publicKey, { q: "", fields: { education: ["' OR 1=1 --"] } })).toEqual([]);
      expect(await store.findReplySubmissions(publicKey, { q: "", from: "2100-01-01T00:00:00Z" })).toEqual([]);
    } finally { await app.close(); await pool.query("DELETE FROM tenants WHERE id=$1", [tenant]); }
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
