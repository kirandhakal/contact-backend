# Universal Contact Form Backend

Reusable backend for contact forms on frontend-only websites. It supports multi-tenant forms, exact origin allowlists, JSON Schema validation, idempotent submissions, spam honeypots, PostgreSQL outbox delivery, email, signed webhooks, retries, and retention cleanup.

## Quick Start

The Next.js frontend lives in `../react`; see its [setup guide](../react/CONTACT_SETUP.md). This service is API-only. New tenant, pagination, and analytics endpoints are documented in [MANAGEMENT_API.md](./MANAGEMENT_API.md).

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run migrate
npm run dev
```

Run the worker in a second terminal:

```bash
npm run worker
```

## Verification

```bash
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

See [UNIVERSAL_CONTACT_FORM_BACKEND.md](./UNIVERSAL_CONTACT_FORM_BACKEND.md) for the full API contract and operational notes.

### Seed an admin on the deployed server

Set `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` (8–256 characters) in
`/var/www/contact-backend/.env.docker`, then run from that directory:

```sh
docker compose --env-file .env.docker run --rm app node dist/db/migrate.js
docker compose --env-file .env.docker run --rm app node dist/db/seed-admin.js
```

No host `package.json` or Node installation is required. Existing admins are
left unchanged. For GitHub Actions, manually run **CI/CD** with **seed_admin**
checked. This runs the seed after migrations using the server environment;
ordinary pushes do not seed accounts. Remove seed credentials after initial setup.

### Login cooldowns

All account roles and both login portals share a normalized-email cooldown.
Every five failed logins locks sign-in for 1, 5, 25, 125, then 625 minutes,
then 24 hours (the maximum). Attempts during a lock do not extend it;
a successful login after expiry resets escalation. Unknown accounts receive
identical responses. PostgreSQL persists and serializes these counters across
application instances. Apply migrations before starting the updated app.
HTTP 429 includes `Retry-After`, `retryAfterSeconds`, and `lockedUntil`;
the frontend displays a countdown and disables submission until it expires.

### Signup and schema readiness

Successful signup redirects the web app to `/login?signup=complete`; it does not
attempt an automatic login. Users sign in explicitly after the confirmation.
New workspace/tenant names are normalized with `slugify` (for example,
`Acme Studio` becomes `acme-studio`). Names that produce an empty slug are rejected.
Existing tenant names are preserved.

The API now applies migrations before listening, including the login-lockout table.
Migrations run in one transaction under a PostgreSQL advisory lock so simultaneous
API starts cannot apply them concurrently. A migration failure is logged and stops
startup instead of allowing signup while login tables are missing. The database
user therefore needs the same schema permissions as the migration command.

### Delivery integrations and confirmations

The form editor supports multiple email, Twilio SMS, Discord, and signed webhook
rules, including updates to existing forms. See the web app's `/docs/integrations`
for setup, message placeholders, examples, and signature verification.

- `email`: `config.to` or `config.recipientField`; optional `subject` and `template`.
  Custom SMTP adds `smtpHost`, `smtpPort` (465 or 587), `smtpUser`, `from`, and
  `secret` (password). Otherwise the worker uses `SMTP_URL` and `EMAIL_FROM`.
- `sms`: `config.accountSid`, `from`, `to` or `recipientField`, `template`, and
  `secret` (Twilio Auth Token). Numbers use E.164 international format.
- `discord`: `config.template` and `secret` (the channel webhook URL).
- `webhook`: `config.url`, optional `template`, and a signing `secret` of at least
  24 characters. The event retains `data` and includes rendered `message` when set.

Templates support `{{fieldKey}}`, `{{form.name}}`, `{{submission.id}}`, and
`{{submission.createdAt}}`. Recipient fields must exist and be required strings.
Templates are plain text, not HTML or executable expressions. Invalid recipients
fail delivery. SMS and Discord outputs are truncated at 1,600 and 2,000 characters.

`GET /v1/admin/forms/:publicKey/destinations` returns authorized configuration with
`hasSecret` flags, never the secret. Update destinations in the normal form PATCH
request. Include each existing destination `id` and omit `secret` to keep its
credential, or provide a new secret to rotate it. The array replaces the active
rules; an empty array disables all rules for future submissions. Queued jobs keep
their original settings. Public form endpoints never return integrations.

Newly saved destination configuration and secrets are encrypted together with
AES-256-GCM using `DATA_ENCRYPTION_KEY`; app and worker must share this key.
Legacy plaintext destinations remain readable and are encrypted when resaved.
Back up the key and do not rotate it without migrating encrypted records.
Provider response bodies and SMTP errors are not retained because they can expose
credentials. HTTP connections reject private addresses and redirects and pin DNS
resolution; custom SMTP requires TLS and a public host.

Apply migration 007 and deploy both app and worker, plus the frontend. The API's
startup migration runner handles the new channel constraint. Real provider
credentials and a running worker are required for delivery; saving a form does not
send a test message. Delivery is at least once with up to eight attempts, so signed
webhook receivers should deduplicate submission IDs.
