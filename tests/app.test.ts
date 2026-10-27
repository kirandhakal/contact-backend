import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AuthEmailMessage } from "../src/auth-email.js";
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
  AuthChallenge,
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
  SMTP_TIMEOUT_MS: 30000,
  TURNSTILE_SECRET_KEY: "",
  MAIL_HOST: "",
  MAIL_PORT: 587,
  MAIL_AUTH: true,
  MAIL_USERNAME: "",
  MAIL_USER: "",
  MAIL_PASSWORD: "",
  MAIL_PASS: "",
  MAIL_FROM: "",
  ENABLE_EMAIL: true,
  ENABLE_SMS: true,
  ENABLE_WHATSAPP: true,
  ENABLE_DISCORD: true,
  ENABLE_WEBHOOK: true,
  ENABLE_MAIL: true,
  TRUST_PROXY: false,
  OTP_EXPIRY_SECONDS: 300,
  OTP_RESEND_SECONDS: 60,
  OTP_MAX_ATTEMPTS: 5,
  AUTH_RESET_TOKEN_TTL_SECONDS: 600,
  AUTH_MIN_RESPONSE_MS: 0
} as any;

class MemoryStore implements Store {
  siteContacts = new Map<string, import("../src/types.js").SiteContactMessage>();
  async saveSiteContact(input: { name: string; email: string; message: string }, key: string) {
    if (!this.siteContacts.has(key)) this.siteContacts.set(key, { id: randomUUID(), name: input.name, email: input.email, message: input.message, createdAt: new Date().toISOString() });
  }
  async listSiteContacts(page: number, limit: number) { return { messages: [...this.siteContacts.values()].slice((page - 1) * limit, page * limit), total: this.siteContacts.size }; }
  async deleteSiteContact(id: string) { for (const [key, item] of this.siteContacts) if (item.id === id) return this.siteContacts.delete(key); return false; }

  async findReplySubmissions(key: string) { return this.submissions.filter(s => s.formId === this.forms.get(key)?.id && s.status === "accepted").map(s => s.id); }
  async queueReplies(_key: string, ids: string[], destinations: string[], _message: string, _requestId: string) { return ids.length * destinations.length; }
  async deliveryStatus() { return []; }
  destinations = new Map<string, import("../src/types.js").DestinationRecord[]>();
  async getFormDestinations(key: string) { return this.destinations.get(key) ?? []; }
  loginStates = new Map<string, import("../src/login-lockout.js").LoginState>();
  async withLoginState<T>(key: string, action: (state: import("../src/login-lockout.js").LoginState) => Promise<T>): Promise<T> {
    const state = this.loginStates.get(key) ?? { failures: 0, level: 0, lockedUntil: 0 };
    this.loginStates.set(key, state);
    return action(state);
  }

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

  authChallenges = new Map<string, AuthChallenge & { otpHash: string; maxAttempts: number; attempts: number; lockedUntil: Date | null; resetTokenHash: string | null; resetTokenExpiresAt: Date | null; resetConsumedAt: Date | null }>();
  pendingSignups = new Map<string, { id: string; workspaceName: string; passwordHash: string; phone: string | null; expiresAt: Date }>();
  authRateLimits = new Map<string, { count: number; expiresAt: Date }>();
  authEmails: AuthEmailMessage[] = [];

