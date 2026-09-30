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
