import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { ListQuery, PageResult } from "../src/management.js";
import type {
  CreateFormInput,
  AdminRole,
  FormSummary,
  FormRecord,
  JsonObject,
  OutboxJob,
  Store,
  SubmissionRecord,
  SubmissionResult,
  SubmissionStatus
} from "../src/types.js";

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3000,
  DATABASE_URL: "postgres://unused",
  ADMIN_API_KEY: "0123456789abcdef01234567",
  DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  PUBLIC_BASE_URL: "http://localhost:3000",
  MAX_BODY_BYTES: 4096,
  RATE_LIMIT_WINDOW_SECONDS: 60,
  RATE_LIMIT_MAX: 20,
  RETENTION_DAYS: 90,
  WORKER_POLL_MS: 1000,
  SMTP_URL: "",
  EMAIL_FROM: "forms@example.com",
  WEBHOOK_TIMEOUT_MS: 5000,
  TURNSTILE_SECRET_KEY: ""
};

class MemoryStore implements Store {
  async managementPage(resource: "forms" | "tenants" | "submissions", query: ListQuery, publicKey?: string): Promise<PageResult> {
    let rows: Record<string, unknown>[] = resource === "forms" ? await this.listFormSummaries() as unknown as Record<string, unknown>[] : resource === "tenants" ? (await this.listTenants()).map(t => ({ ...t, activeFormCount: [...this.forms.values()].filter(f => f.tenantId === t.id && f.status === "active").length })) : this.submissions.filter(s => s.formId === this.forms.get(publicKey!)?.id && s.status !== "deleted") as unknown as Record<string, unknown>[];
    rows = rows.filter(r => (!query.tenantId || (resource === "tenants" ? r.id : r.tenantId) === query.tenantId) && (!query.q || JSON.stringify(resource === "submissions" ? r.payload : r.name).toLowerCase().includes(query.q.toLowerCase())) && (!query.status || (resource === "tenants" ? query.status === "active" ? Number(r.activeFormCount) > 0 : Number(r.activeFormCount) === 0 : r.status === query.status)) && (resource !== "submissions" || ((!query.from || String(r.createdAt) >= query.from) && (!query.to || String(r.createdAt) <= query.to))));
    const total = rows.length;
    return { items: rows.slice((query.page - 1) * query.limit, query.page * query.limit), pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) } };
  }
  async analytics(tenantId?: string) {
    const forms = [...this.forms.values()].filter(f => !tenantId || f.tenantId === tenantId);
    return { forms: forms.length, activeForms: forms.filter(f => f.status === "active").length, mostUsedForms: forms.map(f => ({ publicKey: f.publicKey, name: f.name })) };
  }
  forms = new Map<string, FormRecord>();
  submissions: SubmissionRecord[] = [];
  admins = new Map<string, { id: string; email: string; passwordHash: string; role: AdminRole; tenantId: string | null }>();
  sessions = new Map<string, string>();
  tenants = new Map<string, { name: string; maxOriginsPerForm: number; maxForms: number; maxTotalSubmissions: number; maxDailySubmissions: number }>();

  async createSiteAccount(tenantName: string, email: string, passwordHash: string) {
    const tenantId = randomUUID();
    this.tenants.set(tenantId, { name: tenantName, maxOriginsPerForm: 5, maxForms: 10, maxTotalSubmissions: 10000, maxDailySubmissions: 1000 });
    this.admins.set(email, { id: randomUUID(), email, passwordHash, role: "tenant", tenantId });
    return { tenantId };
  }

  async createAdmin(email: string, passwordHash: string, role: AdminRole, tenantId: string | null) {
    this.admins.set(email, { id: randomUUID(), email, passwordHash, role, tenantId });
  }
  async getAdminByEmail(email: string) { return this.admins.get(email) ?? null; }
  async createAdminSession(adminId: string, tokenHash: string) { this.sessions.set(tokenHash, adminId); }
  async getAdminBySession(tokenHash: string) {
    return [...this.admins.values()].find((admin) => admin.id === this.sessions.get(tokenHash)) ?? null;
  }
  async deleteAdminSession(tokenHash: string) { this.sessions.delete(tokenHash); }
  async updateAdminPassword(adminId: string, passwordHash: string) {
    const admin = [...this.admins.values()].find((item) => item.id === adminId);
    if (admin) admin.passwordHash = passwordHash;
    for (const [token, id] of this.sessions) if (id === adminId) this.sessions.delete(token);
  }
  async createTenant(name: string) {
    const id = randomUUID();
    this.tenants.set(id, { name, maxOriginsPerForm: 5, maxForms: 10, maxTotalSubmissions: 10000, maxDailySubmissions: 1000 });
    return id;
  }
  async listTenants() {
    return [...this.tenants].map(([id, tenant]) => ({ id, ...tenant,
      formCount: [...this.forms.values()].filter((form) => form.tenantId === id).length,
      totalSubmissions: this.submissions.filter((item) => item.tenantId === id && item.status !== "deleted").length,
      dailySubmissions: this.submissions.filter((item) => item.tenantId === id && item.status !== "deleted").length }));
  }
  async getTenantLimits(tenantId: string) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;
    return { ...tenant, formCount: [...this.forms.values()].filter((form) => form.tenantId === tenantId).length,
      totalSubmissions: this.submissions.filter((item) => item.tenantId === tenantId && item.status !== "deleted").length,
      dailySubmissions: this.submissions.filter((item) => item.tenantId === tenantId && item.status !== "deleted").length };
  }
  async updateTenantLimits(tenantId: string, limits: { maxOriginsPerForm: number; maxForms: number; maxTotalSubmissions: number; maxDailySubmissions: number }) {
    const tenant = this.tenants.get(tenantId); if (!tenant) return false; Object.assign(tenant, limits); return true;
  }
  async getTenantIdForForm(publicKey: string) { return this.forms.get(publicKey)?.tenantId ?? null; }
  async setFormStatus(publicKey: string, status: "active" | "disabled") {
    const form = this.forms.get(publicKey);
    if (!form) return false;
    form.status = status;
    return true;
  }
  async getForm(publicKey: string) { return this.forms.get(publicKey) ?? null; }
  async updateForm(publicKey: string, input: Partial<CreateFormInput> & { status?: "active" | "disabled" }) {
    const form = this.forms.get(publicKey); if (!form) return null;
    if (input.name) form.name = input.name;
    if (input.allowedOrigins) form.allowedOrigins = input.allowedOrigins;
    if (input.successMessage) form.successMessage = input.successMessage;
    if (input.schema) { form.schema = input.schema as JsonObject; form.version += 1; }
    if (input.status) form.status = input.status;
    return form;
  }
  async getTenantIdForSubmission(submissionId: string) { return this.submissions.find((item) => item.id === submissionId)?.tenantId ?? null; }
  async updateSubmission(submissionId: string, payload: JsonObject, status: SubmissionStatus) {
    const item = this.submissions.find((entry) => entry.id === submissionId); if (!item) return false;
    item.payload = payload; item.status = status; return true;
  }

  async ready() {
    return true;
  }

  async createForm(input: CreateFormInput, publicKey: string): Promise<FormRecord> {
    const tenantId = input.tenantId ?? await this.createTenant(input.tenantName);
    const form: FormRecord = {
      id: randomUUID(),
      tenantId,
      publicKey,
      name: input.name,
      status: "active",
      allowedOrigins: input.allowedOrigins,
      successMessage: input.successMessage ?? "Thank you. We received your message.",
      honeypotField: input.honeypotField ?? "_website",
      version: 1,
      schema: input.schema as JsonObject
    };
    this.forms.set(publicKey, form);
    return form;
  }

  async getActiveForm(publicKey: string) {
    return this.forms.get(publicKey) ?? null;
  }

  async createSubmission(args: {
    form: FormRecord;
    payload: JsonObject;
    status: SubmissionStatus;
    sourceOrigin?: string;
    sourceIpHash: string;
    idempotencyKey?: string;
    accessTokenHash: string;
    expiresAt: Date;
  }): Promise<SubmissionResult> {
    const existing = args.idempotencyKey
      ? this.submissions.find((item) => item.formId === args.form.id && item.idempotencyKey === args.idempotencyKey)
      : undefined;
    if (existing) return { submission: existing, duplicate: true };
    const submission: SubmissionRecord = {
      id: randomUUID(),
      tenantId: args.form.tenantId,
      formId: args.form.id,
      formVersion: args.form.version,
      payload: args.payload,
      status: args.status,
      sourceOrigin: args.sourceOrigin,
      sourceIpHash: args.sourceIpHash,
      idempotencyKey: args.idempotencyKey,
      expiresAt: args.expiresAt.toISOString(),
      createdAt: new Date().toISOString()
    };
    this.submissions.push(submission);
    this.accessTokens.set(submission.id, args.accessTokenHash);
    return { submission, duplicate: false };
  }

  accessTokens = new Map<string, string>();
  async getSubmissionByAccessToken(submissionId: string, accessTokenHash: string) {
    const submission = this.submissions.find((item) => item.id === submissionId);
    const form = submission ? [...this.forms.values()].find((item) => item.id === submission.formId) : undefined;
    return submission && form && this.accessTokens.get(submissionId) === accessTokenHash
      ? { submission, allowedOrigins: form.allowedOrigins }
      : null;
  }

  async listSubmissions(publicKey: string, limit: number) {
    const form = this.forms.get(publicKey);
    return form ? this.submissions.filter((item) => item.formId === form.id).slice(0, limit) : [];
  }

  async listFormSummaries(): Promise<FormSummary[]> {
    return [...this.forms.values()]
      .map((form) => {
        const submissions = this.submissions.filter((item) => item.formId === form.id && item.status !== "deleted");
        const sourceOriginCounts = submissions.reduce<Record<string, number>>((counts, submission) => {
          const origin = submission.sourceOrigin ?? "unknown";
          counts[origin] = (counts[origin] ?? 0) + 1;
          return counts;
        }, {});
        return {
          tenantId: form.tenantId,
          tenantName: "Acme",
          publicKey: form.publicKey,
          name: form.name,
          status: form.status,
          allowedOrigins: form.allowedOrigins,
          submissionCount: submissions.length,
          acceptedCount: submissions.filter((item) => item.status === "accepted").length,
          spamCount: submissions.filter((item) => item.status === "spam").length,
          lastSubmittedAt: submissions.at(-1)?.createdAt,
          sourceOriginCounts
          , successMessage: form.successMessage,
          schema: form.schema
        };
      })
      .sort((a, b) => b.submissionCount - a.submissionCount);
  }

  async claimJobs(): Promise<OutboxJob[]> {
    return [];
  }

  async markJobDelivered() {}
  async markJobFailed() {}
  async deleteExpiredSubmissions() {
    return 0;
  }
  async close() {}
}

