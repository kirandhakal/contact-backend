import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), transport: vi.fn(), sendMail: vi.fn(), close: vi.fn(), status: 200, body: "" }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
vi.mock("nodemailer", () => ({ default: { createTransport: mocks.transport } }));
import { deliverJob } from "../src/delivery.js";
import { getConfig } from "../src/config.js";
import type { OutboxJob } from "../src/types.js";
const config = getConfig({ ADMIN_API_KEY: "a".repeat(24), DATA_ENCRYPTION_KEY: "b".repeat(64), SMTP_URL: "smtp://service.example.com", EMAIL_FROM: "service@example.com" });
function job(kind: OutboxJob["destination"]["kind"], settings: Record<string, unknown>, secret?: string): OutboxJob {
  return { id: "job", attempts: 0, destination: { id: "dest", formId: "form", active: true, kind, config: settings, secret }, form: { id: "form", name: "Contact" },
    submission: { id: "sub", tenantId: "tenant", formId: "form", formVersion: 1, payload: { name: "Alex", email: "alex@example.com", phone: "+14155550123", message: "@everyone" }, status: "accepted", sourceIpHash: "test", createdAt: "2026-09-30", expiresAt: "2027-09-30" } };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.status = 200; mocks.body = "";
  mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  mocks.sendMail.mockResolvedValue({});
  mocks.transport.mockReturnValue({ sendMail: mocks.sendMail, close: mocks.close });
  mocks.request.mockImplementation((_options, callback) => Object.assign(new EventEmitter(), { end: (body: string) => { mocks.body = body; callback({ statusCode: mocks.status, resume: vi.fn() }); } }));
});
describe("delivery adapters", () => {
  it("prefers public IPv4 when DNS returns IPv6 first", async () => {
    mocks.lookup.mockResolvedValue([{ address: "2607:f8b0:400e:c00::6c", family: 6 }, { address: "93.184.216.34", family: 4 }]);
    await deliverJob(job("email", { smtpHost: "smtp.example.com", smtpPort: 587, smtpUser: "user", from: "hello@example.com", to: "alex@example.com" }, "password"), config);
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({ host: "93.184.216.34", connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 30000 }));
  });
  it("still rejects mixed public and private DNS answers", async () => {
    mocks.lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "::1", family: 6 }]);
    await expect(deliverJob(job("email", { smtpHost: "smtp.example.com", smtpPort: 587, to: "alex@example.com" }), config)).rejects.toThrow("public address");
    expect(mocks.transport).not.toHaveBeenCalled();
  });
  it("applies SMTP timeouts to the service transport", async () => {
    await deliverJob(job("email", { to: "alex@example.com" }), { ...config, SMTP_TIMEOUT_MS: 45000 });
    expect(mocks.transport).toHaveBeenCalledWith({ url: config.SMTP_URL, connectionTimeout: 45000, greetingTimeout: 45000, socketTimeout: 45000 });
  });
  it.each([
    ["EAUTH", "authentication failed"], ["ETIMEDOUT", "connection timed out"],
    ["ESOCKET", "connection failed"], ["ECONNECTION", "connection failed"],
    ["ETLS", "TLS negotiation failed"], ["EENVELOPE", "rejected the sender or recipient"],
    ["UNKNOWN", "Email delivery failed"],
  ])("reports a safe actionable error for %s and closes the transport", async (code, reason) => {
    mocks.sendMail.mockRejectedValue(Object.assign(new Error("private provider response and password"), { code }));
    const result = deliverJob(job("email", { to: "alex@example.com" }), config);
    await expect(result).rejects.toThrow(reason);
    await expect(result).rejects.not.toThrow("private provider");
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it("sends custom SMTP confirmations using a pinned public address and verified TLS", async () => {
    await deliverJob(job("email", { smtpHost: "smtp.example.com", smtpPort: 587, smtpUser: "user", from: "hello@example.com", recipientField: "email", subject: "Hello {{name}}", template: "Thanks {{name}}" }, "smtp-password"), config);
    expect(mocks.transport).toHaveBeenCalledWith(expect.objectContaining({ host: "93.184.216.34", requireTLS: true, tls: expect.objectContaining({ servername: "smtp.example.com" }), auth: { user: "user", pass: "smtp-password" } }));
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "alex@example.com", subject: "Hello Alex", text: "Thanks Alex", disableUrlAccess: true }));
  });
  it("sends Discord content with mentions disabled and awaits provider confirmation", async () => {
    await deliverJob(job("discord", { template: "New {{name}}: {{message}}" }, "https://discord.com/api/webhooks/123/token"), config);
    expect(JSON.parse(mocks.body)).toEqual({ content: "New Alex: @everyone", allowed_mentions: { parse: [] } });
    expect(mocks.request.mock.calls[0][0]).toMatchObject({ hostname: "93.184.216.34", servername: "discord.com", path: "/api/webhooks/123/token?wait=true" });
  });
  it("sends Twilio form-encoded SMS to the submitted phone number", async () => {
    const sid = `AC${"a".repeat(32)}`;
    await deliverJob(job("sms", { accountSid: sid, from: "+14155550999", recipientField: "phone", template: "Thanks {{name}}" }, "auth-token"), config);
    expect(Object.fromEntries(new URLSearchParams(mocks.body))).toEqual({ To: "+14155550123", From: "+14155550999", Body: "Thanks Alex" });
    expect(mocks.request.mock.calls[0][0].headers.Authorization).toBe(`Basic ${Buffer.from(`${sid}:auth-token`).toString("base64")}`);
  });
  it("preserves signed webhook events and adds the rendered message", async () => {
    await deliverJob(job("webhook", { url: "https://example.com/events", template: "Hi {{name}}" }, "secret"), config);
    expect(JSON.parse(mocks.body)).toMatchObject({ type: "form.submission.created", message: "Hi Alex", data: { name: "Alex" } });
    expect(mocks.request.mock.calls[0][0].headers["X-Forms-Signature"]).toMatch(/^v1=[a-f0-9]{64}$/);
    mocks.status = 302;
    await expect(deliverJob(job("webhook", { url: "https://example.com/events" }, "secret"), config)).rejects.toThrow("HTTP 302");
  });
  it("blocks private DNS targets without connecting and rejects invalid recipients", async () => {
    mocks.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(deliverJob(job("webhook", { url: "https://example.com/events" }, "secret"), config)).rejects.toThrow(/public address/);
    expect(mocks.request).not.toHaveBeenCalled();
    await expect(deliverJob(job("email", { recipientField: "name" }), config)).rejects.toThrow();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });
  it("identifies bulk reply events separately and supplies a stable delivery ID for retries", async () => {
    await deliverJob(job("webhook", { url: "https://example.com/events", template: "Reply to {{name}}", eventType: "form.reply.created" }, "secret"), config);
    expect(JSON.parse(mocks.body)).toMatchObject({ id: "sub", deliveryId: "job", type: "form.reply.created", message: "Reply to Alex" });
  });
});
