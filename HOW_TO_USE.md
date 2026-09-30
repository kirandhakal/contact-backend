# How To Use This Project

This project is a reusable backend for contact forms. You can run one backend, create forms through the admin API, and submit form data from static websites.

## Requirements

- Node.js 22 or later
- npm
- Docker with Docker Compose

## 1. Install Dependencies

```bash
npm install
```

## 2. Create Environment File

Copy the example environment file:

```bash
cp .env.example .env
```

Open `.env` and set these important values:

```env
ADMIN_API_KEY=replace-with-at-least-24-random-characters
DATA_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
DATABASE_URL=postgres://forms:forms@localhost:5432/forms
PUBLIC_BASE_URL=http://localhost:3100
TURNSTILE_SECRET_KEY=
```

`ADMIN_API_KEY` is used for admin requests. `DATA_ENCRYPTION_KEY` must be exactly 64 hexadecimal characters.
Set `TURNSTILE_SECRET_KEY` in production to require Cloudflare Turnstile verification for every submission.

## 3. Start PostgreSQL

```bash
docker compose up -d postgres
```

## 4. Run Database Migrations

```bash
npm run migrate
```

## 5. Start The API Server

```bash
npm run dev
```

The API runs at:

```text
http://localhost:3100
```

Check that it is alive:

```bash
curl http://localhost:3100/health/live
```

Expected response:

```json
{
  "status": "ok"
}
```

## 6. Start The Worker

Open a second terminal and run:

```bash
npm run worker
```

The worker sends queued email or webhook deliveries.

## 7. Create A Contact Form

Use the admin API to create a form:

```bash
curl -X POST http://localhost:3100/v1/admin/forms \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantName": "Demo Site",
    "name": "Contact Form",
    "allowedOrigins": ["http://localhost:3000", "http://localhost:8080"],
    "successMessage": "Thanks, your message was sent.",
    "honeypotField": "_website",
    "schema": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "email", "topic"],
      "properties": {
        "name": { "type": "string", "minLength": 2, "maxLength": 100 },
        "email": { "type": "string", "format": "email", "maxLength": 254 },
        "topic": { "type": "string", "enum": ["sales", "support"] },
        "message": { "type": "string", "maxLength": 2000 }
      }
    },
    "destinations": []
  }'
```

The response includes a `publicKey` and `submitUrl`. Save the `publicKey`; the frontend uses it to submit messages.

### Register the Gourav inquiry form

The Gourav project is already wired to this backend. Run the API on port `3100`; the existing frontend can remain on `3000` and Gourav runs on `3001`. Register the form once:

```bash
npm run register:form -- forms/gourav-inquiry.json
```

Copy the generated public key into `gourav/.env.local`:

```env
NEXT_PUBLIC_CONTACT_API_URL=http://localhost:3100
NEXT_PUBLIC_GOURAV_INQUIRY_FORM_KEY=frm_generated_key
```

Use `gourav/.env.example` as the template. For every additional frontend or form type, create another JSON definition and register it separately. For example, an enrolment form gets its own public key even when it belongs to the same website. This keeps its data and traffic counts separate.

## 8. Submit A Form

Replace `YOUR_PUBLIC_KEY` with the public key from the previous step:

```bash
curl -X POST http://localhost:3100/v1/forms/YOUR_PUBLIC_KEY/submissions \
  -H "Origin: http://localhost:8080" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-submit-001" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "topic": "support",
    "message": "Hello from the test form."
  }'
```

Expected response status is `202 Accepted` for a new submission.

If `TURNSTILE_SECRET_KEY` is set, submissions must also include a valid Turnstile token:

```bash
curl -X POST http://localhost:3100/v1/forms/YOUR_PUBLIC_KEY/submissions \
  -H "Origin: http://localhost:8080" \
  -H "Content-Type: application/json" \
  -H "Turnstile-Token: TOKEN_FROM_FRONTEND_WIDGET" \
  -d '{
    "name": "Test User",
    "email": "test@example.com",
    "topic": "support"
  }'
```

## 9. Use The Example HTML Form

Open [examples/contact-form.html](./examples/contact-form.html).

