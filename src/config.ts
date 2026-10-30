import "dotenv/config";
import { z } from "zod";

const boolFromEnv = (v: unknown) => {
  if (typeof v !== "string") return undefined;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "0" || s === "no" || s === "off") return false;
  return undefined;
};

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().default("postgres://forms:forms@localhost:5432/forms"),
  ADMIN_API_KEY: z.string().min(24),
  DATA_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  OTP_HMAC_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^[a-fA-F0-9]{64}$/).optional()),
  OTP_EXPIRY_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_RESEND_SECONDS: z.coerce.number().int().positive().default(60),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  AUTH_RESET_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  AUTH_MIN_RESPONSE_MS: z.coerce.number().int().min(0).default(150),
  TRUST_PROXY: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return false;
    const boolean = boolFromEnv(value);
    if (boolean !== undefined) return boolean;
    if (typeof value === "string" && /^\d+$/.test(value)) return value;
    return value;
  }, z.union([z.boolean(), z.string()])).default(false),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3100"),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(65536),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  SMTP_URL: z.string().default(""),
  EMAIL_FROM: z.string().default("kirandhakal715@gmail.com"),
  SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  TURNSTILE_SECRET_KEY: z.string().default(""),

  MAIL_HOST: z.string().default(""),
  MAIL_PORT: z.coerce.number().int().positive().default(587),
  MAIL_AUTH: z.preprocess(boolFromEnv, z.boolean().default(true)),
  MAIL_USERNAME: z.string().default(""),
  MAIL_USER: z.string().default(""),
  MAIL_PASSWORD: z.string().default(""),
  MAIL_PASS: z.string().default(""),
  MAIL_FROM: z.string().default("kirandhakal715@gmail.com"),
  MAIL_SECURE: z.preprocess(boolFromEnv, z.boolean().optional()),

  ENABLE_EMAIL: z.preprocess(boolFromEnv, z.boolean().default(true)),
  ENABLE_SMS: z.preprocess(boolFromEnv, z.boolean().default(true)),
  ENABLE_WHATSAPP: z.preprocess(boolFromEnv, z.boolean().default(true)),
  ENABLE_DISCORD: z.preprocess(boolFromEnv, z.boolean().default(true)),
  ENABLE_WEBHOOK: z.preprocess(boolFromEnv, z.boolean().default(true)),
  ENABLE_MAIL: z.preprocess(boolFromEnv, z.boolean().default(true)),
  // OCI Configuration
  OCI_ACCESS_KEY: z.string().optional(),
  OCI_SECRET_KEY: z.string().optional(),
  OCI_NAMESPACE: z.string().optional(),
  OCI_REGION: z.string().optional(),
  OCI_BUCKET: z.string().optional(),
  OCI_TENANCY_OCID: z.string().optional(),
  OCI_USER_OCID: z.string().optional(),
  OCI_FINGERPRINT: z.string().optional(),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function getConfig(env = process.env): AppConfig {
  const config = EnvSchema.parse(env);
  if (config.NODE_ENV === "production" && new URL(config.PUBLIC_BASE_URL).protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production");
  }
  return config;
}

