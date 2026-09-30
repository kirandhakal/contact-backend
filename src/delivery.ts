import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import nodemailer from "nodemailer";
import type { AppConfig } from "./config.js";
import { cleanEmailSubject, isSafeWebhookUrl } from "./security.js";
import type { OutboxJob } from "./types.js";

export async function deliverJob(job: OutboxJob, config: AppConfig): Promise<void> {
  if (job.destination.kind === "email") {
    await deliverEmail(job, config);
    return;
  }
  await deliverWebhook(job, config);
}

async function deliverEmail(job: OutboxJob, config: AppConfig): Promise<void> {
  if (!config.SMTP_URL) throw new Error("SMTP is not configured; email delivery cannot complete");
  const to = job.destination.config.to;
  if (typeof to !== "string" || !to) throw new Error("email destination requires config.to");
  const transporter = nodemailer.createTransport(config.SMTP_URL);
  await transporter.sendMail({
    from: config.EMAIL_FROM,
    to,
    subject: cleanEmailSubject(job.destination.config.subject),
    text: `New submission for ${job.form.name}\n\n${JSON.stringify(job.submission.payload, null, 2)}`
  });
}

async function deliverWebhook(job: OutboxJob, config: AppConfig): Promise<void> {
  const url = job.destination.config.url;
  if (!isSafeWebhookUrl(url)) throw new Error("unsafe webhook url");
  const hostname = new URL(url).hostname;
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("webhook hostname resolves to a non-public address");
  }
  if (!job.destination.secret) throw new Error("webhook destination requires secret");
  const body = JSON.stringify({
    id: job.submission.id,
    type: "form.submission.created",
    createdAt: job.submission.createdAt,
    form: { id: job.form.id, name: job.form.name },
    data: job.submission.payload
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", job.destination.secret).update(`${timestamp}.${body}`).digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Forms-Timestamp": timestamp,
        "X-Forms-Signature": `v1=${signature}`
      },
      body
    });
    if (!response.ok) throw new Error(`webhook returned ${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
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