Replace this line:

```js
const endpoint = 'http://localhost:3100/v1/forms/REPLACE_PUBLIC_KEY/submissions';
```

with your real form submit URL:

```js
const endpoint = 'http://localhost:3100/v1/forms/YOUR_PUBLIC_KEY/submissions';
```

Then serve the example file from an allowed origin, for example:

```bash
npx serve examples -l 8080
```

Open:

```text
http://localhost:8080/contact-form.html
```

## 10. Admin accounts and dashboard

Run `npm run migrate` after updating an existing installation. The contact service hosts the admin dashboard at the origin in `PUBLIC_BASE_URL`, followed by `/admin` (for example, `http://localhost:3100/admin`). Use the exact same host name as `PUBLIC_BASE_URL` when signing in.

The backend operator's `ADMIN_API_KEY` is a bootstrap credential. Keep it on the contact server. `npm run seed:admin` creates the first `sudo` admin. Existing installations are migrated automatically: the oldest service admin becomes `sudo`, other service admins become `super`, and site admins become `tenant` admins.

```bash
curl -X POST http://localhost:3100/v1/admin/users \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"operator@example.com","password":"a-unique-password-at-least-12-chars","role":"super"}'
```

Sudo and super admins sign in at `/admin`; tenant admins use `/auth`. Sudo can create super and tenant accounts, edit all forms and submissions, and change their password. Super admins can edit forms and manage enforced tenant allowances. Tenant admins can edit forms and review submissions belonging to their tenant.

To create a tenant admin for an existing tenant, supply its tenant ID (or use a registered form key):

```bash
curl -X POST http://localhost:3100/v1/admin/users \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"site-owner@example.com","password":"a-different-long-password","role":"tenant","formKey":"YOUR_PUBLIC_KEY"}'
```

Tenant admins see submissions and counts for their tenant only. Give each administrator an individual account. A public form key is safe to include in a static frontend; passwords and `ADMIN_API_KEY` are not. Tenant limits cover origins per form, total forms, total submissions, and daily submissions; all four are enforced by the API.

To add another form for an existing site, pass its `tenantId` in the form creation request along with the usual form fields. The service admin can find the tenant ID in `/v1/admin/forms/summary`. Forms with the same `tenantId` appear together for that site's admins. Omit `tenantId` to create a new site tenant.

The dashboard is hosted on the contact service origin and uses an HttpOnly, SameSite=Strict session cookie. Login is rate limited. Sessions expire after 8 hours and can be ended with Sign out. Use HTTPS for production.

## 11. Admin API

```bash
curl http://localhost:3100/v1/admin/forms/YOUR_PUBLIC_KEY/submissions \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY"
```

Public submissions return only a status and confirmation message. The visitor does not get a read credential. The static site can display its own success message instead of the API message.

## 11. Compare frontend traffic

Use the admin-only summary endpoint to see which registered form receives the most submissions. It includes total, accepted, spam, last-submitted time, and browser-origin counts without returning the form payloads.

```bash
curl http://localhost:3100/v1/admin/forms/summary \
  -H "Authorization: Bearer YOUR_ADMIN_API_KEY"
```

## Useful Commands

```bash
npm run dev        # Start API in watch mode
npm run worker     # Start delivery worker
npm run migrate    # Run database migrations
npm test           # Run tests
npm run typecheck  # Check TypeScript types
npm run build      # Build dist output
```

## Common Problems

### Invalid admin token

Make sure the value in the request header matches `ADMIN_API_KEY` from `.env`:

```text
Authorization: Bearer YOUR_ADMIN_API_KEY
```

### Origin is not allowed

The browser origin must exactly match one of the values in `allowedOrigins`. For local testing, add the port you are using, such as:

```json
["http://localhost:8080"]
```

### Bot verification failed

If `TURNSTILE_SECRET_KEY` is set, your frontend must render a Cloudflare Turnstile widget and send the returned token in this request header:

```text
Turnstile-Token: TOKEN_FROM_FRONTEND_WIDGET
```

### Database not ready

Start PostgreSQL and run migrations:

```bash
docker compose up -d postgres
npm run migrate
```
