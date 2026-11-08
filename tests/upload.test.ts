import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import type { CreateFormInput, FormRecord, Store } from "../src/types.js";

const uploadFile = vi.hoisted(() => vi.fn(async () => ({ objectKey: "uploads/tenant/form/file.png", url: "https://objectstorage.example/n/ns/b/bucket/o/file.png" })));
const deleteFile = vi.hoisted(() => vi.fn(async () => undefined));
const downloadFile = vi.hoisted(() => vi.fn(async () => ({ body: Buffer.from("png"), contentType: "image/png" })));

vi.mock("../src/storage.js", () => ({
  uploadFile,
  deleteFile,
  downloadFile,
  buildObjectKey: (tenantId: string, formId: string, filename: string) => `uploads/${tenantId}/${formId}/${filename}`
}));

import { buildApp } from "../src/app.js";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const config = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3000,
  DATABASE_URL: "postgres://unused",
  ADMIN_API_KEY: "0123456789abcdef01234567",
  DATA_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  PUBLIC_BASE_URL: "http://localhost:3000",
  MAX_BODY_BYTES: 4096,
  MAX_FILE_SIZE_MB: 1,
  MAX_FILES_PER_REQUEST: 1,
  UPLOAD_PENDING_TTL_SECONDS: 3600,
  MAX_TENANT_STORAGE_MB: 1024,
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
  ENABLE_SLACK: true,
  ENABLE_WEBHOOK: true,
  ENABLE_MAIL: true,
  TRUST_PROXY: false,
  OTP_EXPIRY_SECONDS: 300,
  OTP_RESEND_SECONDS: 60,
  OTP_MAX_ATTEMPTS: 5,
  AUTH_RESET_TOKEN_TTL_SECONDS: 600,
  AUTH_MIN_RESPONSE_MS: 0
} as AppConfig;

class MemoryStore implements Partial<Store> {
  forms = new Map<string, FormRecord>();
  async getActiveForm(publicKey: string) {
    const form = this.forms.get(publicKey);
    return form?.status === "active" ? form : null;
  }
  async getForm(publicKey: string) {
    return this.forms.get(publicKey) ?? null;
  }
  async createForm(input: CreateFormInput, publicKey: string): Promise<FormRecord> {
    const form: FormRecord = {
      id: randomUUID(),
      publicKey,
      tenantId: input.tenantId ?? randomUUID(),
      name: input.name,
      status: "active",
      schema: input.schema as FormRecord["schema"],
      allowedOrigins: input.allowedOrigins,
      honeypotField: input.honeypotField ?? "_website",
      successMessage: input.successMessage ?? "Thanks",
      version: 1,
      uploadConfig: input.uploadConfig ?? {}
    };
    this.forms.set(publicKey, form);
    return form;
  }
  async getTenantLimits() { return null; }
  uploads = new Map<string, import("../src/types.js").UploadRecord>();
  async createUpload(input: import("../src/types.js").CreateUploadInput) {
    const upload: import("../src/types.js").UploadRecord = {
      id: randomUUID(), tenantId: input.tenantId, formId: input.formId, objectKey: input.objectKey, url: input.url,
      originalFilename: input.originalFilename, mimeType: input.mimeType, sizeBytes: input.sizeBytes,
      status: "pending", submissionId: undefined, fieldKey: undefined, createdAt: new Date().toISOString(), expiresAt: input.expiresAt.toISOString()
    };
    this.uploads.set(upload.id, upload);
    return upload;
  }
  async getUpload(uploadId: string) { return this.uploads.get(uploadId) ?? null; }
  async getUploadForForm(uploadId: string, formId: string) { const upload = this.uploads.get(uploadId); return upload && upload.formId === formId ? upload : null; }
  async listUploadsForSubmission(submissionId: string) { return [...this.uploads.values()].filter(u => u.submissionId === submissionId && u.status === "attached"); }
  async getTenantStorageBytes(tenantId: string) { return [...this.uploads.values()].filter(u => u.tenantId === tenantId && u.status !== "deleted").reduce((sum, u) => sum + u.sizeBytes, 0); }
  async deleteExpiredUploads(now: Date) { const expired = [...this.uploads.values()].filter(u => u.status === "pending" && new Date(u.expiresAt) <= now); for (const u of expired) u.status = "deleted"; return expired; }
}

