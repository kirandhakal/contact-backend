import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { isSafeWebhookUrl } from "./security.js";
import type { DestinationInput, DestinationRecord, JsonObject, OutboxJob } from "./types.js";

const text = z.string().trim().min(1);
const field = text.max(80).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const template = z.string().min(1).max(8000);
const recipient = { to: text.optional(), recipientField: field.optional() };
const emailConfig = z.object({ ...recipient, subject: z.string().min(1).max(200).optional(), template: template.optional(),
  from: z.string().email().optional(), smtpHost: text.max(253).regex(/^[a-zA-Z0-9.-]+$/).optional(),
  smtpPort: z.union([z.literal(465), z.literal(587)]).optional(), smtpUser: text.max(254).optional() }).strict();
const smsConfig = z.object({ ...recipient, accountSid: z.string().regex(/^AC[a-fA-F0-9]{32}$/), from: phone, template: template.max(1600) }).strict();
const webhookConfig = z.object({ url: z.string().max(2048).refine(isSafeWebhookUrl), template: template.optional() }).strict();
export const destinationSchema = z.object({
  id: z.string().uuid().optional(), kind: z.enum(["email", "sms", "discord", "webhook"]),
  config: z.record(z.unknown()), secret: z.string().max(4096).optional()
}).strict();

export function isDiscordWebhook(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "discord.com" && !url.port && !url.username && !url.password &&
      /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+$/.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}

export function validateDestinations(value: unknown, schema: JsonObject, existing: DestinationRecord[] = []): DestinationInput[] {
  const parsed = z.array(destinationSchema).max(20).parse(value);
  const seen = new Set<string>();
  return parsed.map(item => {
    const old = item.id ? existing.find(d => d.id === item.id && d.kind === item.kind) : undefined;
    if (item.id && (!old || seen.has(item.id))) throw new Error("Unknown or duplicate integration.");
    if (item.id) seen.add(item.id);
    const secret = item.secret || old?.secret || undefined;
    let config: JsonObject;
    if (item.kind === "email" || item.kind === "sms") {
      config = (item.kind === "email" ? emailConfig : smsConfig).parse(item.config);
      if (!!config.to === !!config.recipientField) throw new Error("Choose a fixed recipient or a recipient field.");
      if (config.to && !(item.kind === "email" ? z.string().email() : phone).safeParse(config.to).success) throw new Error("Use a valid email address or international phone number.");
      if (config.recipientField) {
        const properties = schema.properties as Record<string, JsonObject> | undefined;
        const property = properties?.[String(config.recipientField)];
        if (!property || property.type !== "string" || !Array.isArray(schema.required) || !schema.required.includes(config.recipientField)) throw new Error("The recipient field must be a required text/email field in this form.");
      }
      if (item.kind === "email" && config.smtpHost && (!config.smtpPort || !config.smtpUser || !config.from || !secret)) throw new Error("Custom SMTP requires host, port, username, password, and sender email.");
      if (item.kind === "email" && !config.smtpHost && (config.smtpPort || config.smtpUser || config.from || secret)) throw new Error("Select custom SMTP to supply mail server credentials.");
      if (item.kind === "sms" && !secret) throw new Error("Twilio requires an Auth Token.");
    } else if (item.kind === "discord") {
      config = z.object({ template: template.max(2000) }).strict().parse(item.config);
      if (!secret || !isDiscordWebhook(secret)) throw new Error("Enter a Discord channel webhook URL from discord.com.");
    } else {
      config = webhookConfig.parse(item.config);
      if (!secret || secret.length < 24) throw new Error("Webhooks require a signing secret of at least 24 characters.");
    }
    for (const source of [config.template, config.subject]) {
      if (typeof source !== "string") continue;
      for (const match of source.matchAll(/{{\s*([^{}]+?)\s*}}/g)) {
        const key = match[1].trim();
        const properties = schema.properties as JsonObject | undefined;
        if (!["form.name", "submission.id", "submission.createdAt"].includes(key) && !Object.hasOwn(properties ?? {}, key)) throw new Error(`Unknown template field: ${key}`);
      }
    }
    return { kind: item.kind, config, ...(secret ? { secret } : {}) };
  });
}

export function renderTemplate(source: string, job: OutboxJob): string {
  const metadata: JsonObject = { "form.name": job.form.name, "submission.id": job.submission.id, "submission.createdAt": job.submission.createdAt };
  return source.replace(/{{\s*([^{}]+?)\s*}}/g, (_match, raw: string) => {
    const key = raw.trim();
    const value = Object.hasOwn(metadata, key) ? metadata[key] : Object.hasOwn(job.submission.payload, key) ? job.submission.payload[key] : "";
    return value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

export function encryptDestination(destination: DestinationInput, key: string): JsonObject {
  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error("Integration encryption key is not configured");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify({ config: destination.config, secret: destination.secret }), "utf8"), cipher.final()]);
  return { encrypted: ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":") };
}

export function decryptDestination(config: JsonObject, secret: string | null, key: string): { config: JsonObject; secret?: string | null } {
  if (typeof config.encrypted !== "string") return { config, secret }; // Legacy email/webhook records.
  const [version, iv, tag, data] = config.encrypted.split(":");
  if (version !== "v1") throw new Error("Unsupported integration encryption version");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8"));
}