  async checkAuthRateLimit(key: string, windowSeconds: number, max: number, now: Date) {
    let entry = this.authRateLimits.get(key);
    if (!entry || entry.expiresAt <= now) {
      entry = { count: 0, expiresAt: new Date(now.getTime() + windowSeconds * 1000) };
      this.authRateLimits.set(key, entry);
    }
    entry.count += 1;
    const allowed = entry.count <= max;
    return { allowed, retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((entry.expiresAt.getTime() - now.getTime()) / 1000)) };
  }

  async startSignupChallenge(input: import("../src/types.js").StartSignupChallengeInput) {
    const active = [...this.authChallenges.values()].find((challenge) => challenge.email === input.email && challenge.purpose === "signup" && !challenge.consumedAt && challenge.expiresAt > input.now);
    if (active && active.resendAvailableAt > input.now) {
      return { challengeId: active.id, expiresAt: active.expiresAt, resendAvailableAt: active.resendAvailableAt,
        shouldSend: false, eligible: Boolean(active.pendingSignupId) && !this.admins.has(input.email) };
    }
    for (const challenge of this.authChallenges.values()) if (challenge.email === input.email && challenge.purpose === "signup" && !challenge.consumedAt) challenge.consumedAt = input.now;
    const challenge: AuthChallenge & { otpHash: string; maxAttempts: number; attempts: number; lockedUntil: Date | null; resetTokenHash: string | null; resetTokenExpiresAt: Date | null; resetConsumedAt: Date | null } = {
      id: input.challengeId, purpose: "signup", email: input.email, pendingSignupId: null, adminId: null,
      expiresAt: input.expiresAt, resendAvailableAt: input.resendAvailableAt, consumedAt: null, otpHash: input.otpHash,
      maxAttempts: input.maxAttempts, attempts: 0, lockedUntil: null, resetTokenHash: null, resetTokenExpiresAt: null, resetConsumedAt: null
    };
    if (this.admins.has(input.email)) {
      this.authChallenges.set(challenge.id, challenge);
      return { challengeId: challenge.id, expiresAt: challenge.expiresAt, resendAvailableAt: challenge.resendAvailableAt, shouldSend: false, eligible: false };
    }
    const existingPending = this.pendingSignups.get(input.email);
    const pending = !existingPending || existingPending.expiresAt <= input.now
      ? { id: randomUUID(), workspaceName: input.workspaceName, passwordHash: input.passwordHash, phone: input.phone ?? null, expiresAt: new Date(input.now.getTime() + 24 * 60 * 60 * 1000) }
      : existingPending;
    this.pendingSignups.set(input.email, pending);
    challenge.pendingSignupId = pending.id;
    this.authChallenges.set(challenge.id, challenge);
    return { challengeId: challenge.id, expiresAt: challenge.expiresAt, resendAvailableAt: challenge.resendAvailableAt, shouldSend: true, eligible: true };
  }

  async startPasswordResetChallenge(input: import("../src/types.js").StartPasswordResetChallengeInput) {
    const active = [...this.authChallenges.values()].find((challenge) => challenge.email === input.email && challenge.purpose === "password_reset" && !challenge.consumedAt && challenge.expiresAt > input.now);
    if (active && active.resendAvailableAt > input.now) {
      return { challengeId: active.id, expiresAt: active.expiresAt, resendAvailableAt: active.resendAvailableAt, shouldSend: false, eligible: Boolean(active.adminId) };
    }
    for (const challenge of this.authChallenges.values()) if (challenge.email === input.email && challenge.purpose === "password_reset" && !challenge.consumedAt) challenge.consumedAt = input.now;
    const admin = [...this.admins.values()].find((item) => item.email === input.email && item.role === "tenant");
    const challenge: AuthChallenge & { otpHash: string; maxAttempts: number; attempts: number; lockedUntil: Date | null; resetTokenHash: string | null; resetTokenExpiresAt: Date | null; resetConsumedAt: Date | null } = {
      id: input.challengeId, purpose: "password_reset", email: input.email, pendingSignupId: null, adminId: admin?.id ?? null,
      expiresAt: input.expiresAt, resendAvailableAt: input.resendAvailableAt, consumedAt: null, otpHash: input.otpHash,
      maxAttempts: input.maxAttempts, attempts: 0, lockedUntil: null, resetTokenHash: null, resetTokenExpiresAt: null, resetConsumedAt: null
    };
    this.authChallenges.set(challenge.id, challenge);
    return { challengeId: challenge.id, expiresAt: challenge.expiresAt, resendAvailableAt: challenge.resendAvailableAt, shouldSend: Boolean(admin), eligible: Boolean(admin) };
  }

  async getAuthChallenge(challengeId: string) {
    const challenge = this.authChallenges.get(challengeId);
    if (!challenge) return null;
    return { id: challenge.id, purpose: challenge.purpose, email: challenge.email, pendingSignupId: challenge.pendingSignupId,
      adminId: challenge.adminId, expiresAt: challenge.expiresAt, resendAvailableAt: challenge.resendAvailableAt, consumedAt: challenge.consumedAt };
  }

  authCheck(challenge: typeof this.authChallenges extends Map<string, infer T> ? T : never, now: Date): import("../src/types.js").VerifyAuthChallengeResult | null {
    if (challenge.consumedAt) return { status: "invalid", attemptsRemaining: 0, retryAfterSeconds: 0 };
    if (challenge.lockedUntil && challenge.lockedUntil > now) return { status: "locked", attemptsRemaining: 0, retryAfterSeconds: Math.max(1, Math.ceil((challenge.lockedUntil.getTime() - now.getTime()) / 1000)) };
    if (challenge.expiresAt <= now) return { status: "expired", attemptsRemaining: 0, retryAfterSeconds: 0 };
    if (challenge.attempts >= challenge.maxAttempts) {
      challenge.lockedUntil = new Date(now.getTime() + 900 * 1000);
      return { status: "locked", attemptsRemaining: 0, retryAfterSeconds: 900 };
    }
    return null;
  }

  authFailure(challenge: typeof this.authChallenges extends Map<string, infer T> ? T : never, now: Date): import("../src/types.js").VerifyAuthChallengeResult {
    challenge.attempts += 1;
    const remaining = Math.max(0, challenge.maxAttempts - challenge.attempts);
    if (remaining === 0) {
      challenge.lockedUntil = new Date(now.getTime() + 900 * 1000);
      return { status: "locked", attemptsRemaining: 0, retryAfterSeconds: 900 };
    }
    return { status: "invalid", attemptsRemaining: remaining, retryAfterSeconds: 0 };
  }

  async rotateAuthChallenge(input: { challengeId: string; otpHash: string; expiresAt: Date; resendAvailableAt: Date; now: Date }) {
    const challenge = this.authChallenges.get(input.challengeId);
    if (!challenge) return { status: "not_found" as const };
    if (challenge.consumedAt) return { status: "invalid" as const };
    if (challenge.lockedUntil && challenge.lockedUntil > input.now) return { status: "locked" as const, retryAfterSeconds: Math.max(1, Math.ceil((challenge.lockedUntil.getTime() - input.now.getTime()) / 1000)) };
    if (challenge.resendAvailableAt > input.now) return { status: "cooldown" as const, retryAfterSeconds: Math.max(1, Math.ceil((challenge.resendAvailableAt.getTime() - input.now.getTime()) / 1000)) };
    let shouldSend = false;
    if (challenge.purpose === "signup" && challenge.pendingSignupId) {
      const pending = [...this.pendingSignups.values()].find((item) => item.id === challenge.pendingSignupId);
      if (!pending || pending.expiresAt <= input.now) return { status: "expired" as const };
      shouldSend = !this.admins.has(challenge.email);
    } else if (challenge.adminId) {
      shouldSend = [...this.admins.values()].some((admin) => admin.id === challenge.adminId && admin.role === "tenant");
    }
    challenge.otpHash = input.otpHash; challenge.expiresAt = input.expiresAt; challenge.resendAvailableAt = input.resendAvailableAt;
    challenge.attempts = 0; challenge.lockedUntil = null;
    return { status: "ok" as const, email: challenge.email, expiresAt: challenge.expiresAt, resendAvailableAt: challenge.resendAvailableAt, shouldSend };
  }

  async verifySignupChallenge(input: { challengeId: string; otpHash: string; now: Date }) {
    const challenge = this.authChallenges.get(input.challengeId);
    if (!challenge || challenge.purpose !== "signup") return { status: "not_found" as const, attemptsRemaining: 0, retryAfterSeconds: 0 };
    const blocked = this.authCheck(challenge, input.now);
    if (blocked) return blocked;
    if (challenge.otpHash !== input.otpHash) return this.authFailure(challenge, input.now);
    const pending = [...this.pendingSignups.values()].find((item) => item.id === challenge.pendingSignupId);
    if (!pending || pending.expiresAt <= input.now) return { status: "expired" as const, attemptsRemaining: 0, retryAfterSeconds: 0 };
    if (this.admins.has(challenge.email)) return { status: "invalid" as const, attemptsRemaining: 0, retryAfterSeconds: 0 };
    const { tenantId } = await this.createSiteAccount(pending.workspaceName, challenge.email, pending.passwordHash);
    challenge.consumedAt = input.now; challenge.pendingSignupId = null;
    this.pendingSignups.delete(challenge.email);
    return { status: "ok" as const, attemptsRemaining: 0, retryAfterSeconds: 0, tenantId };
  }

  async verifyPasswordResetChallenge(input: { challengeId: string; otpHash: string; resetTokenHash: string; resetTokenExpiresAt: Date; now: Date }) {
    const challenge = this.authChallenges.get(input.challengeId);
    if (!challenge || challenge.purpose !== "password_reset") return { status: "not_found" as const, attemptsRemaining: 0, retryAfterSeconds: 0 };
    const blocked = this.authCheck(challenge, input.now);
    if (blocked) return blocked;
    if (challenge.otpHash !== input.otpHash || !challenge.adminId) return this.authFailure(challenge, input.now);
    const admin = [...this.admins.values()].find((item) => item.id === challenge.adminId && item.role === "tenant");
    if (!admin) return this.authFailure(challenge, input.now);
    challenge.consumedAt = input.now; challenge.resetTokenHash = input.resetTokenHash;
    challenge.resetTokenExpiresAt = input.resetTokenExpiresAt; challenge.resetConsumedAt = null;
    return { status: "ok" as const, attemptsRemaining: 0, retryAfterSeconds: 0, email: admin.email, adminId: admin.id };
  }

  async resetPasswordWithToken(input: { tokenHash: string; passwordHash: string; now: Date }) {
    const challenge = [...this.authChallenges.values()].find((item) => item.resetTokenHash === input.tokenHash && item.resetTokenExpiresAt && item.resetTokenExpiresAt > input.now && !item.resetConsumedAt && item.consumedAt);
    if (!challenge?.adminId) return null;
    const admin = [...this.admins.values()].find((item) => item.id === challenge.adminId);
    if (!admin) return null;
    admin.passwordHash = input.passwordHash;
    for (const [token, id] of this.sessions) if (id === admin.id) this.sessions.delete(token);
    challenge.resetTokenHash = null; challenge.resetConsumedAt = input.now;
    return { email: admin.email, adminId: admin.id };
  }

  async deleteExpiredAuthData(now: Date) {
    let deleted = 0;
    for (const [id, challenge] of this.authChallenges) if (challenge.expiresAt < now || (challenge.consumedAt && challenge.consumedAt < now)) { this.authChallenges.delete(id); deleted += 1; }
    for (const [email, pending] of this.pendingSignups) if (pending.expiresAt < now) { this.pendingSignups.delete(email); deleted += 1; }
    for (const [key, limit] of this.authRateLimits) if (limit.expiresAt < now) { this.authRateLimits.delete(key); deleted += 1; }
    return deleted;
  }

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
    if (input.name) {
      if ([...this.forms.entries()].some(([key, other]) => key !== publicKey && other.tenantId === form.tenantId && other.name === input.name)) {
        throw Object.assign(new Error("duplicate form name"), { code: "23505" });
      }
      form.name = input.name;
    }
    if (input.allowedOrigins) form.allowedOrigins = input.allowedOrigins;
    if (input.successMessage) form.successMessage = input.successMessage;
    if (input.schema) { form.schema = input.schema as JsonObject; form.version += 1; }
    if (input.status) form.status = input.status;
    if (input.destinations) this.destinations.set(publicKey, input.destinations.map(d => ({ ...d, id: randomUUID(), formId: form.id, active: true })));
    return form;
  }
  async getTenantIdForSubmission(submissionId: string) { return this.submissions.find((item) => item.id === submissionId)?.tenantId ?? null; }
  async deleteForm(key: string) {
    const form = this.forms.get(key);
    if (!form) return false;
    this.submissions = this.submissions.filter(s => s.formId !== form.id);
    return this.forms.delete(key);
  }
  async deleteSubmission(id: string) {
    const count = this.submissions.length;
    this.submissions = this.submissions.filter(s => s.id !== id);
    return this.submissions.length !== count;
  }
  async updateSubmission(submissionId: string, payload: JsonObject, status: SubmissionStatus) {
    const item = this.submissions.find((entry) => entry.id === submissionId); if (!item) return false;
    item.payload = payload; item.status = status; return true;
  }

  async ready() {
    return true;
  }

  async createForm(input: CreateFormInput, publicKey: string): Promise<FormRecord> {
    const tenantId = input.tenantId ?? await this.createTenant(input.tenantName);
    if ([...this.forms.values()].some((form) => form.tenantId === tenantId && form.name === input.name)) {
      throw Object.assign(new Error("duplicate form name"), { code: "23505" });
    }
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
    this.destinations.set(publicKey, (input.destinations ?? []).map(d => ({ ...d, id: randomUUID(), formId: form.id, active: true })));
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

function makeApp(store: MemoryStore, appConfig: typeof config = config, now: () => Date = () => new Date()) {
  return buildApp(appConfig, store, {
    now,
    sendAuthEmail: async (message) => { store.authEmails.push(message); }
  });
}

function latestCode(store: MemoryStore, email: string, kind: AuthEmailMessage["kind"]) {
  const message = [...store.authEmails].reverse().find((item) => item.to === email && item.kind === kind);
  if (!message || !("code" in message)) throw new Error(`Missing ${kind} email for ${email}`);
  return message.code;
}

async function completeSignup(app: ReturnType<typeof makeApp>, store: MemoryStore, payload: Record<string, unknown>) {
  const signup = await app.inject({ method: "POST", url: "/v1/auth/signup", headers: { origin: config.PUBLIC_BASE_URL }, payload });
  expect(signup.statusCode).toBe(202);
  const verify = await app.inject({ method: "POST", url: "/v1/auth/signup/verify", headers: { origin: config.PUBLIC_BASE_URL },
    payload: { challengeId: signup.json().challengeId, code: latestCode(store, String(payload.email), "signup_code") } });
  expect(verify.statusCode).toBe(200);
  return { signup, verify };
}

async function createTestForm(store: MemoryStore) {
  const app = makeApp(store);
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
  return { app, body: response.json() as { publicKey: string; tenantId: string; name: string } };
}

describe("contact form API", () => {
  it("returns retry metadata and shares normalized account locks across portals", async () => {
    const store = new MemoryStore(); const app = makeApp(store);
    const headers = { origin: config.PUBLIC_BASE_URL };
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/v1/admin/login", headers, payload: { email: "USER@example.com", password: "wrong", portal: "tenant" } });
    const locked = await app.inject({ method: "POST", url: "/v1/admin/login", headers, payload: { email: " user@example.com ", password: "wrong", portal: "admin" } });
    expect(locked.statusCode).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    expect(locked.json()).toMatchObject({ code: "LOGIN_LOCKED", status: 429 });
    expect((await app.inject({ url: "/" })).json()).toMatchObject({ service: "Contact API", version: "v1" });
    await app.close();
  });
  it("rate-limits a targeted login without locking out other accounts behind the frontend proxy", async () => {
    const store = new MemoryStore(); const app = makeApp(store);
    const headers = { origin: config.PUBLIC_BASE_URL };
    for (let i = 0; i < 4; i++) expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers, payload: { email: "target@example.com", password: "incorrect" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers, payload: { email: "target@example.com", password: "incorrect" } })).statusCode).toBe(429);
    await completeSignup(app, store, { workspaceName: "Other studio", email: "other@example.com", password: "long-valid-password" });
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
    const store = new MemoryStore(); const app = makeApp(store);
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
    const app = makeApp(store);
    await completeSignup(app, store, { workspaceName: "Limited Studio", email: "limited@studio.test", password: "a-secure-password" });
    const tenantId = (await store.getAdminByEmail("limited@studio.test"))?.tenantId as string;
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
    expect(store.forms.get(publicKey)).toEqual(expect.objectContaining({ name: "edited", version: 2,
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
    const app = makeApp(store);
    await completeSignup(app, store, { workspaceName: "Managed Studio", email: "tenant@studio.test", password: "a-secure-password" });
    const tenantId = (await store.getAdminByEmail("tenant@studio.test"))?.tenantId as string;
    await app.inject({ method: "POST", url: "/v1/admin/users", headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` },
      payload: { email: "super@example.com", password: "a-long-super-password", role: "super" } });
    const superLogin = await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "super@example.com", password: "a-long-super-password" } });
    const limits = { maxOriginsPerForm: 3, maxForms: 4, maxTotalSubmissions: 500, maxDailySubmissions: 50 };
    const changed = await app.inject({ method: "PATCH", url: `/v1/admin/tenants/${tenantId}`,
      headers: { origin: config.PUBLIC_BASE_URL, cookie: superLogin.headers["set-cookie"] as string }, payload: limits });
    expect(changed.statusCode).toBe(200);
    expect(await store.getTenantLimits(tenantId)).toEqual(expect.objectContaining(limits));

    const tenantLogin = await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { email: "tenant@studio.test", password: "a-secure-password" } });
    const forbidden = await app.inject({ method: "PATCH", url: `/v1/admin/tenants/${tenantId}`,
      headers: { origin: config.PUBLIC_BASE_URL, cookie: tenantLogin.headers["set-cookie"] as string }, payload: limits });
    expect(forbidden.statusCode).toBe(403);
  });

  it("normalizes trailing slashes in allowed origins but rejects URL paths", async () => {
    const store = new MemoryStore();
    const app = makeApp(store);
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

  it("manages integrations without exposing secrets and preserves credentials on edits", async () => {
    const store = new MemoryStore(); const app = makeApp(store);
    const headers = { authorization: `Bearer ${config.ADMIN_API_KEY}` };
    const created = await app.inject({ method: "POST", url: "/v1/admin/forms", headers, payload: {
      tenantName: "Studio", name: "Contact", allowedOrigins: ["https://example.com"], schema: { type: "object", properties: { name: { type: "string" } } },
      destinations: [{ kind: "discord", config: { template: "Hello {{name}}" }, secret: "https://discord.com/api/webhooks/123/token" }]
    } });
    expect(created.statusCode).toBe(201);
    const path = `/v1/admin/forms/${created.json().publicKey}`;
    expect((await app.inject({ url: `${path}/destinations` })).statusCode).toBe(401);
    const list = await app.inject({ url: `${path}/destinations`, headers });
    expect(list.body).not.toContain("/123/token");
    const destination = list.json().destinations[0];
    expect(destination.hasSecret).toBe(true);
    const updated = await app.inject({ method: "PATCH", url: path, headers, payload: { destinations: [{ id: destination.id, kind: destination.kind, config: { template: "Updated {{name}}" } }] } });
    expect(updated.statusCode).toBe(200);
    expect((await store.getFormDestinations(created.json().publicKey))[0].secret).toBe("https://discord.com/api/webhooks/123/token");
    const publicForm = await app.inject({ url: `/v1/forms/${created.json().publicKey}`, headers: { origin: "https://example.com" } });
    expect(publicForm.body).not.toContain("destinations");
    expect(publicForm.body).not.toContain("/123/token");
    await completeSignup(app, store, { workspaceName: "Other", email: "integrations@example.com", password: "integration-password" });
    const login = await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "integrations@example.com", password: "integration-password" } });
    expect((await app.inject({ url: `${path}/destinations`, headers: { cookie: login.headers["set-cookie"] as string } })).statusCode).toBe(404);
    for (const endpoint of ["test", "replies", "replies/preview"]) {
      expect((await app.inject({ method: "POST", url: `${path}/${endpoint}`, headers: { cookie: login.headers["set-cookie"] as string, origin: config.PUBLIC_BASE_URL }, payload: {} })).statusCode).toBe(404);
    }
    await app.close();
  });
  it("validates dummy submissions without saving, then saves one idempotent test submission", async () => {
    const store = new MemoryStore(); const { app, body } = await createTestForm(store);
    const url = `/v1/admin/forms/${body.publicKey}/test`;
    const headers = { authorization: `Bearer ${config.ADMIN_API_KEY}` };
    const payload = { payload: { name: "Alex Morgan", email: "alex@example.com", topic: "sales", message: "Let’s build something together.", _website: "" }, requestId: randomUUID() };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(200);
    expect(store.submissions).toHaveLength(0);
    expect((await app.inject({ method: "POST", url, headers, payload: { ...payload, payload: { ...payload.payload, email: "invalid" } } })).statusCode).toBe(422);
    for (let i = 0; i < 2; i++) expect((await app.inject({ method: "POST", url, headers, payload: { ...payload, send: true } })).statusCode).toBe(202);
    expect(store.submissions).toHaveLength(1);
    expect(store.submissions[0].payload).not.toHaveProperty("_website");
    expect(store.submissions[0].sourceOrigin).toBe("admin-test");
    await app.close();
  });

  it("rejects missing integrations and unknown template fields in bulk replies", async () => {
    const store = new MemoryStore(); const { app, body } = await createTestForm(store);
    const headers = { authorization: `Bearer ${config.ADMIN_API_KEY}` };
    const form = store.forms.get(body.publicKey)!;
    const destination = { id: randomUUID(), formId: form.id, kind: "email" as const, config: { recipientField: "email", deliveryMode: "manual" }, active: true };
    store.destinations.set(body.publicKey, [destination]);
    const url = `/v1/admin/forms/${body.publicKey}/replies`;
    const payload = { submissionIds: [randomUUID()], destinationIds: [destination.id], message: "Hello {{name}}", requestId: randomUUID() };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers, payload: { ...payload, destinationIds: [randomUUID()] } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url, headers, payload: { ...payload, message: "Hello {{unknown}}" } })).statusCode).toBe(422);
    expect((await app.inject({ method: "POST", url, headers, payload })).json().queued).toBe(1);
    await app.close();
  });
  it("signs up a customer workspace and lets its owner create forms", async () => {
    const store = new MemoryStore();
    const app = makeApp(store);
    const { signup } = await completeSignup(app, store, { workspaceName: "New Studio", email: "owner@studio.test", password: "a-secure-password" });
    expect(signup.json()).toMatchObject({ message: "We've received your request. If the email is eligible, you will receive a verification code shortly." });
    const tenantId = (await store.getAdminByEmail("owner@studio.test"))?.tenantId;
    expect(store.tenants.get(tenantId!)?.name).toBe("new-studio");

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
    expect(created.json().tenantId).toBe(tenantId);
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
    const headers = { cookie, origin: config.PUBLIC_BASE_URL };
    const ownSubmission = await app.inject({ method: "POST", url: `/v1/admin/forms/${body.publicKey}/test`, headers, payload: { payload: { name: "Delete test", email: "delete@example.com", message: "Test message", topic: "sales" }, send: true, requestId: randomUUID() } });
    expect(ownSubmission.statusCode).toBe(202);
    const submissionId = store.submissions[0].id;
    expect((await app.inject({ method: "DELETE", url: `/v1/admin/submissions/${submissionId}`, headers: { origin: config.PUBLIC_BASE_URL } })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: `/v1/admin/submissions/${submissionId}`, headers: { cookie, origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/v1/admin/submissions/${submissionId}`, headers })).statusCode).toBe(200);
    expect(store.submissions).toHaveLength(0);
    expect((await app.inject({ method: "DELETE", url: `/v1/admin/submissions/${submissionId}`, headers })).statusCode).toBe(404);
    const otherSubmission = await app.inject({ method: "POST", url: `/v1/admin/forms/${otherKey}/test`, headers: { authorization: `Bearer ${config.ADMIN_API_KEY}` }, payload: { payload: {}, send: true, requestId: randomUUID() } });
    expect(otherSubmission.statusCode).toBe(202);
    const otherId = otherSubmission.json().submissionId;
    expect((await app.inject({ method: "DELETE", url: `/v1/admin/submissions/${otherId}`, headers })).statusCode).toBe(404);
    expect(store.submissions.some(s => s.id === otherId)).toBe(true);

    expect((await app.inject({ method: "DELETE", url: `/v1/admin/forms/${otherKey}`, headers })).statusCode).toBe(404);
    const disableOwn = await app.inject({
      method: "PATCH", url: `/v1/admin/forms/${body.publicKey}`,
      headers: { cookie, origin: config.PUBLIC_BASE_URL }, payload: { status: "disabled" }
    });
    expect(disableOwn.statusCode).toBe(200);
    const allowed = await app.inject({ method: "GET", url: `/v1/admin/forms/${body.publicKey}/submissions`, headers: { cookie } });
    expect(allowed.statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: `/v1/admin/forms/${body.publicKey}`, headers })).statusCode).toBe(200);
    expect(await store.getForm(body.publicKey)).toBeNull();
  });
  it("creates a form through the admin endpoint", async () => {
    const { body } = await createTestForm(new MemoryStore());
    expect(body.publicKey).toMatch(/^frm_/);
    expect(body.name).toBe("website-contact");
  });

  it("rejects duplicate form names within the same tenant", async () => {
    const store = new MemoryStore();
    const { app, body } = await createTestForm(store);
    const headers = { authorization: `Bearer ${config.ADMIN_API_KEY}`, origin: config.PUBLIC_BASE_URL };
    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/admin/forms",
      headers,
      payload: {
        tenantId: body.tenantId,
        tenantName: "Ignored",
        name: "Website Contact",
        allowedOrigins: ["https://www.example.com"],
        schema: { type: "object", additionalProperties: false, properties: { name: { type: "string" } } }
      }
    });
    expect(duplicate.statusCode).toBe(409);
    await app.close();
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
    const app = makeApp(store, secureConfig);
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


