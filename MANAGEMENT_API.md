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
