import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply } from "fastify";

export function newPublicKey(): string {
  return `frm_${randomBytes(18).toString("base64url")}`;
}

export function newSubmissionAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSubmissionAccessToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hashIp(ip: string, key: string): string {
  return createHmac("sha256", Buffer.from(key, "hex")).update(ip).digest("hex");
}

export function isAllowedOrigin(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return allowed.includes(parsed.origin);
  } catch {
    return false;
  }
}

export function applyCors(reply: FastifyReply, origin?: string): void {
  if (origin) reply.header("Access-Control-Allow-Origin", origin);
  reply.header("Vary", "Origin");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, Turnstile-Token");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

export function applySecurityHeaders(reply: FastifyReply): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
}

export function isValidIdempotencyKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

export function isSafeWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    if (host === "::1" || host.startsWith("[") || host.includes(":")) return false;
    return true;
  } catch {
    return false;
  }
}

export function cleanEmailSubject(value: unknown): string {
  const subject = typeof value === "string" ? value : "New form submission";
  return subject.replace(/[\r\n]+/g, " ").slice(0, 200);
}