describe("email-verified auth", () => {
  it("keeps signup pending until the correct code is verified", async () => {
    const store = new MemoryStore(); const app = makeApp(store);
    const payload = { workspaceName: "Secure Studio", email: "secure@studio.test", password: "a-secure-password" };
    const signup = await app.inject({ method: "POST", url: "/v1/auth/signup", headers: { origin: config.PUBLIC_BASE_URL }, payload });
    expect(signup.statusCode).toBe(202);
    expect(signup.json()).toMatchObject({ message: "We've received your request. If the email is eligible, you will receive a verification code shortly." });
    expect(await store.getAdminByEmail(payload.email)).toBeNull();
    expect(store.pendingSignups.size).toBe(1);
    expect(store.authEmails.filter((message) => message.kind === "signup_code")).toHaveLength(1);
    const challenge = [...store.authChallenges.values()][0];
    const code = latestCode(store, payload.email, "signup_code");
    expect(challenge.otpHash).not.toContain(code);
    expect(JSON.stringify(challenge)).not.toContain(payload.password);

    const wrong = code === "000000" ? "000001" : "000000";
    const invalid = await app.inject({ method: "POST", url: "/v1/auth/signup/verify", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId: signup.json().challengeId, code: wrong } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "OTP_INVALID", attemptsRemaining: 4 });
    const cooldown = await app.inject({ method: "POST", url: "/v1/auth/signup/resend", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId: signup.json().challengeId } });
    expect(cooldown.statusCode).toBe(429);

    const verify = await app.inject({ method: "POST", url: "/v1/auth/signup/verify", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId: signup.json().challengeId, code } });
    expect(verify.statusCode).toBe(200);
    expect(store.pendingSignups.size).toBe(0);
    expect(await store.getAdminByEmail(payload.email)).toMatchObject({ role: "tenant" });
    const replay = await app.inject({ method: "POST", url: "/v1/auth/signup/verify", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId: signup.json().challengeId, code } });
    expect(replay.statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: payload.email, password: payload.password } })).statusCode).toBe(200);
    await app.close();
  });

  it("returns the same signup response without sending a code for an existing account", async () => {
    const store = new MemoryStore(); const app = makeApp(store);
    await completeSignup(app, store, { workspaceName: "Existing Studio", email: "existing@studio.test", password: "a-secure-password" });
    const before = store.authEmails.length;
    const response = await app.inject({ method: "POST", url: "/v1/auth/signup", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { workspaceName: "Different Studio", email: "existing@studio.test", password: "different-password" } });
    expect(response.statusCode).toBe(202);
    expect(response.json().message).toBe("We've received your request. If the email is eligible, you will receive a verification code shortly.");
    expect(store.authEmails).toHaveLength(before);
    expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "existing@studio.test", password: "a-secure-password" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "existing@studio.test", password: "different-password" } })).statusCode).toBe(401);
    await app.close();
  });

  it("rotates expired signup codes, invalidates old codes, and resends after the cooldown", async () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const store = new MemoryStore(); const app = makeApp(store, config, () => clock);
    const payload = { workspaceName: "Timed Studio", email: "timed@studio.test", password: "a-secure-password" };
    const signup = await app.inject({ method: "POST", url: "/v1/auth/signup", headers: { origin: config.PUBLIC_BASE_URL }, payload });
    const challengeId = signup.json().challengeId as string;
    const firstCode = latestCode(store, payload.email, "signup_code");
    clock = new Date(clock.getTime() + 61_000);
    const resend = await app.inject({ method: "POST", url: "/v1/auth/signup/resend", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId } });
    expect(resend.statusCode).toBe(202);
    const secondCode = latestCode(store, payload.email, "signup_code");
    expect(secondCode).not.toBe(firstCode);
    expect((await app.inject({ method: "POST", url: "/v1/auth/signup/verify", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId, code: firstCode } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/auth/signup/verify", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId, code: secondCode } })).statusCode).toBe(200);

    const other = await app.inject({ method: "POST", url: "/v1/auth/signup", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { workspaceName: "Expired Studio", email: "expired@studio.test", password: "a-secure-password" } });
    clock = new Date(clock.getTime() + 301_000);
    const expired = await app.inject({ method: "POST", url: "/v1/auth/signup/verify", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { challengeId: other.json().challengeId, code: latestCode(store, "expired@studio.test", "signup_code") } });
    expect(expired.statusCode).toBe(400);
    expect(expired.json().code).toBe("OTP_EXPIRED");
    await app.close();
  });

  it("locks a code after five incorrect attempts and then resets password with a single-use token", async () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const store = new MemoryStore(); const app = makeApp(store, config, () => clock);
    await completeSignup(app, store, { workspaceName: "Reset Studio", email: "reset@studio.test", password: "old-password" });
    const login = await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "reset@studio.test", password: "old-password" } });
    const oldCookie = login.headers["set-cookie"] as string;

    const forgot = await app.inject({ method: "POST", url: "/v1/auth/forgot-password", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "reset@studio.test" } });
    expect(forgot.statusCode).toBe(202);
    const challengeId = forgot.json().challengeId as string;
    const code = latestCode(store, "reset@studio.test", "password_reset_code");
    const wrong = code === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= 4; attempt++) {
      const response = await app.inject({ method: "POST", url: "/v1/auth/forgot-password/verify", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId, code: wrong } });
      expect(response.statusCode).toBe(400);
      expect(response.json().attemptsRemaining).toBe(5 - attempt);
    }
    const locked = await app.inject({ method: "POST", url: "/v1/auth/forgot-password/verify", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId, code: wrong } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().code).toBe("OTP_LOCKED");

    clock = new Date(clock.getTime() + 61_000);
    const secondForgot = await app.inject({ method: "POST", url: "/v1/auth/forgot-password", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "reset@studio.test" } });
    expect(secondForgot.statusCode).toBe(202);
    const secondId = secondForgot.json().challengeId as string;
    const secondCode = latestCode(store, "reset@studio.test", "password_reset_code");
    const verified = await app.inject({ method: "POST", url: "/v1/auth/forgot-password/verify", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId: secondId, code: secondCode } });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().token).toBe(verified.json().resetToken);
    const resetToken = verified.json().token as string;

    const reset = await app.inject({ method: "POST", url: "/v1/auth/reset-password", headers: { origin: config.PUBLIC_BASE_URL }, payload: { token: resetToken, password: "new-password", confirmPassword: "new-password" } });
    expect(reset.statusCode).toBe(200);
    expect(store.authEmails.some((message) => message.kind === "password_changed" && message.to === "reset@studio.test")).toBe(true);
    expect((await app.inject({ url: "/v1/admin/me", headers: { cookie: oldCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "reset@studio.test", password: "old-password" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/v1/admin/login", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "reset@studio.test", password: "new-password" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/v1/auth/reset-password", headers: { origin: config.PUBLIC_BASE_URL }, payload: { token: resetToken, password: "third-password" } })).statusCode).toBe(400);
    await app.close();
  });

  it("uses a decoy reset challenge for unknown emails without sending mail", async () => {
    const store = new MemoryStore(); const app = makeApp(store);
    const response = await app.inject({ method: "POST", url: "/v1/auth/forgot-password", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "missing@studio.test" } });
    expect(response.statusCode).toBe(202);
    expect(store.authEmails).toEqual([]);
    expect(store.authChallenges.size).toBe(1);
    const wrong = await app.inject({ method: "POST", url: "/v1/auth/forgot-password/verify", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId: response.json().challengeId, code: "123456" } });
    expect(wrong.statusCode).toBe(400);
    await app.close();
  });

  it("rate-limits signup attempts per client before creating more pending accounts", async () => {
    const store = new MemoryStore(); const app = makeApp(store);
    for (let index = 0; index < 5; index++) {
      const response = await app.inject({ method: "POST", url: "/v1/auth/signup", headers: { origin: config.PUBLIC_BASE_URL },
        payload: { workspaceName: `Studio ${index}`, email: `limited${index}@studio.test`, password: "a-secure-password" } });
      expect(response.statusCode).toBe(202);
    }
    const limited = await app.inject({ method: "POST", url: "/v1/auth/signup", headers: { origin: config.PUBLIC_BASE_URL },
      payload: { workspaceName: "One More", email: "limited-five@studio.test", password: "a-secure-password" } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(store.pendingSignups.size).toBe(5);
    await app.close();
  });

  it("expires reset tokens and rejects malformed or weak reset passwords", async () => {
    let clock = new Date("2026-01-01T00:00:00Z");
    const store = new MemoryStore(); const app = makeApp(store, config, () => clock);
    await completeSignup(app, store, { workspaceName: "Token Studio", email: "token@studio.test", password: "old-password" });
    const forgot = await app.inject({ method: "POST", url: "/v1/auth/forgot-password", headers: { origin: config.PUBLIC_BASE_URL }, payload: { email: "token@studio.test" } });
    const challengeId = forgot.json().challengeId as string;
    const code = latestCode(store, "token@studio.test", "password_reset_code");
    const verified = await app.inject({ method: "POST", url: "/v1/auth/forgot-password/verify", headers: { origin: config.PUBLIC_BASE_URL }, payload: { challengeId, code } });
    const token = verified.json().token as string;
    expect((await app.inject({ method: "POST", url: "/v1/auth/reset-password", headers: { origin: config.PUBLIC_BASE_URL }, payload: { token, password: "short" } })).statusCode).toBe(422);
    clock = new Date(clock.getTime() + 601_000);
    expect((await app.inject({ method: "POST", url: "/v1/auth/reset-password", headers: { origin: config.PUBLIC_BASE_URL }, payload: { token, password: "new-password" } })).statusCode).toBe(400);
    await app.close();
  });
});

