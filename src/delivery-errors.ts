export const smtpFailureReasons: Record<string, string> = {
  EAUTH: "SMTP authentication failed; check the username and password or provider app password",
  ETIMEDOUT: "SMTP connection timed out; check outbound SMTP access and the server port",
  ESOCKET: "SMTP connection failed; check network access and TLS settings",
  ECONNECTION: "SMTP connection failed; check the server hostname and port",
  ETLS: "SMTP TLS negotiation failed; check the server and connection settings",
  EENVELOPE: "SMTP rejected the sender or recipient; check both email addresses and sender permissions",
};

const safeErrors = new Set([...Object.values(smtpFailureReasons),
  "Email delivery failed; check SMTP credentials, sender, and recipient",
  "Submission recipient is missing or invalid",
  "Service SMTP is not configured; choose a custom SMTP server",
  "Integration host must resolve to a public address",
]);

// Old jobs may contain raw provider errors; expose only known safe messages.
export function publicDeliveryError(error: unknown): string | null {
  if (!error) return null;
  return typeof error === "string" && safeErrors.has(error) ? error : "Delivery failed; ask the service administrator to inspect the worker logs.";
}
