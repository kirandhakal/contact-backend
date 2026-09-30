import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z.string().default("postgres://forms:forms@localhost:5432/forms"),
  ADMIN_API_KEY: z.string().min(24),
  DATA_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:3100"),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(65536),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  SMTP_URL: z.string().default(""),
  EMAIL_FROM: z.string().default("forms@example.com"),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  TURNSTILE_SECRET_KEY: z.string().default("")
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function getConfig(env = process.env): AppConfig {
  const config = EnvSchema.parse(env);
  if (config.NODE_ENV === "production" && new URL(config.PUBLIC_BASE_URL).protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTPS in production");
  }
  return config;
}