function multipartPayload(filename: string, mimetype: string, content: Buffer) {
  const boundary = "----contactuploadboundary";
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`
  );
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, origin: "https://example.com" },
    payload: Buffer.concat([preamble, content, ending])
  };
}

describe("media upload endpoints", () => {
  beforeEach(() => {
    uploadFile.mockReset();
    deleteFile.mockReset();
    uploadFile.mockResolvedValue({ objectKey: "uploads/tenant/form/file.png", url: "https://objectstorage.example/n/ns/b/bucket/o/file.png" });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function seededApp(overrides: Partial<AppConfig> = {}) {
    const store = new MemoryStore() as unknown as Store & MemoryStore;
    const form = await store.createForm({
      tenantName: "Upload tenant",
      name: "Upload form",
      allowedOrigins: ["https://example.com"],
      schema: { type: "object", properties: { attachment: { type: "string", format: "uri" } } },
      honeypotField: "_website",
      successMessage: "ok"
    }, "upload-form-key");
    const app = buildApp({ ...config, ...overrides }, store);
    return { app, form, store };
  }

  it("accepts a small PNG larger than MAX_BODY_BYTES via the public upload route", async () => {
    const { app, form, store } = await seededApp();
    // Magic-byte check only needs a valid PNG header; pad to exceed the JSON bodyLimit.
    const padded = Buffer.concat([PNG_1X1, Buffer.alloc(config.MAX_BODY_BYTES)]);
    expect(padded.length).toBeGreaterThan(config.MAX_BODY_BYTES);
    const multipart = multipartPayload("photo.png", "image/png", padded);
    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${form.publicKey}/upload`,
      headers: multipart.headers,
      payload: multipart.payload
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      uploadId: expect.any(String),
      url: "https://objectstorage.example/n/ns/b/bucket/o/file.png",
      contentUrl: expect.stringMatching(/^\/v1\/admin\/uploads\/.+\/content$/),
      filename: "photo.png",
      mimetype: "image/png"
    });
    expect(uploadFile).toHaveBeenCalledOnce();
    const [record] = [...store.uploads.values()];
    expect(record).toMatchObject({ formId: form.id, tenantId: form.tenantId, status: "pending", originalFilename: "photo.png", mimeType: "image/png" });
    expect(record.expiresAt).toBeTruthy();
    await app.close();
  });

  it("rejects uploads for forms without media fields", async () => {
    const store = new MemoryStore() as unknown as Store & MemoryStore;
    const form = await store.createForm({
      tenantName: "Plain tenant",
      name: "Plain form",
      allowedOrigins: ["https://example.com"],
      schema: { type: "object", properties: { message: { type: "string" } } }
    }, "plain-form-key");
    const app = buildApp(config, store);
    const multipart = multipartPayload("photo.png", "image/png", PNG_1X1);
    const response = await app.inject({ method: "POST", url: `/v1/forms/${form.publicKey}/upload`, headers: multipart.headers, payload: multipart.payload });
    expect(response.statusCode).toBe(403);
    expect(uploadFile).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps JSON bodyLimit intact for non-upload routes", async () => {
    const { app, form } = await seededApp();
    const oversized = "x".repeat(config.MAX_BODY_BYTES + 100);
    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${form.publicKey}/submissions`,
      headers: { origin: "https://example.com", "content-type": "application/json" },
      payload: JSON.stringify({ attachment: oversized })
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: "BODY_TOO_LARGE" });
    await app.close();
  });

  it("rejects uploads over MAX_FILE_SIZE_MB with 413", async () => {
    const { app, form } = await seededApp({ MAX_FILE_SIZE_MB: 1 });
    const tooLarge = Buffer.concat([PNG_1X1, Buffer.alloc(1.1 * 1024 * 1024)]);
    const multipart = multipartPayload("huge.png", "image/png", tooLarge);
    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${form.publicKey}/upload`,
      headers: multipart.headers,
      payload: multipart.payload
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().code).toMatch(/FILE_TOO_LARGE|BODY_TOO_LARGE/);
    expect(uploadFile).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects missing and unsupported files with 400", async () => {
    const { app, form } = await seededApp();
    const missing = await app.inject({
      method: "POST",
      url: `/v1/forms/${form.publicKey}/upload`,
      headers: { origin: "https://example.com", "content-type": "multipart/form-data; boundary=----empty" },
      payload: Buffer.from("------empty--\r\n")
    });
    expect(missing.statusCode).toBe(400);

    const multipart = multipartPayload("notes.txt", "text/plain", Buffer.from("hello"));
    const unsupported = await app.inject({
      method: "POST",
      url: `/v1/forms/${form.publicKey}/upload`,
      headers: multipart.headers,
      payload: multipart.payload
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    await app.close();
  });

  it("queues deletion for an orphaned object when the upload record cannot be saved", async () => {
    const { app, form, store } = await seededApp();
    const enqueued = vi.fn(async () => undefined);
    store.enqueueUploadDeletion = enqueued;
    store.createUpload = async () => { throw new Error("database unavailable"); };
    const multipart = multipartPayload("logo.png", "image/png", PNG_1X1);
    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${form.publicKey}/upload`,
      headers: multipart.headers,
      payload: multipart.payload
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "UPLOAD_RECORD_FAILED" });
    expect(deleteFile).toHaveBeenCalledWith("uploads/tenant/form/file.png");
    expect(enqueued).toHaveBeenCalledWith("uploads/tenant/form/file.png");
    await app.close();
  });

  it("maps OCI failures to 502 without exposing provider detail", async () => {
    uploadFile.mockRejectedValueOnce(new Error("OCI upload failed (403). secret=abc"));
    const { app, form } = await seededApp();
    const multipart = multipartPayload("logo.png", "image/png", PNG_1X1);
    const response = await app.inject({
      method: "POST",
      url: `/v1/forms/${form.publicKey}/upload`,
      headers: multipart.headers,
      payload: multipart.payload
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ code: "OCI_UPLOAD_FAILED" });
    expect(JSON.stringify(response.json())).not.toContain("secret=abc");
    await app.close();
  });
});