describe("website contact inbox", () => {
  it("accepts messages without a tenant form, deduplicates retries, and rejects invalid/spam input", async () => {
    const store = new MemoryStore(); const app = makeApp(store);
    try {
      const headers = { origin: config.PUBLIC_BASE_URL, "idempotency-key": randomUUID() };
      const payload = { name: "Alex", email: "alex@example.com", message: "Please help me get started.", _website: "" };
      for (let i = 0; i < 2; i++) expect((await app.inject({ method: "POST", url: "/v1/site-contact", headers, payload })).statusCode).toBe(202);
      expect(store.siteContacts.size).toBe(1); expect(store.forms.size).toBe(0); expect(store.submissions).toEqual([]);
      expect((await app.inject({ method: "POST", url: "/v1/site-contact", headers, payload: { ...payload, email: "invalid" } })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/v1/site-contact", headers: { ...headers, origin: "https://evil.example" }, payload })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/v1/site-contact", headers: { origin: config.PUBLIC_BASE_URL }, payload })).statusCode).toBe(422);
      expect((await app.inject({ method: "POST", url: "/v1/site-contact", headers: { ...headers, "idempotency-key": randomUUID() }, payload: { ...payload, _website: "spam" } })).statusCode).toBe(202);
      expect(store.siteContacts.size).toBe(1);
    } finally { await app.close(); }
  });
  it("permits only super/sudo admins to read and delete messages, with pagination and origin checks", async () => {
    const store = new MemoryStore(); const app = makeApp(store);
    const { hashSessionToken } = await import("../src/admin-auth.js");
    try {
      await store.saveSiteContact({ name: "Private", email: "private@example.com", message: "An admin-only message" }, randomUUID());
      const id = [...store.siteContacts.values()][0].id;
      expect((await app.inject({ url: "/v1/admin/site-contact" })).statusCode).toBe(401);
      expect((await app.inject({ method: "DELETE", url: `/v1/admin/site-contact/${id}` })).statusCode).toBe(401);
      for (const role of ["tenant", "super", "sudo"] as const) {
        const token = (role === "tenant" ? "t" : role === "super" ? "s" : "u").repeat(43);
        await store.createAdmin(role + "@example.com", "unused", role, role === "tenant" ? randomUUID() : null);
        await store.createAdminSession(store.admins.get(role + "@example.com")!.id, hashSessionToken(token));
        const headers = { cookie: `contact_admin=${token}`, origin: config.PUBLIC_BASE_URL };
        const response = await app.inject({ url: "/v1/admin/site-contact?limit=1", headers });
        expect(response.statusCode).toBe(role === "tenant" ? 403 : 200);
        if (role === "tenant") expect((await app.inject({ method: "DELETE", url: `/v1/admin/site-contact/${id}`, headers })).statusCode).toBe(403);
        else {
          expect(response.json().messages[0].message).toBe("An admin-only message");
          expect(response.headers["cache-control"]).toBe("no-store");
          expect((await app.inject({ url: "/v1/admin/site-contact?page=2&limit=1", headers })).json().messages).toEqual([]);
          expect((await app.inject({ url: "/v1/admin/site-contact?page=0", headers })).statusCode).toBe(422);
          expect((await app.inject({ method: "DELETE", url: `/v1/admin/site-contact/${id}`, headers: { ...headers, origin: "https://evil.example" } })).statusCode).toBe(403);
        }
      }
      const headers = { authorization: `Bearer ${config.ADMIN_API_KEY}`, origin: config.PUBLIC_BASE_URL };
      expect((await app.inject({ method: "DELETE", url: `/v1/admin/site-contact/${id}`, headers })).statusCode).toBe(200);
      expect(store.siteContacts.size).toBe(0);
    } finally { await app.close(); }
  });
  it("rate limits website messages", async () => {
    const app = makeApp(new MemoryStore(), { ...config, RATE_LIMIT_MAX: 1 });
    try {
      const request = { method: "POST" as const, url: "/v1/site-contact", headers: { origin: config.PUBLIC_BASE_URL, "idempotency-key": randomUUID() }, payload: { name: "Alex", email: "alex@example.com", message: "Please help me get started." } };
      expect((await app.inject(request)).statusCode).toBe(202);
      const limited = await app.inject(request); expect(limited.statusCode).toBe(429); expect(limited.headers["retry-after"]).toBeDefined();
    } finally { await app.close(); }
  });
});
