import { smtpFailureReasons } from "./delivery-errors.js";
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import nodemailer from "nodemailer";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { cleanEmailSubject, isSafeWebhookUrl } from "./security.js";
import { isDiscordWebhook, renderTemplate } from "./integrations.js";
import type { OutboxJob } from "./types.js";

export async function deliverJob(job: OutboxJob, config: AppConfig): Promise<void> {
  if (job.destination.kind === "email") return deliverEmail(job, config);
  if (job.destination.kind === "sms") return deliverSms(job, config);
  if (job.destination.kind === "discord") {
    const url = job.destination.secret;
    if (!url || !isDiscordWebhook(url)) throw new Error("Invalid Discord webhook configuration");
    await postPublic(`${url}?wait=true`, JSON.stringify({ content: message(job).slice(0, 2000), allowed_mentions: { parse: [] } }), { "Content-Type": "application/json" }, config.WEBHOOK_TIMEOUT_MS);
    return;
  }
  await deliverWebhook(job, config);
}

function message(job: OutboxJob): string {
  const source = job.destination.config.template;
  return typeof source === "string" ? renderTemplate(source, job).slice(0, 32000)
    : `New submission for ${job.form.name}\n\n${JSON.stringify(job.submission.payload, null, 2)}`;
}

function recipient(job: OutboxJob): string {
  const { to, recipientField } = job.destination.config;
  const value = typeof recipientField === "string" ? job.submission.payload[recipientField] : to;
  const validator = job.destination.kind === "email" ? z.string().email() : z.string().regex(/^\+[1-9]\d{7,14}$/);
  if (!validator.safeParse(value).success) throw new Error("Submission recipient is missing or invalid");
  return value as string;
}

async function publicHost(hostname: string) {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("Integration host must resolve to a public address");
  // Prefer IPv4 on hosts without outbound IPv6, after validating every result.
  return addresses.find(address => address.family === 4) ?? addresses[0];
}

// Pin the checked address for the connection to avoid DNS rebinding. TLS still verifies the original hostname.
async function postPublic(url: string, body: string, headers: Record<string, string>, timeout: number): Promise<void> {
  if (!isSafeWebhookUrl(url)) throw new Error("Integration requires a public HTTPS URL");
  const parsed = new URL(url);
  const address = await publicHost(parsed.hostname);
  await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: address.address, family: address.family, servername: parsed.hostname,
      port: 443, path: parsed.pathname + parsed.search, method: "POST", signal: AbortSignal.timeout(timeout),
      headers: { ...headers, Host: parsed.hostname, "Content-Length": Buffer.byteLength(body) } }, res => {
      res.resume();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`Integration returned HTTP ${res.statusCode}`));
    });
    req.on("error", () => reject(new Error("Integration connection failed or timed out")));
    req.end(body);
  });
}

async function deliverEmail(job: OutboxJob, config: AppConfig): Promise<void> {
  const settings = job.destination.config;
  const to = recipient(job);
  const timeouts = { connectionTimeout: config.SMTP_TIMEOUT_MS, greetingTimeout: config.SMTP_TIMEOUT_MS, socketTimeout: config.SMTP_TIMEOUT_MS };
  let transport;
  if (typeof settings.smtpHost === "string") {
    const address = await publicHost(settings.smtpHost);
    if (![465, 587].includes(Number(settings.smtpPort))) throw new Error("Unsupported SMTP port");
    transport = nodemailer.createTransport({ host: address.address, port: Number(settings.smtpPort),
      secure: settings.smtpPort === 465, requireTLS: true, tls: { servername: settings.smtpHost, minVersion: "TLSv1.2" },
      auth: { user: String(settings.smtpUser), pass: job.destination.secret ?? "" },
      ...timeouts });
  } else {
    if (!config.SMTP_URL) throw new Error("Service SMTP is not configured; choose a custom SMTP server");
    transport = nodemailer.createTransport({ url: config.SMTP_URL, ...timeouts });
  }
  try {
    await transport.sendMail({ from: typeof settings.from === "string" ? settings.from : config.EMAIL_FROM,
      to, subject: cleanEmailSubject(typeof settings.subject === "string" ? renderTemplate(settings.subject, job) : undefined),
      text: message(job), disableFileAccess: true, disableUrlAccess: true });
  } catch (error) {
    // Never persist raw provider responses: they can contain credentials or message data.
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    throw new Error(typeof code === "string" && Object.hasOwn(smtpFailureReasons, code) ? smtpFailureReasons[code] : "Email delivery failed; check SMTP credentials, sender, and recipient");
  }
  finally { transport.close(); }
}

async function deliverSms(job: OutboxJob, config: AppConfig): Promise<void> {
  const settings = job.destination.config;
  if (typeof settings.accountSid !== "string" || !/^AC[a-fA-F0-9]{32}$/.test(settings.accountSid) || !job.destination.secret) throw new Error("Invalid Twilio credentials");
  await postPublic(`https://api.twilio.com/2010-04-01/Accounts/${settings.accountSid}/Messages.json`,
    new URLSearchParams({ To: recipient(job), From: String(settings.from), Body: message(job).slice(0, 1600) }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${settings.accountSid}:${job.destination.secret}`).toString("base64")}` }, config.WEBHOOK_TIMEOUT_MS);
}

async function deliverWebhook(job: OutboxJob, config: AppConfig): Promise<void> {
  const url = job.destination.config.url;
  if (!isSafeWebhookUrl(url) || !job.destination.secret) throw new Error("Invalid webhook configuration");
  const body = JSON.stringify({ id: job.submission.id, deliveryId: job.id, type: job.destination.config.eventType === "form.reply.created" ? "form.reply.created" : "form.submission.created", createdAt: job.submission.createdAt,
    form: { id: job.form.id, name: job.form.name }, data: job.submission.payload,
    ...(job.destination.config.template ? { message: message(job) } : {}) });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", job.destination.secret).update(`${timestamp}.${body}`).digest("hex");
  await postPublic(url, body, { "Content-Type": "application/json", "X-Forms-Timestamp": timestamp, "X-Forms-Signature": `v1=${signature}` }, config.WEBHOOK_TIMEOUT_MS);
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
      !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) &&
      !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
      !(a === 192 && b === 0) && !(a === 198 && (b === 18 || b === 19)) &&
      !(a === 198 && b === 51) && !(a === 203 && b === 0);
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    // Only globally routed unicast space is accepted; this excludes loopback,
    // link-local, unique-local, multicast, IPv4 mapped, and documentation ranges.
    return /^[23][0-9a-f]{3}:/.test(normalized) && !normalized.startsWith("2001:db8:");
  }
  return false;
}