async function createTestForm(store: MemoryStore) {
  const app = buildApp(config, store);
  const response = await app.inject({
    method: "POST",
    url: "/v1/admin/forms",
    headers: {
      authorization: `Bearer ${config.ADMIN_API_KEY}`,
      "content-type": "application/json"
    },
    payload: {
      tenantName: "Acme",
      name: "Website contact",
      allowedOrigins: ["https://www.example.com"],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "topic"],
        properties: {
          name: { type: "string", minLength: 2 },
          email: { type: "string", format: "email" },
          topic: { type: "string", enum: ["sales", "support"] },
          message: { type: "string", maxLength: 2000 }
        }
      }
    }
  });
  expect(response.statusCode).toBe(201);
  return { app, body: response.json() as { publicKey: string } };
}

describe("contact form API", () => {
  it("rate-limits a targeted login without locking out other accounts behind the frontend proxy", async () => {
    const store = new MemoryStore(); const app = buildApp(config, store);
    const headers = { origin: config.PUBLIC_BASE_URL };
    for (let i = 0; i < 10; i++) expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers, payload: { email: "target@example.com", password: "incorrect" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers, payload: { email: "target@example.com", password: "incorrect" } })).statusCode).toBe(429);
    expect((await app.inject({ method: "POST", url: "/v1/auth/signup", headers, payload: { workspaceName: "Other studio", email: "other@example.com", password: "long-valid-password" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers, payload: { email: "other@example.com", password: "long-valid-password" } })).statusCode).toBe(200);
    await app.close();
  });
  it("paginates forms, rejects invalid filters, and keeps tenant analytics scoped", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    await app.inject({ method: "POST", url: "/v1/admin/users", headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` }, payload: { email: "scoped@example.com", password: "a-long-secret-password", role: "tenant", formKey: body.publicKey } });
    const second = await createTestForm(store); await second.app.close();
    const login = await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "scoped@example.com", password: "a-long-secret-password" } });
    const headers = { cookie: login.headers["set-cookie"] as string };
    const foreignTenant = store.forms.get(second.body.publicKey)!.tenantId;
    const list = await app.inject({ url: `/v1/admin/forms?limit=1&tenantId=${foreignTenant}`, headers });
    expect(list.statusCode).toBe(200); expect(list.json().forms.map((f: FormRecord) => f.publicKey)).toEqual([body.publicKey]);
    expect(list.json().pagination).toEqual({ page: 1, limit: 1, total: 1, pages: 1 });
    const beyond = await app.inject({ url: "/v1/admin/forms?limit=1&page=2", headers });
    expect(beyond.json().forms).toEqual([]); expect(beyond.json().pagination.total).toBe(1);
    for (const query of ["page=0", "page=1.5", "limit=101", "status=spam", "from=garbage", "from=2026-09-25T00:00:00Z&to=2026-09-24T00:00:00Z"]) expect((await app.inject({ url: `/v1/admin/forms?${query}`, headers })).statusCode).toBe(400);
    const analytics = await app.inject({ url: `/v1/admin/analytics?tenantId=${foreignTenant}`, headers });
    expect(analytics.json().forms).toBe(1); expect(analytics.json().mostUsedForms[0].publicKey).toBe(body.publicKey);
    expect((await app.inject({ url: `/v1/admin/tenants/${foreignTenant}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ url: "/v1/admin/tenants", headers })).statusCode).toBe(403);
    expect((await app.inject({ url: "/v1/admin/analytics" })).statusCode).toBe(401);
    await app.close();
  });

  it("creates tenant accounts and revokes their sessions on password reset", async () => {
    const store = new MemoryStore(); const app = buildApp(config, store);
    const service = { authorization: `Bearer ${config.ADMIN_API_KEY}` };
    const created = await app.inject({ method: "POST", url: "/v1/admin/tenants", headers: service, payload: { name: "Studio", email: "owner@example.com", password: "original-password" } });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "owner@example.com", password: "original-password" } });
    const cookie = login.headers["set-cookie"] as string;
    expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict");
    const tenantId = created.json().tenantId;
    const forbidden = await app.inject({ method: "POST", url: `/v1/admin/tenants/${tenantId}/password`, headers: { cookie, origin: config.PUBLIC_BASE_URL }, payload: { email: "owner@example.com", newPassword: "replacement-password" } });
    expect(forbidden.statusCode).toBe(403);
    const reset = await app.inject({ method: "POST", url: `/v1/admin/tenants/${tenantId}/password`, headers: service, payload: { email: "owner@example.com", newPassword: "replacement-password" } });
    expect(reset.statusCode).toBe(200);
    expect((await app.inject({ url: "/v1/admin/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "owner@example.com", password: "original-password" } })).statusCode).toBe(401);
    const newLogin = await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "owner@example.com", password: "replacement-password" } });
    expect(newLogin.statusCode).toBe(200);
    const own = await app.inject({ method: "POST", url: "/v1/admin/password", headers: { cookie: newLogin.headers["set-cookie"] as string, origin: config.PUBLIC_BASE_URL }, payload: { currentPassword: "replacement-password", newPassword: "another-long-password" } });
    expect(own.statusCode).toBe(200);
    expect((await app.inject({ url: "/v1/admin/me", headers: { cookie: newLogin.headers["set-cookie"] as string } })).statusCode).toBe(401);
    await app.close();
  });

  it("filters active tenants and returns paginated tenant forms", async () => {
    const store = new MemoryStore(); const { app, body } = await createTestForm(store);
    const headers = { authorization: `Bearer ${config.ADMIN_API_KEY}` };
    await store.createTenant("Empty workspace");
    const active = await app.inject({ url: "/v1/admin/tenants?status=active", headers });
    expect(active.json().tenants).toHaveLength(1);
    const id = store.forms.get(body.publicKey)!.tenantId;
    const detail = await app.inject({ url: `/v1/admin/tenants/${id}?limit=1&status=active`, headers });
    expect(detail.json().forms[0].publicKey).toBe(body.publicKey);
    expect(detail.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("lets tenant admins edit their forms and enforces their form allowance", async () => {
    const store = new MemoryStore();
    const app = buildApp(config, store);
    const signup = await app.inject({ method: "POST", url: "/v1/auth/signup", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { workspaceName: "Limited Studio", email: "limited@studio.test", password: "a-secure-password" } });
    const tenantId = signup.json().tenantId as string;
    await store.updateTenantLimits(tenantId, { maxOriginsPerForm: 2, maxForms: 1, maxTotalSubmissions: 10, maxDailySubmissions: 5 });
    const login = await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "limited@studio.test", password: "a-secure-password" } });
    const headers = { cookie: login.headers["set-cookie"] as string, origin: config.PUBLIC_BASE_URL };
    const created = await app.inject({ method: "POST", url: "/v1/admin/forms", headers, payload: {
      tenantName: "Ignored", name: "Original", allowedOrigins: ["https://one.example"],
      schema: { type: "object", additionalProperties: false, properties: { name: { type: "string" } } }
    } });
    expect(created.statusCode).toBe(201);
    const publicKey = created.json().publicKey as string;
    const edited = await app.inject({ method: "PATCH", url: `/v1/admin/forms/${publicKey}`, headers, payload: {
      name: "Edited", allowedOrigins: ["https://one.example/", "https://two.example"],
      successMessage: "Updated", schema: { type: "object", additionalProperties: false, properties: { email: { type: "string", format: "email" } } }
    } });
    expect(edited.statusCode).toBe(200);
    expect(store.forms.get(publicKey)).toEqual(expect.objectContaining({ name: "Edited", version: 2,
      allowedOrigins: ["https://one.example", "https://two.example"] }));
    const overLimit = await app.inject({ method: "POST", url: "/v1/admin/forms", headers, payload: {
      tenantName: "Ignored", name: "Second", allowedOrigins: ["https://one.example"],
      schema: { type: "object", additionalProperties: false, properties: {} }
    } });
    expect(overLimit.statusCode).toBe(422);
    expect(overLimit.json().title).toBe("Tenant limit reached");
  });

  it("allows super admins, but not tenant admins, to change tenant permissions", async () => {
    const store = new MemoryStore();
    const app = buildApp(config, store);
    const signup = await app.inject({ method: "POST", url: "/v1/auth/signup", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { workspaceName: "Managed Studio", email: "tenant@studio.test", password: "a-secure-password" } });
    await app.inject({ method: "POST", url: "/v1/admin/users", headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: { email: "super@example.com", password: "a-long-super-password", role: "super" } });
    const superLogin = await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "super@example.com", password: "a-long-super-password" } });
    const limits = { maxOriginsPerForm: 3, maxForms: 4, maxTotalSubmissions: 500, maxDailySubmissions: 50 };
    const changed = await app.inject({ method: "PATCH", url: `/v1/admin/tenants/${signup.json().tenantId}`,
      headers: { origin: config.PUBLIC_BASE_URL, cookie: superLogin.headers["set-cookie"] as string }, payload: limits });
    expect(changed.statusCode).toBe(200);
    expect(await store.getTenantLimits(signup.json().tenantId)).toEqual(expect.objectContaining(limits));

    const tenantLogin = await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "tenant@studio.test", password: "a-secure-password" } });
    const forbidden = await app.inject({ method: "PATCH", url: `/v1/admin/tenants/${signup.json().tenantId}`,
      headers: { origin: config.PUBLIC_BASE_URL, cookie: tenantLogin.headers["set-cookie"] as string }, payload: limits });
    expect(forbidden.statusCode).toBe(403);
  });

  it("normalizes trailing slashes in allowed origins but rejects URL paths", async () => {
    const store = new MemoryStore();
    const app = buildApp(config, store);
    const valid = await app.inject({
      method: "POST",
      url: "/v1/admin/forms",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: {
        tenantName: "Local Studio",
        name: "Local contact",
        allowedOrigins: ["http://192.168.1.77:3000/"],
        schema: { type: "object", additionalProperties: false, properties: {} }
      }
    });
    expect(valid.statusCode).toBe(201);
    expect(store.forms.get(valid.json().publicKey)?.allowedOrigins).toEqual(["http://192.168.1.77:3000"]);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/admin/forms",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: {
        tenantName: "Local Studio",
        name: "Invalid contact",
        allowedOrigins: ["http://192.168.1.77:3000/contact"],
        schema: { type: "object", additionalProperties: false, properties: {} }
      }
    });
    expect(invalid.statusCode).toBe(422);
  });

  it("signs up a customer workspace and lets its owner create forms", async () => {
    const store = new MemoryStore();
    const app = buildApp(config, store);
    const signup = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      headers: { origin: config.PUBLIC_BASE_URL },
      payload: { workspaceName: "New Studio", email: "owner@studio.test", password: "a-secure-password" }
    });
    expect(signup.statusCode).toBe(201);
    expect(signup.json()).toEqual(expect.objectContaining({ email: "owner@studio.test", role: "tenant" }));

    const login = await app.inject({
      method: "POST",
      url: "/v1/admin/login",
      headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "owner@studio.test", password: "a-secure-password" }
    });
    expect(login.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/forms",
      headers: { cookie: login.headers["set-cookie"] as string, origin: config.PUBLIC_BASE_URL },
      payload: {
        tenantName: "Current workspace",
        name: "Order form",
        allowedOrigins: ["https://shop.example.com"],
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            products: { type: "array", items: { type: "string", enum: ["One", "Two"] }, uniqueItems: true }
          }
        }
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().tenantId).toBe(signup.json().tenantId);
  });

  it("lets a site admin create forms only in their own tenant", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const tenantId = store.forms.get(body.publicKey)?.tenantId;
    await app.inject({
      method: "POST", url: "/v1/admin/users",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: { email: "builder@example.com", password: "a-long-secret-password", role: "tenant", formKey: body.publicKey }
    });
    const login = await app.inject({
      method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "builder@example.com", password: "a-long-secret-password" }
    });
    const created = await app.inject({
      method: "POST", url: "/v1/admin/forms",
      headers: { cookie: login.headers["set-cookie"] as string, origin: config.PUBLIC_BASE_URL },
      payload: {
        tenantName: "Ignored browser value",
        tenantId: randomUUID(),
        name: "Registration",
        allowedOrigins: ["https://www.example.com"],
        schema: { type: "object", additionalProperties: false, properties: {} }
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().tenantId).toBe(tenantId);
  });

  it("limits a site admin to their own tenant", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const other = await app.inject({
      method: "POST", url: "/v1/admin/forms",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: { tenantName: "Other", name: "Other form", allowedOrigins: ["https://other.example"],
        schema: { type: "object", additionalProperties: false, properties: {} } }
    });
    const otherKey = (other.json() as { publicKey: string }).publicKey;
    const created = await app.inject({
      method: "POST", url: "/v1/admin/users",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: { email: "owner@example.com", password: "a-long-secret-password", role: "tenant", formKey: body.publicKey }
    });
    expect(created.statusCode).toBe(201);
    const login = await app.inject({
      method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "owner@example.com", password: "a-long-secret-password" }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"] as string;
    const own = await app.inject({ method: "GET", url: "/v1/admin/forms/summary", headers: { cookie } });
    expect(own.json().forms.map((form: FormSummary) => form.publicKey)).toEqual([body.publicKey]);
    const forbidden = await app.inject({ method: "GET", url: `/v1/admin/forms/${otherKey}/submissions`, headers: { cookie } });
    expect(forbidden.statusCode).toBe(404);
    const cannotDisableOther = await app.inject({
      method: "PATCH", url: `/v1/admin/forms/${otherKey}`,
      headers: { cookie, origin: config.PUBLIC_BASE_URL }, payload: { status: "disabled" }
    });
    expect(cannotDisableOther.statusCode).toBe(404);
    const disableOwn = await app.inject({
      method: "PATCH", url: `/v1/admin/forms/${body.publicKey}`,
      headers: { cookie, origin: config.PUBLIC_BASE_URL }, payload: { status: "disabled" }
    });
    expect(disableOwn.statusCode).toBe(200);
    const allowed = await app.inject({ method: "GET", url: `/v1/admin/forms/${body.publicKey}/submissions`, headers: { cookie } });
    expect(allowed.statusCode).toBe(200);
  });
  it("creates a form through the admin endpoint", async () => {
    const { body } = await createTestForm(new MemoryStore());
    expect(body.publicKey).toMatch(/^frm_/);
  });

  it("accepts valid submissions and rejects disallowed origins", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const ok = await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com", "idempotency-key": "key-12345678" },
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    });
    expect(ok.statusCode).toBe(202);
    expect(ok.json().status).toBe("accepted");
    expect(ok.json()).toEqual(expect.objectContaining({
      status: "accepted",
      message: "Thank you. We received your message.",
      submissionId: expect.any(String),
      responseUrl: expect.any(String),
      responseToken: expect.any(String)
    }));

    const created = ok.json() as { responseUrl: string; responseToken: string };
    const ownResponse = await app.inject({
      method: "GET",
      url: created.responseUrl,
      headers: { origin: "https://www.example.com", authorization: `Bearer ${created.responseToken}` }
    });
    expect(ownResponse.statusCode).toBe(200);
    expect(ownResponse.json()).toEqual(expect.objectContaining({
      status: "accepted",
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    }));

    const cannotReadFromAnotherOrigin = await app.inject({
      method: "GET",
      url: created.responseUrl,
      headers: { origin: "https://evil.example.com", authorization: `Bearer ${created.responseToken}` }
    });
    expect(cannotReadFromAnotherOrigin.statusCode).toBe(403);

    const blocked = await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://evil.example.com" },
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    });
    expect(blocked.statusCode).toBe(403);
  });

  it("returns validation errors for invalid fields", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com" },
      payload: { name: "J", email: "not-an-email", topic: "billing" }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().errors.length).toBeGreaterThan(0);
  });

  it("deduplicates submissions by idempotency key", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const request = {
      method: "POST" as const,
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com", "idempotency-key": "retry-key-123" },
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    };
    expect((await app.inject(request)).statusCode).toBe(202);
    const duplicate = await app.inject(request);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().status).toBe("accepted");
    expect(store.submissions).toHaveLength(1);
  });

  it("classifies honeypot submissions as spam", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com" },
      payload: {
        name: "Jane",
        email: "jane@example.com",
        topic: "support",
        _website: "filled by bot"
      }
    });
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("spam");
  });

  it("summarizes traffic separately for every form", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const second = await app.inject({
      method: "POST",
      url: "/v1/admin/forms",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: {
        tenantName: "Gourav Studio",
        name: "Gourav inquiry",
        allowedOrigins: ["https://gourav.example"],
        schema: { type: "object", additionalProperties: false, properties: {} }
      }
    });
    const secondKey = (second.json() as { publicKey: string }).publicKey;

    await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com" },
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    });
    await app.inject({
      method: "POST",
      url: `/v1/forms/${body.publicKey}/submissions`,
      headers: { origin: "https://www.example.com" },
      payload: { name: "John", email: "john@example.com", topic: "sales" }
    });
    await app.inject({
      method: "POST",
      url: `/v1/forms/${secondKey}/submissions`,
      headers: { origin: "https://gourav.example" },
      payload: {}
    });

    const summary = await app.inject({
      method: "GET",
      url: "/v1/admin/forms/summary",
      headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` }
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().forms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          publicKey: body.publicKey,
          submissionCount: 2,
          sourceOriginCounts: { "https://www.example.com": 2 }
        }),
        expect.objectContaining({ publicKey: secondKey, submissionCount: 1 })
      ])
    );
  });

  it("requires bot verification when Turnstile is configured", async () => {
    const store = new MemoryStore();
    const secureConfig = { ...config, TURNSTILE_SECRET_KEY: "test-secret" };
    const app = buildApp(secureConfig, store);
    const create = await app.inject({
      method: "POST",
      url: "/v1/admin/forms",
      headers: {
        authorization: `Bearer ${config.ADMIN_API_KEY}`,
        "content-type": "application/json"
      },
      payload: {
        tenantName: "Acme",
        name: "Website contact",
        allowedOrigins: ["https://www.example.com"],
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["name", "email", "topic"],
          properties: {
            name: { type: "string", minLength: 2 },
            email: { type: "string", format: "email" },
            topic: { type: "string", enum: ["sales", "support"] }
          }
        }
      }
    });
    const { publicKey } = create.json() as { publicKey: string };

    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${publicKey}/submissions`,
      headers: { origin: "https://www.example.com" },
      payload: { name: "Jane", email: "jane@example.com", topic: "support" }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toBe("Bot verification failed.");
  });
});
