import { createRequire } from "node:module";
import { z } from "zod";
import { listQuery } from "./management.js";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import Fastify, { type FastifyError, type FastifyReply } from "fastify";
import { hashPassword, hashSessionToken, newSessionToken, verifyPassword } from "./admin-auth.js";
import type { AppConfig } from "./config.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import {
  applyCors,
  applySecurityHeaders,
  constantTimeEqual,
  hashIp,
  hashSubmissionAccessToken,
  isAllowedOrigin,
  isSafeWebhookUrl,
  isValidIdempotencyKey,
  newPublicKey,
  newSubmissionAccessToken
} from "./security.js";
import type { AdminRole, CreateFormInput, JsonObject, Store, TenantLimits } from "./types.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

function problem(reply: FastifyReply, status: number, title: string, detail: string, extra: JsonObject = {}) {
  return reply.code(status).send({ type: "about:blank", title, status, detail, ...extra });
}

function validationErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    message: error.message ?? "is invalid",
    keyword: error.keyword
  }));
}

function assertPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeExactOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function verifyTurnstile(secret: string, token: string | undefined, ip: string): Promise<boolean> {
  if (!secret) return true;
  if (!token) return false;

  const body = new URLSearchParams({
    secret,
    response: token,
    remoteip: ip
  });
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body
  });
  if (!response.ok) return false;
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}

const createFormAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(createFormAjv);
const validateCreateForm = createFormAjv.compile({
  type: "object",
  additionalProperties: false,
  required: ["tenantName", "name", "allowedOrigins", "schema"],
  properties: {
    tenantName: { type: "string", minLength: 1, maxLength: 200 },
    tenantId: { type: "string", format: "uuid" },
    name: { type: "string", minLength: 1, maxLength: 200 },
    allowedOrigins: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string", pattern: "^https?://[^/]+$" }
    },
    successMessage: { type: "string", minLength: 1, maxLength: 500 },
    honeypotField: { type: "string", minLength: 1, maxLength: 80 },
    schema: { type: "object" },
    destinations: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "config"],
        properties: {
          kind: { enum: ["email", "webhook"] },
          config: { type: "object" },
          secret: { type: "string", minLength: 24 }
        }
      }
    }
  }
});

const schemaAjv = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });
addFormats(schemaAjv);

