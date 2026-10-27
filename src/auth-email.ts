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
  const smtpUrl = typeof config.SMTP_URL === "string" ? config.SMTP_URL.trim() : "";
  const hasValidSmtpUrl = smtpUrl && /:\/\//.test(smtpUrl);
  if (hasValidSmtpUrl) {
    try {
      transport = nodemailer.createTransport({ url: smtpUrl, ...timeouts });
    } catch {
      transport = null;
    }
  }
  if (!transport && typeof settings.MAIL_HOST === "string" && settings.MAIL_HOST) {
    const mailUser = String(settings.MAIL_USERNAME || settings.MAIL_USER || "").trim();
    // Normalize Gmail-style app passwords (spaces) and accidental surrounding quotes from env files.
    const mailPass = String(settings.MAIL_PASSWORD || settings.MAIL_PASS || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, "");
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
  }
  if (!transport) {
    throw new Error("Authentication email is not configured.");
  }

  const fromAddress = String(settings.MAIL_FROM || config.EMAIL_FROM).trim();
  const from = fromAddress.includes("<") ? fromAddress : `Contact <${fromAddress}>`;
  const content = emailContent(message);
  try {
    await transport.sendMail({
      from,
      to: message.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
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

function emailContent(message: AuthEmailMessage): { subject: string; text: string; html: string } {
  if (message.kind === "password_changed") {
    const text = "Your Contact workspace password was changed. If you did not make this change, contact your service administrator immediately.";
    return {
      subject: "Your Contact password was changed",
      text,
      html: layout({
        title: "Password updated",
        preview: "Your Contact password was changed.",
        body: `
          <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#34505c;">Your Contact workspace password was just changed.</p>
          <p style="margin:0;font-size:15px;line-height:1.6;color:#5a6f79;">If you did not make this change, contact your service administrator immediately.</p>
        `
      })
    };
  }

  const isSignup = message.kind === "signup_code";
  const action = isSignup ? "verify your email and finish creating your workspace" : "reset your password";
  const title = isSignup ? "Verify your email" : "Reset your password";
  const subject = isSignup ? "Your Contact verification code" : "Your Contact password reset code";
  const code = message.code;
  const spaced = code.split("").join(" ");
  const text = `Your Contact code is ${code}\n\nUse this code to ${action}.\nIt expires in ${message.expiresMinutes} minutes.\n\nIf you did not request it, you can ignore this email.`;

  return {
    subject,
    text,
    html: layout({
      title,
      preview: `Your verification code is ${code}. It expires in ${message.expiresMinutes} minutes.`,
      body: `
        <p style="margin:0 0 8px;font-size:16px;line-height:1.6;color:#34505c;">Use this code to ${action}:</p>
        <div style="margin:28px 0;padding:22px 16px;border-radius:14px;background:#edf5f1;border:1px solid #c9ddd4;text-align:center;">
          <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:36px;letter-spacing:12px;font-weight:700;color:#145a46;line-height:1;">${escapeHtml(spaced)}</div>
        </div>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#5a6f79;">This code expires in <strong style="color:#34505c;">${message.expiresMinutes} minutes</strong>.</p>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#7a8b94;">If you did not request this, you can safely ignore this email.</p>
      `
    })
  };
}

function layout(input: { title: string; preview: string; body: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#eef3f6;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preview)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef3f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#ffffff;border:1px solid #d7e0e5;border-radius:18px;overflow:hidden;">
          <tr>
            <td style="padding:28px 28px 18px;background:linear-gradient(180deg,#edf5f1 0%,#ffffff 100%);border-bottom:1px solid #e7edf0;">
              <div style="font-size:22px;font-weight:700;letter-spacing:-0.4px;color:#145a46;">contact<span style="color:#5f8f78;">.</span></div>
              <div style="margin-top:18px;font-size:12px;letter-spacing:1.4px;font-weight:700;text-transform:uppercase;color:#5f7d72;">${escapeHtml(input.title)}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">${input.body}</td>
          </tr>
          <tr>
            <td style="padding:18px 28px 26px;border-top:1px solid #e7edf0;font-size:13px;line-height:1.6;color:#7a8b94;">
              Sent by Contact · Keep this code private
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
