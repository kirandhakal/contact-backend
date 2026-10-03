import { describe, expect, it } from "vitest";
import { decryptDestination, encryptDestination, isDiscordWebhook, renderTemplate, validateDestinations } from "../src/integrations.js";
import type { DestinationRecord, OutboxJob } from "../src/types.js";
const schema = { type: "object", required: ["email", "phone"], properties: { email: { type: "string", format: "email" }, phone: { type: "string" }, name: { type: "string" } } };
const email = { kind: "email", config: { recipientField: "email", subject: "Thanks {{name}}", template: "Hello {{name}}", smtpHost: "smtp.example.com", smtpPort: 587, smtpUser: "mailer", from: "hello@example.com" }, secret: "a-private-password" };

describe("integration configuration", () => {
  it("preserves manual and automatic modes and rejects unknown triggers", () => {
    for (const deliveryMode of ["manual", "automatic"]) expect(validateDestinations([{ ...email, config: { ...email.config, deliveryMode } }], schema)[0].config.deliveryMode).toBe(deliveryMode);
    expect(() => validateDestinations([{ ...email, config: { ...email.config, deliveryMode: "sometimes" } }], schema)).toThrow();
  });
  it("validates channels, recipients, and required form fields", () => {
    expect(validateDestinations([email], schema)).toHaveLength(1);
    expect(() => validateDestinations([{ ...email, config: { ...email.config, recipientField: "name" } }], schema)).toThrow(/required/);
    expect(() => validateDestinations([{ ...email, config: { ...email.config, template: "{{unknown}}" } }], schema)).toThrow(/Unknown template/);
    expect(() => validateDestinations([{ ...email, config: { ...email.config, to: "team@example.com" } }], schema)).toThrow(/fixed recipient/);
    expect(() => validateDestinations([{ ...email, secret: "" }], schema)).toThrow(/SMTP/);
    expect(() => validateDestinations([{ kind: "webhook", config: { url: "https://localhost/events" }, secret: "a".repeat(24) }], schema)).toThrow();
    expect(() => validateDestinations([{ kind: "sms", config: { accountSid: `AC${"a".repeat(32)}`, from: "+14155550123", to: "5555", template: "Hello" }, secret: "token" }], schema)).toThrow();
  });
  it("keeps a secret only for an existing integration of the same form and kind", () => {
    const existing = { ...email, kind: "email", id: "a0ec8cab-becb-4eef-b01c-8f240f407315", formId: "form", active: true } as DestinationRecord;
    expect(validateDestinations([{ ...email, id: existing.id, secret: "" }], schema, [existing])[0].secret).toBe(email.secret);
    expect(() => validateDestinations([{ ...email, id: existing.id, secret: "" }], schema, [])).toThrow(/Unknown/);
  });
  it("encrypts configuration and detects wrong keys and tampering", () => {
    const destination = validateDestinations([email], schema)[0];
    const key = "b".repeat(64);
    const encrypted = encryptDestination(destination, key);
    expect(JSON.stringify(encrypted)).not.toContain(email.secret);
    expect(JSON.stringify(encrypted)).not.toContain("smtp.example.com");
    expect(decryptDestination(encrypted, null, key)).toEqual({ config: email.config, secret: email.secret });
    expect(() => decryptDestination(encrypted, null, "c".repeat(64))).toThrow();
    expect(decryptDestination({ to: "old@example.com" }, null, key)).toEqual({ config: { to: "old@example.com" }, secret: null });
  });
  it("only accepts Discord webhook URLs on the supported host", () => {
    expect(isDiscordWebhook("https://discord.com/api/webhooks/123/abc_def")).toBe(true);
    for (const url of ["https://discord.com.evil.test/api/webhooks/123/token", "http://discord.com/api/webhooks/123/token", "https://discord.com/api/webhooks/123/token?redirect=1"]) expect(isDiscordWebhook(url)).toBe(false);
  });
  it("substitutes own fields once, preserving text without evaluating expressions", () => {
    const job = { form: { name: "Contact" }, submission: { id: "id", createdAt: "date", payload: { name: "{{email}}", email: "a@example.com", choices: ["one", "two"] } } } as unknown as OutboxJob;
    expect(renderTemplate("Hi {{name}} / {{missing}} / {{form.name}} / {{choices}} / {{constructor}}", job)).toBe('Hi {{email}} /  / Contact / ["one","two"] / ');
  });
});
