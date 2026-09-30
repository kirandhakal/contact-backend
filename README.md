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
