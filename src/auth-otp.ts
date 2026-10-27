import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const OTP_DIGITS = 6;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function generateOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(OTP_DIGITS, "0");
}

export function hashOtp(keyHex: string, purpose: string, email: string, challengeId: string, otp: string): string {
  return createHmac("sha256", Buffer.from(keyHex, "hex"))
    .update(`${purpose}\u0000${email}\u0000${challengeId}\u0000${otp}`)
    .digest("hex");
}

export function newResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function otpMatches(expectedHex: string, actualHex: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedHex) || !/^[a-f0-9]{64}$/.test(actualHex)) return false;
  const left = Buffer.from(expectedHex, "hex");
  const right = Buffer.from(actualHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function isSixDigitCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{6}$/.test(value);
}