export function buildApp(config: AppConfig, store: Store) {
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : true,
    bodyLimit: config.MAX_BODY_BYTES
  });
  const limiter = new FixedWindowRateLimiter(config.RATE_LIMIT_WINDOW_SECONDS * 1000, config.RATE_LIMIT_MAX);
  const loginLimiter = new FixedWindowRateLimiter(15 * 60 * 1000, 10);
  const signupLimiter = new FixedWindowRateLimiter(60 * 60 * 1000, 5);
  const authTrafficLimiter = new FixedWindowRateLimiter(15 * 60 * 1000, 300);
  const passwordLimiter = new FixedWindowRateLimiter(15 * 60 * 1000, 10);

  async function adminFor(request: { headers: Record<string, unknown> }) {
    const auth = request.headers.authorization;
    if (typeof auth === "string" && constantTimeEqual(auth, `Bearer ${config.ADMIN_API_KEY}`)) {
      return { id: "service-key", email: "service-key", role: "sudo" as const, tenantId: null };
    }
    const cookie = request.headers.cookie;
    const token = typeof cookie === "string" ? /(?:^|;\s*)contact_admin=([A-Za-z0-9_-]{43})/.exec(cookie)?.[1] : undefined;
    return token ? store.getAdminBySession(hashSessionToken(token)) : null;
  }

  function sameOrigin(request: { headers: Record<string, unknown> }): boolean {
    const origin = request.headers.origin;
    return typeof origin === "string" && origin === new URL(config.PUBLIC_BASE_URL).origin;
  }

  app.addHook("onSend", async (request, reply) => {
    applySecurityHeaders(reply);
    if (request.url.startsWith("/v1/admin") || request.url.startsWith("/v1/auth")) reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error.statusCode === 413) {
      void problem(reply, 413, "Payload too large", "Request body exceeds the configured limit.");
      return;
    }
    if (error.validation) {
      void problem(reply, 400, "Malformed request", "Request body is invalid.");
      return;
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      void problem(reply, error.statusCode, "Invalid request", error.message);
      return;
    }
    app.log.error(error);
    void problem(reply, 500, "Internal error", "The request could not be completed.");
  });

  app.options("/*", async (request, reply) => {
    applyCors(reply, request.headers.origin);
    return reply.code(204).send();
  });

  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/", async () => ({ service: "Contact API", health: "/health/ready" }));

  app.get("/health/ready", async (_request, reply) => {
    if (await store.ready()) return { status: "ok" };
    return problem(reply, 503, "Database not ready", "Database connectivity check failed.");
  });

  app.post("/v1/admin/login", async (request, reply) => {
    if (!sameOrigin(request)) return problem(reply, 403, "Forbidden", "Use the hosted admin page.");
    const limit = authTrafficLimiter.check(request.ip);
    if (!limit.allowed) return problem(reply, 429, "Too many attempts", "Try again later.");
    if (!assertPlainObject(request.body) || typeof request.body.email !== "string" ||
      typeof request.body.password !== "string") return problem(reply, 400, "Invalid request", "Email and password are required.");
    const email = request.body.email.trim().toLowerCase();
    if (email.length > 254 || request.body.password.length > 256) return problem(reply, 400, "Invalid request", "Invalid credentials.");
    if (!loginLimiter.check(email).allowed) return problem(reply, 429, "Too many attempts", "Try again later.");
    const admin = await store.getAdminByEmail(email);
    if (!admin || !(await verifyPassword(request.body.password, admin.passwordHash))) {
      return problem(reply, 401, "Unauthorized", "Invalid email or password.");
    }
    const portal = request.body.portal === "admin" || request.body.portal === "tenant" ? request.body.portal : null;
    const isStaff = admin.role === "sudo" || admin.role === "super";
    if (portal === "admin" && !isStaff) {
      return problem(reply, 403, "Forbidden", "Workspace accounts sign in at /login.");
    }
    if (portal === "tenant" && isStaff) {
      return problem(reply, 403, "Forbidden", "Service admins sign in at /auth/admin.");
    }
    const token = newSessionToken();
    await store.createAdminSession(admin.id, hashSessionToken(token), new Date(Date.now() + 8 * 60 * 60 * 1000));
    const secure = new URL(config.PUBLIC_BASE_URL).protocol === "https:" ? "; Secure" : "";
    reply.header("Set-Cookie", `contact_admin=${token}; HttpOnly; SameSite=Strict; Path=/v1/admin; Max-Age=28800${secure}`);
    reply.header("Cache-Control", "no-store");
    return { email: admin.email, role: admin.role };
  });

  app.post("/v1/auth/signup", async (request, reply) => {
    if (!sameOrigin(request)) return problem(reply, 403, "Forbidden", "Use the hosted signup page.");
    const limit = authTrafficLimiter.check(request.ip);
    if (!limit.allowed) return problem(reply, 429, "Too many attempts", "Try again later.");
    if (!assertPlainObject(request.body) || typeof request.body.workspaceName !== "string" ||
      typeof request.body.email !== "string" || typeof request.body.password !== "string") {
      return problem(reply, 400, "Invalid request", "Workspace name, email, and password are required.");
    }
    const workspaceName = request.body.workspaceName.trim();
    const email = request.body.email.trim().toLowerCase();
    const password = request.body.password;
    if (!workspaceName || workspaceName.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 || password.length < 8 || password.length > 256) {
      return problem(reply, 422, "Invalid request", "Use a valid workspace, email, and password of at least 8 characters.");
    }
    if (!signupLimiter.check(email).allowed) return problem(reply, 429, "Too many attempts", "Try again later.");
    try {
      const account = await store.createSiteAccount(workspaceName, email, await hashPassword(password));
      return reply.code(201).send({ email, role: "tenant", tenantId: account.tenantId });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        return problem(reply, 409, "Account exists", "An account with this email already exists.");
      }
      throw error;
    }
  });

  app.post("/v1/admin/logout", async (request, reply) => {
    if (!sameOrigin(request)) return problem(reply, 403, "Forbidden", "Invalid origin.");
    const token = /(?:^|;\s*)contact_admin=([A-Za-z0-9_-]{43})/.exec(request.headers.cookie ?? "")?.[1];
    if (token) await store.deleteAdminSession(hashSessionToken(token));
    reply.header("Set-Cookie", "contact_admin=; HttpOnly; SameSite=Strict; Path=/v1/admin; Max-Age=0");
    return { ok: true };
  });

  app.get("/v1/admin/me", async (request, reply) => {
    const admin = await adminFor(request);
    if (!admin) return problem(reply, 401, "Unauthorized", "Sign in required.");
    reply.header("Cache-Control", "no-store");
    return { email: admin.email, role: admin.role, tenantId: admin.tenantId };
  });

  app.post("/v1/admin/users", async (request, reply) => {
    if (!sameOrigin(request) && !constantTimeEqual(request.headers.authorization ?? "", `Bearer ${config.ADMIN_API_KEY}`)) {
      return problem(reply, 403, "Forbidden", "Invalid origin.");
    }
    const actor = await adminFor(request);
    if (!actor) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (!assertPlainObject(request.body) || typeof request.body.email !== "string" ||
      typeof request.body.password !== "string" || typeof request.body.role !== "string") {
      return problem(reply, 400, "Invalid request", "Email, password, and role are required.");
    }
    const { email, password } = request.body;
    const role = request.body.role === "service" ? "super" : request.body.role === "site" ? "tenant" : request.body.role;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 8 || password.length > 256 ||
      !["super", "tenant"].includes(String(role))) return problem(reply, 422, "Invalid request", "Invalid email, password, or role.");
    if (role === "super" && actor.role !== "sudo") return problem(reply, 403, "Forbidden", "Only sudo admins can create super admins.");
    if (actor.role === "tenant" && role !== "tenant") return problem(reply, 403, "Forbidden", "Tenant admins can add tenant admins only.");
    const formKey = request.body.formKey;
    let requestedTenantId = typeof request.body.tenantId === "string" ? request.body.tenantId : null;
    if (role === "tenant" && !requestedTenantId && typeof request.body.tenantName === "string" && actor.role === "sudo") {
      const tenantName = request.body.tenantName.trim();
      if (!tenantName || tenantName.length > 200) return problem(reply, 422, "Invalid request", "A valid tenant name is required.");
      requestedTenantId = await store.createTenant(tenantName);
    }
    const tenantId = role === "tenant"
      ? actor.role === "tenant" ? actor.tenantId : requestedTenantId ?? (typeof formKey === "string" ? await store.getTenantIdForForm(formKey) : null)
      : null;
    if (role === "tenant" && !tenantId) return problem(reply, 422, "Invalid request", "A tenant, tenantId, or registered form key is required.");
    try {
      await store.createAdmin(email.trim().toLowerCase(), await hashPassword(password), role as AdminRole, tenantId);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        return problem(reply, 409, "Conflict", "This email already has an account.");
      }
      throw error;
    }
    return reply.code(201).send({ email: email.trim().toLowerCase(), role, tenantId });
  });

  app.post("/v1/admin/password", async (request, reply) => {
    if (!sameOrigin(request)) return problem(reply, 403, "Forbidden", "Invalid origin.");
    const actor = await adminFor(request);
    if (!actor || actor.id === "service-key") return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (!passwordLimiter.check(actor.id).allowed) return problem(reply, 429, "Too many attempts", "Try again later.");
    if (!assertPlainObject(request.body) || typeof request.body.currentPassword !== "string" || typeof request.body.newPassword !== "string" ||
      request.body.newPassword.length < 8 || request.body.newPassword.length > 256) {
      return problem(reply, 422, "Invalid request", "Current password and a new password of at least 8 characters are required.");
    }
    const account = await store.getAdminByEmail(actor.email);
    if (!account || !(await verifyPassword(request.body.currentPassword, account.passwordHash))) {
      return problem(reply, 401, "Unauthorized", "Current password is incorrect.");
    }
    await store.updateAdminPassword(actor.id, await hashPassword(request.body.newPassword));
    return { ok: true };
  });

  app.get("/v1/admin/tenants", async (request, reply) => {
    const actor = await adminFor(request);
    if (!actor) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (actor.role === "tenant") return problem(reply, 403, "Forbidden", "Tenant management requires a super or sudo admin.");
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success || (parsed.data.status && !["active", "inactive"].includes(parsed.data.status))) return problem(reply, 400, "Invalid filters", "Use valid pagination and active/inactive status.");
    const result = await store.managementPage("tenants", parsed.data);
    return { tenants: result.items, pagination: result.pagination };
  });

  app.get("/v1/admin/forms", async (request, reply) => {
    const actor = await adminFor(request);
    if (!actor) return problem(reply, 401, "Unauthorized", "Sign in required.");
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success || (parsed.data.status && !["active", "disabled"].includes(parsed.data.status))) return problem(reply, 400, "Invalid filters", "Use valid pagination and active/disabled status.");
    if (actor.role === "tenant") parsed.data.tenantId = actor.tenantId!;
    const result = await store.managementPage("forms", parsed.data);
    return { forms: result.items, pagination: result.pagination };
  });

  app.get("/v1/admin/analytics", async (request, reply) => {
    const actor = await adminFor(request);
    if (!actor) return problem(reply, 401, "Unauthorized", "Sign in required.");
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return problem(reply, 400, "Invalid filters", "Use valid tenant and ISO date filters.");
    const tenantId = actor.role === "tenant" ? actor.tenantId! : parsed.data.tenantId;
    return store.analytics(tenantId, parsed.data.from, parsed.data.to);
  });

  app.get<{ Params: { tenantId: string } }>("/v1/admin/tenants/:tenantId", async (request, reply) => {
    const actor = await adminFor(request);
    if (!actor) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (!z.string().uuid().safeParse(request.params.tenantId).success) return problem(reply, 400, "Invalid tenant", "Tenant ID must be a UUID.");
    if (actor.role === "tenant" && actor.tenantId !== request.params.tenantId) return problem(reply, 404, "Not found", "Tenant not found.");
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success || (parsed.data.status && !["active", "disabled"].includes(parsed.data.status))) return problem(reply, 400, "Invalid filters", "Invalid form filters.");
    const tenantId = request.params.tenantId;
    const tenants = await store.managementPage("tenants", { page: 1, limit: 1, q: "", sort: "newest", tenantId });
    if (!tenants.items.length) return problem(reply, 404, "Not found", "Tenant not found.");
    const forms = await store.managementPage("forms", { ...parsed.data, tenantId });
    return { tenant: tenants.items[0], forms: forms.items, pagination: forms.pagination };
  });

  app.post("/v1/admin/tenants", async (request, reply) => {
    const actor = await adminFor(request);
    if (!actor) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (actor.id !== "service-key" && !sameOrigin(request)) return problem(reply, 403, "Forbidden", "Invalid origin.");
    if (actor.role === "tenant") return problem(reply, 403, "Forbidden", "Tenant management requires a super or sudo admin.");
    const parsed = z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email().max(254).transform(v => v.toLowerCase()), password: z.string().min(8).max(256) }).safeParse(request.body);
    if (!parsed.success) return problem(reply, 422, "Invalid tenant", "Name, valid email, and an 8–256 character password are required.");
    try {
      const account = await store.createSiteAccount(parsed.data.name, parsed.data.email, await hashPassword(parsed.data.password));
      return reply.code(201).send({ ...account, name: parsed.data.name, email: parsed.data.email });
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && error.code === "23505") return problem(reply, 409, "Conflict", "This email already has an account.");
      throw error;
    }
  });

  app.post<{ Params: { tenantId: string } }>("/v1/admin/tenants/:tenantId/password", async (request, reply) => {
    const actor = await adminFor(request);
    if (!actor) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (actor.id !== "service-key" && !sameOrigin(request)) return problem(reply, 403, "Forbidden", "Invalid origin.");
    if (actor.role === "tenant") return problem(reply, 403, "Forbidden", "Use the current-password flow for your own account.");
    const parsed = z.object({ email: z.string().trim().email().transform(v => v.toLowerCase()), newPassword: z.string().min(8).max(256) }).safeParse(request.body);
    if (!parsed.success || !z.string().uuid().safeParse(request.params.tenantId).success) return problem(reply, 422, "Invalid request", "Valid tenant, email, and 8–256 character password required.");
    const account = await store.getAdminByEmail(parsed.data.email);
    if (!account || account.role !== "tenant" || account.tenantId !== request.params.tenantId) return problem(reply, 404, "Not found", "Tenant account not found.");
    await store.updateAdminPassword(account.id, await hashPassword(parsed.data.newPassword));
    return { ok: true };
  });

  app.patch<{ Params: { tenantId: string } }>("/v1/admin/tenants/:tenantId", async (request, reply) => {
    if (!sameOrigin(request)) return problem(reply, 403, "Forbidden", "Invalid origin.");
    const actor = await adminFor(request);
    if (!actor) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (actor.role === "tenant") return problem(reply, 403, "Forbidden", "Tenant management requires a super or sudo admin.");
    if (!assertPlainObject(request.body)) return problem(reply, 400, "Invalid request", "Permission limits are required.");
    const keys = ["maxOriginsPerForm", "maxForms", "maxTotalSubmissions", "maxDailySubmissions"] as const;
    const limitBody = request.body as JsonObject;
    const limits = Object.fromEntries(keys.map((key) => [key, Number(limitBody[key])])) as unknown as TenantLimits;
    if (!z.string().uuid().safeParse(request.params.tenantId).success || keys.some((key) => !Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > 2147483647)) {
      return problem(reply, 422, "Invalid request", "All limits must be positive integers.");
    }
    if (!(await store.updateTenantLimits(request.params.tenantId, limits))) return problem(reply, 404, "Not found", "Tenant not found.");
    return { tenantId: request.params.tenantId, ...limits };
  });

  app.post("/v1/admin/forms", async (request, reply) => {
    const admin = await adminFor(request);
    if (!admin) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (admin.id !== "service-key" && !sameOrigin(request)) return problem(reply, 403, "Forbidden", "Invalid origin.");
    const body = assertPlainObject(request.body) && Array.isArray(request.body.allowedOrigins)
      ? {
          ...request.body,
          allowedOrigins: request.body.allowedOrigins.map((origin) =>
            typeof origin === "string" ? normalizeExactOrigin(origin) ?? origin : origin)
        }
      : request.body;
    if (!validateCreateForm(body)) {
      return problem(reply, 422, "Validation failed", "Form definition is invalid.", {
        errors: validationErrors(validateCreateForm.errors)
      });
    }
    // Tenant admins may add forms, but only to the tenant attached to their
    // account. Never trust a tenant id supplied by a browser session.
    const input: CreateFormInput = admin.role === "tenant"
      ? { ...(body as CreateFormInput), tenantId: admin.tenantId ?? undefined }
      : body as CreateFormInput;
    for (const origin of input.allowedOrigins) {
      if (!isAllowedOrigin(origin, [origin])) {
        return problem(reply, 422, "Validation failed", "Allowed origins must be exact HTTP or HTTPS origins.");
      }
    }
    for (const destination of input.destinations ?? []) {
      if (destination.kind === "webhook" && !isSafeWebhookUrl(destination.config.url)) {
        return problem(reply, 422, "Validation failed", "Webhook destinations require a safe HTTPS URL.");
      }
      if (destination.kind === "webhook" && (!destination.secret || destination.secret.length < 24)) return problem(reply, 422, "Validation failed", "Webhooks require a signing secret of at least 24 characters.");
      if (destination.kind === "email" && !z.string().email().safeParse(destination.config.to).success) return problem(reply, 422, "Validation failed", "Email destinations require a valid recipient.");
    }
    if (!schemaAjv.validateSchema(input.schema)) {
      return problem(reply, 422, "Validation failed", "JSON Schema is invalid.", {
        errors: validationErrors(schemaAjv.errors)
      });
    }

    if (input.tenantId) {
      const usage = await store.getTenantLimits(input.tenantId);
      if (!usage) return problem(reply, 404, "Not found", "Tenant not found.");
      if (input.allowedOrigins.length > usage.maxOriginsPerForm) {
        return problem(reply, 422, "Tenant limit reached", `This tenant allows at most ${usage.maxOriginsPerForm} origins per form.`);
      }
      if (usage.formCount >= usage.maxForms) {
        return problem(reply, 422, "Tenant limit reached", `This tenant allows at most ${usage.maxForms} forms.`);
      }
    }

    const publicKey = newPublicKey();
    const form = await store.createForm(input, publicKey);
    return reply.code(201).send({
      id: form.id,
      tenantId: form.tenantId,
      publicKey: form.publicKey,
      submitUrl: `${config.PUBLIC_BASE_URL}/v1/forms/${form.publicKey}/submissions`
    });
  });

  app.get<{ Params: { publicKey: string } }>("/v1/forms/:publicKey", async (request, reply) => {
    const form = await store.getActiveForm(request.params.publicKey);
    if (!form) return problem(reply, 404, "Not found", "Form not found or disabled.");
    if (!isAllowedOrigin(request.headers.origin, form.allowedOrigins)) {
      return problem(reply, 403, "Forbidden", "Origin is not allowed for this form.");
    }
    applyCors(reply, request.headers.origin);
    return {
      publicKey: form.publicKey,
      name: form.name,
      version: form.version,
      schema: form.schema,
      honeypotField: form.honeypotField,
      submitUrl: `${config.PUBLIC_BASE_URL}/v1/forms/${form.publicKey}/submissions`
    };
  });

  app.get("/v1/admin/forms/summary", async (request, reply) => {
    const admin = await adminFor(request);
    if (!admin) {
      return problem(reply, 401, "Unauthorized", "Missing or invalid admin token.");
    }
    reply.header("Cache-Control", "no-store");
    const forms = await store.listFormSummaries();
    return { forms: admin.role === "tenant" ? forms.filter((form) => form.tenantId === admin.tenantId) : forms };
  });

  app.patch<{ Params: { publicKey: string } }>("/v1/admin/forms/:publicKey", async (request, reply) => {
    const admin = await adminFor(request);
    if (!admin) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (!sameOrigin(request) && admin.id !== "service-key") return problem(reply, 403, "Forbidden", "Invalid origin.");
    const tenantId = await store.getTenantIdForForm(request.params.publicKey);
    if (!tenantId || (admin.role === "tenant" && tenantId !== admin.tenantId)) {
      return problem(reply, 404, "Not found", "Form not found.");
    }
    if (!assertPlainObject(request.body)) return problem(reply, 400, "Invalid request", "Form changes are required.");
    const changes: Partial<Pick<CreateFormInput, "name" | "allowedOrigins" | "successMessage" | "schema">> & { status?: "active" | "disabled" } = {};
    if (request.body.status !== undefined) {
      if (!["active", "disabled"].includes(String(request.body.status))) return problem(reply, 422, "Invalid request", "Status must be active or disabled.");
      changes.status = request.body.status as "active" | "disabled";
    }
    if (request.body.name !== undefined) {
      if (typeof request.body.name !== "string" || !request.body.name.trim() || request.body.name.length > 200) return problem(reply, 422, "Invalid request", "A valid form name is required.");
      changes.name = request.body.name.trim();
    }
    if (request.body.successMessage !== undefined) {
      if (typeof request.body.successMessage !== "string" || !request.body.successMessage.trim() || request.body.successMessage.length > 500) return problem(reply, 422, "Invalid request", "A valid success message is required.");
      changes.successMessage = request.body.successMessage.trim();
    }
    if (request.body.allowedOrigins !== undefined) {
      if (!Array.isArray(request.body.allowedOrigins) || !request.body.allowedOrigins.length || request.body.allowedOrigins.length > 50) return problem(reply, 422, "Invalid request", "At least one allowed origin is required.");
      const origins = request.body.allowedOrigins.map((value) => typeof value === "string" ? normalizeExactOrigin(value) : null);
      if (origins.some((value) => !value)) return problem(reply, 422, "Invalid request", "Allowed origins must be exact HTTP or HTTPS origins.");
      const limits = await store.getTenantLimits(tenantId);
      if (limits && origins.length > limits.maxOriginsPerForm) return problem(reply, 422, "Tenant limit reached", `This tenant allows at most ${limits.maxOriginsPerForm} origins per form.`);
      changes.allowedOrigins = origins as string[];
    }
    if (request.body.schema !== undefined) {
      if (!assertPlainObject(request.body.schema) || !schemaAjv.validateSchema(request.body.schema)) return problem(reply, 422, "Validation failed", "JSON Schema is invalid.");
      changes.schema = request.body.schema;
    }
    if (!Object.keys(changes).length) return problem(reply, 422, "Invalid request", "No supported form changes were supplied.");
    const form = await store.updateForm(request.params.publicKey, changes);
    return { publicKey: request.params.publicKey, form };
  });

  app.post<{ Params: { publicKey: string } }>("/v1/forms/:publicKey/submissions", async (request, reply) => {
    const form = await store.getActiveForm(request.params.publicKey);
    if (!form) return problem(reply, 404, "Not found", "Form not found or disabled.");
    if (!isAllowedOrigin(request.headers.origin, form.allowedOrigins)) {
      return problem(reply, 403, "Forbidden", "Origin is not allowed for this form.");
    }
    const usage = await store.getTenantLimits(form.tenantId);
    if (usage && (usage.totalSubmissions >= usage.maxTotalSubmissions || usage.dailySubmissions >= usage.maxDailySubmissions)) {
      return problem(reply, 429, "Submission limit reached", "This workspace has reached its submission allowance.");
    }
    applyCors(reply, request.headers.origin);

    const turnstileToken = firstHeader(request.headers["turnstile-token"]);
    if (!(await verifyTurnstile(config.TURNSTILE_SECRET_KEY, turnstileToken, request.ip))) {
      return problem(reply, 403, "Forbidden", "Bot verification failed.");
    }

    const ipHash = hashIp(request.ip, config.DATA_ENCRYPTION_KEY);
    const limited = limiter.check(`${form.publicKey}:${ipHash}`);
    if (!limited.allowed) {
      reply.header("Retry-After", limited.retryAfterSeconds);
      return problem(reply, 429, "Rate limit exceeded", "Too many submissions for this form.");
    }

    const idempotencyKey = firstHeader(request.headers["idempotency-key"]);
    if (idempotencyKey && !isValidIdempotencyKey(idempotencyKey)) {
      return problem(reply, 400, "Malformed request", "Invalid idempotency key.");
    }
    if (!assertPlainObject(request.body)) {
      return problem(reply, 400, "Malformed request", "Submission body must be a JSON object.");
    }

    const payload = { ...request.body };
    const spam = typeof payload[form.honeypotField] === "string" && payload[form.honeypotField] !== "";
    delete payload[form.honeypotField];

    const validatePayload = schemaAjv.compile(form.schema);
    if (!validatePayload(payload)) {
      return problem(reply, 422, "Validation failed", "Submission fields are invalid.", {
        errors: validationErrors(validatePayload.errors)
      });
    }

    const expiresAt = new Date(Date.now() + config.RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const accessToken = newSubmissionAccessToken();
    const result = await store.createSubmission({
      form,
      payload,
      status: spam ? "spam" : "accepted",
      sourceOrigin: request.headers.origin,
      sourceIpHash: ipHash,
      idempotencyKey,
      accessTokenHash: hashSubmissionAccessToken(accessToken),
      expiresAt
    });
    const response = {
      status: result.submission.status,
      message: form.successMessage,
      ...(!result.duplicate && {
        submissionId: result.submission.id,
        responseUrl: `${config.PUBLIC_BASE_URL}/v1/submissions/${result.submission.id}`,
        responseToken: accessToken
      })
    };
    return reply.code(result.duplicate ? 200 : 202).send(response);
  });

  app.get<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId", async (request, reply) => {
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" && authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return problem(reply, 401, "Unauthorized", "A valid response token is required.");
    }
    const result = await store.getSubmissionByAccessToken(
      request.params.submissionId,
      hashSubmissionAccessToken(token)
    );
    if (!result) return problem(reply, 404, "Not found", "Submission not found or expired.");
    if (!isAllowedOrigin(request.headers.origin, result.allowedOrigins)) {
      return problem(reply, 403, "Forbidden", "Origin is not allowed for this form.");
    }
    applyCors(reply, request.headers.origin);
    reply.header("Cache-Control", "no-store");
    return {
      id: result.submission.id,
      status: result.submission.status,
      payload: result.submission.payload,
      createdAt: result.submission.createdAt
    };
  });

  app.get<{ Params: { publicKey: string }; Querystring: { limit?: string } }>(
    "/v1/admin/forms/:publicKey/submissions",
    async (request, reply) => {
      const admin = await adminFor(request);
      if (!admin) {
        return problem(reply, 401, "Unauthorized", "Missing or invalid admin token.");
      }
      const tenantId = await store.getTenantIdForForm(request.params.publicKey);
      if (!tenantId || (admin.role === "tenant" && tenantId !== admin.tenantId)) {
        return problem(reply, 404, "Not found", "Form not found.");
      }
      const parsed = listQuery.safeParse(request.query);
      if (!parsed.success || (parsed.data.status && !["accepted", "spam"].includes(parsed.data.status))) return problem(reply, 400, "Invalid filters", "Use valid pagination, dates, and accepted/spam status.");
      reply.header("Cache-Control", "no-store");
      const result = await store.managementPage("submissions", { ...parsed.data, tenantId }, request.params.publicKey);
      return { submissions: result.items, pagination: result.pagination };
    }
  );

  app.patch<{ Params: { submissionId: string } }>("/v1/admin/submissions/:submissionId", async (request, reply) => {
    if (!sameOrigin(request)) return problem(reply, 403, "Forbidden", "Invalid origin.");
    const admin = await adminFor(request);
    if (!admin) return problem(reply, 401, "Unauthorized", "Sign in required.");
    if (admin.role !== "sudo") return problem(reply, 403, "Forbidden", "Only sudo admins can edit submissions.");
    if (!assertPlainObject(request.body) || !assertPlainObject(request.body.payload) ||
      !["accepted", "spam", "deleted"].includes(String(request.body.status))) {
      return problem(reply, 422, "Invalid request", "A JSON payload and valid status are required.");
    }
    const updated = await store.updateSubmission(request.params.submissionId, request.body.payload, request.body.status as "accepted" | "spam" | "deleted");
    if (!updated) return problem(reply, 404, "Not found", "Submission not found.");
    return { ok: true };
  });

  return app;
}
