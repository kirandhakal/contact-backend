# Management API

The backend now serves JSON at `/`; the legacy HTML auth/dashboard and JavaScript assets have been removed. The separate Next.js frontend is in `../react`. Apply migrations with `npm run migrate` before deploying. Migration 005 adds indexes for the new list queries, and migration 004 is now safe to rerun.

## Authentication and roles

Bootstrap sudo access with `npm run seed:admin`, setting `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` explicitly. The password must be 12–256 characters. No default credentials are supplied; existing accounts are left unchanged.

Existing `/v1/auth/signup`, `/v1/admin/login`, `/v1/admin/me`, `/v1/admin/logout`, and `/v1/admin/password` endpoints remain. Browser sessions use HTTP-only cookies with an eight-hour lifetime. `POST /v1/admin/password` requires `currentPassword` and `newPassword` (12–256 characters); success revokes all of that account's sessions.

The Next.js frontend uses a same-origin proxy and translates the session cookie path to `/`. Direct cookie-authenticated mutations must supply an Origin matching `PUBLIC_BASE_URL`. Service automation can use `Authorization: Bearer ADMIN_API_KEY` on supported admin endpoints. Never expose that key in a browser.

Tenant users can only access their own forms, submissions, analytics, and tenant details. Super and sudo admins can manage tenants. Only sudo admins can edit submissions or create super admins, as before.

## List endpoints

| Endpoint | Response collection | Filters |
| --- | --- | --- |
| `GET /v1/admin/forms` | `forms` | `q`, `status=active\|disabled`, `tenantId`, `from`, `to`, `sort` |
| `GET /v1/admin/tenants` | `tenants` | `q`, `status=active\|inactive`, `tenantId`, `sort` |
| `GET /v1/admin/tenants/:tenantId` | `tenant`, `forms` | Form filters; tenant comes from the path |
| `GET /v1/admin/forms/:publicKey/submissions` | `submissions` | `q` (payload search), `status=accepted\|spam`, `from`, `to`, `sort=newest\|oldest` |

All lists support `page` (default 1) and `limit` (default 20, maximum 100), and return `pagination: { page, limit, total, pages }`. Pages beyond the last page return an empty array and the correct total. Invalid pagination, UUIDs, date ranges, and statuses return 400. Dates are ISO-8601 timestamps including timezone; bounds are inclusive. Lists use SQL filtering and pagination with deterministic ID tie-breakers. Form dates filter the counted submissions, not the form creation date. Tenant totals are all-time retained totals. `sort` supports `newest`, `oldest`, `name`, and `most-used` on resource lists.

An active tenant has at least one active form; inactive includes tenants with no forms. Tenant summaries include form/active-form counts, retained and daily submissions, and all four limits. Use `GET /v1/admin/tenants?status=active`, then the tenant detail endpoint with `status=active` to retrieve its active forms. Tenant access never widens based on a supplied query tenant ID.

## Analytics

`GET /v1/admin/analytics?tenantId=<uuid>&from=<ISO>&to=<ISO>` returns:

```json
{
  "forms": 4,
  "activeForms": 3,
  "tenants": 2,
  "activeTenants": 1,
  "submissions": 50,
  "accepted": 48,
  "spam": 2,
  "mostUsedForms": [{ "publicKey": "...", "name": "Contact", "submissionCount": 40 }],
  "daily": [{ "day": "2026-09-25", "count": 12 }]
}
```

Top forms are limited to ten. Daily buckets are UTC and omit days without submissions. Submission counts exclude deleted records and are affected by retention cleanup. Dates filter submission totals/rankings, while form and tenant counts describe current resources. Tenant sessions always receive their own scope.

## Tenant creation and password reset

`POST /v1/admin/tenants` with `{ "name": "Studio", "email": "owner@example.com", "password": "at-least-12-characters" }` atomically creates a tenant and its owner account. Requires super or sudo access. Returns 201 with `tenantId`, name, and email; duplicate emails return 409.

`POST /v1/admin/tenants/:tenantId/password` with `{ "email": "owner@example.com", "newPassword": "a-new-long-password" }` resets a matching tenant account and revokes all its sessions. It cannot reset super/sudo accounts and requires super/sudo access. Tenant users must use the current-password flow.

`PATCH /v1/admin/tenants/:tenantId` continues to accept all four positive-integer limits: `maxForms`, `maxOriginsPerForm`, `maxTotalSubmissions`, `maxDailySubmissions`.

The existing `/v1/admin/forms/summary` remains for compatibility. New clients should use the paginated form list. Submission list responses retain the `submissions` key and add pagination; the default page size is now 20 and maximum 100.

## Automation, test submissions, and bulk replies

Run `npm run migrate` before using bulk replies (migration 008).

Each destination's `config.deliveryMode` is `automatic` or `manual`. Existing rules without a mode remain automatic; the editor defaults new rules to manual. Forms with no automatic rules only store incoming submissions. Paginated form records include `automaticRules` and `manualRules` counts.

Authenticated endpoints (tenant scoped; cookie mutations require same origin):

- `POST /v1/admin/forms/:publicKey/test`: `{ payload: { name: "Alex Morgan", email: "alex@example.com", message: "Let’s build something together.", _website: "" }, send: false, requestId: "<uuid>" }`. Validates against the saved schema without persistence or delivery. With `send: true`, saves the submitted field values and returns `submissionId`. Supply `destinationIds: []` to save only, or selected destination IDs to test those rules (including manual rules); unselected automatic rules will not run. Omitting `destinationIds` retains the legacy automatic-rule behavior. Reuse the request ID when retrying. Tests bypass public origin/bot checks, but enforce schema, workspace limits and admin rate limits. Use an address you control for real delivery.
- `GET /v1/admin/forms/:publicKey/delivery/:submissionId`: returns channel, status and attempt count for queued jobs. Provider acceptance does not guarantee inbox delivery.
- `POST /v1/admin/forms/:publicKey/replies`: `{ submissionIds: ["<uuid>"], destinationIds: ["<uuid>"], message: "Hello {{name}}", subject: "Optional email subject", requestId: "<uuid>" }`. Select up to 100 explicit submission IDs, or replace `submissionIds` with `filters: { q: "", fields: { education: ["SEE", "+2"] }, from: "2026-10-01T00:00:00Z", to: "2026-10-31T23:59:59Z" }` to send to all matches across pages (maximum 10,000; narrow filters above this limit). Only accepted, unexpired submissions from the active form are eligible. Up to 20 integrations may be selected. Invalid email/phone recipients are skipped per channel. Reusing the request ID returns the original queued count. Credentials and content are snapshotted. Fixed destinations receive one message per submission; field destinations resolve each submitter’s address.
- `POST /v1/admin/forms/:publicKey/replies/preview`: takes the same `filters` object directly and returns `{ matched, overLimit }`. Counts are submissions, before channel-specific recipient skipping. Filters match any selected value within a field and require all selected fields; array fields match when they contain any selected value. Submission list endpoints accept these field filters as JSON in the `fields` query parameter.

Form creation returns `publicKey` and `submitUrl`. The frontend shows both immediately after creation, keeps the sample values entered during setup, and offers a generated JavaScript submit handler plus a real test form. Use `submitUrl` for a JSON POST from an allowed frontend origin; never put an admin credential in website code. A localhost URL must be replaced by the deployed backend URL for a public website.

The worker must be running with provider credentials configured. Webhook events include a `deliveryId` for receiver deduplication; manual replies use type `form.reply.created`. The legacy `id` remains the submission ID. Deduplicating only on the submission ID would suppress later replies.
