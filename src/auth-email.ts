import nodemailer from "nodemailer";
import type { AppConfig } from "./config.js";

export type AuthEmailMessage =
  | { kind: "signup_code"; to: string; code: string; expiresMinutes: number }
  | { kind: "password_reset_code"; to: string; code: string; expiresMinutes: number }
  | { kind: "password_changed"; to: string };

export async function sendAuthEmail(message: AuthEmailMessage, config: AppConfig): Promise<void> {
  const settings = config as AppConfig & Record<string, unknown>;
  const timeouts = {
    connectionTimeout: config.SMTP_TIMEOUT_MS,
    greetingTimeout: config.SMTP_TIMEOUT_MS,
    socketTimeout: config.SMTP_TIMEOUT_MS
  };
  let transport;
  if (config.SMTP_URL) {
    transport = nodemailer.createTransport({ url: config.SMTP_URL, ...timeouts });
  } else if (typeof settings.MAIL_HOST === "string" && settings.MAIL_HOST) {
    const mailUser = String(settings.MAIL_USERNAME || settings.MAIL_USER || "");
    const mailPass = String(settings.MAIL_PASSWORD || settings.MAIL_PASS || "");
    const mailPort = Number(settings.MAIL_PORT) || 587;
    const secure = typeof settings.MAIL_SECURE === "boolean" ? settings.MAIL_SECURE : mailPort === 465;
    transport = nodemailer.createTransport({
      host: settings.MAIL_HOST,
      port: mailPort,
      secure,
      requireTLS: mailPort === 587 || !secure,
      auth: settings.MAIL_AUTH !== false && (mailUser || mailPass) ? { user: mailUser, pass: mailPass } : undefined,
      ...timeouts
    });
  } else {
    throw new Error("Authentication email is not configured.");
  }

  const from = String(settings.MAIL_FROM || config.EMAIL_FROM);
  const content = emailContent(message);
  try {
    await transport.sendMail({
      from,
      to: message.to,
      subject: content.subject,
      text: content.text,
      disableFileAccess: true,
      disableUrlAccess: true
    });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    throw new Error(typeof code === "string" ? `Authentication email failed (${code}).` : "Authentication email failed.");
  } finally {
    transport.close();
  }
}

function emailContent(message: AuthEmailMessage): { subject: string; text: string } {
  if (message.kind === "password_changed") {
    return {
      subject: "Your Contact password was changed",
      text: "Your Contact workspace password was changed. If you did not make this change, contact your service administrator immediately."
    };
  }
  const action = message.kind === "signup_code" ? "verify your email and finish creating your workspace" : "reset your password";
  return {
    subject: message.kind === "signup_code" ? "Verify your Contact email" : "Reset your Contact password",
    text: `Use this code to ${action}: ${message.code}\n\nThis code expires in ${message.expiresMinutes} minutes. If you did not request it, you can ignore this email.`
  };
}
