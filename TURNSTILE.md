# Turnstile bot verification

This service uses [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) to slow down automated abuse. Verification is handled **server-side**; the browser only receives a short-lived token.

## Where Turnstile is enforced

| Endpoint | Purpose | Requires Turnstile when `TURNSTILE_SECRET_KEY` is set? |
| --- | --- | --- |
| `POST /v1/auth/signup` | Public tenant/workspace creation | **Yes** |
| `POST /v1/site-contact` | Website contact inbox (this product's own contact page) | **Yes** |
| `POST /v1/forms/:publicKey/submissions` | Customer/tenant form submissions | **No** |
| `POST /v1/admin/*` | Authenticated admin API | No (session/API key protects it) |

The important change: Turnstile is a **spam-tenant control**, so it guards public workspace creation. Tenant form submissions are validated by their JSON Schema, origin allowlist, honeypot, rate limits, and workspace limits. They no longer return `403 Bot verification failed.` because the tenant site did not send a Turnstile token.

If you want the old behavior back for a specific tenant form, add a dedicated opt-in form setting rather than turning the global secret back on. A global switch makes every customer site fail unless it integrates Turnstile.

## Configuration

Backend (`.env`):

```env
# Cloudflare Turnstile secret key. Leave empty to disable verification.
TURNSTILE_SECRET_KEY=0x...
```

Frontend (`frontend/.env`):

```env
# Public site key for the same Turnstile widget.
NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x...
```

The site key and secret key must belong to the **same** Turnstile widget. If they do not match, Cloudflare rejects every token even though the widget renders.

## Request flow

1. The browser renders the Turnstile widget with `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
2. Cloudflare issues a token through the widget callback.
3. The frontend sends the token in the `Turnstile-Token` request header.
4. The backend calls Cloudflare's `siteverify` endpoint with the secret, token, and client IP.
5. Cloudflare returns `{ "success": true }` or `{ "success": false, "error-codes": [...] }`.
6. The backend continues only when `success === true`; otherwise it returns:

```json
{
  "type": "about:blank",
  "title": "Forbidden",
  "status": 403,
  "detail": "Bot verification failed."
}
```

The website contact route uses `"Complete the verification and try again."` as its detail.

### Backend implementation

`backend/src/app.ts`:

```ts
async function verifyTurnstile(secret: string, token: string | undefined, ip: string): Promise<boolean> {
  if (!secret) return true;      // verification disabled
  if (!token) return false;      // fail closed: no token, no request

  const body = new URLSearchParams({ secret, response: token, remoteip: ip });
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body
  });
  if (!response.ok) return false;
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}
```

`verifyTurnstile` fails closed: network errors, non-2xx responses, missing tokens, and invalid tokens all result in a `403`. An empty `TURNSTILE_SECRET_KEY` disables the check entirely.

### Frontend implementation

- `frontend/components/turnstile-widget.tsx` loads `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` and renders the widget.
- The signup page renders the widget and sends the token through `frontend/lib/contact-api.ts`.
- `frontend/app/api/contact/[...path]/route.ts` forwards the `Turnstile-Token` header to the backend.
- `frontend/components/contact-form.tsx` sends the token to `POST /api/contact/site-contact`.

The widget resets after a failed submit so the user can solve it again. Tokens are single-use and expire quickly; do not cache or reuse them.

## Testing

Without a token (should return `403` when the secret is configured):

```bash
curl -i -X POST http://localhost:3100/v1/auth/signup \
  -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/json" \
  -d '{"workspaceName":"Acme","email":"owner@example.com","password":"a-secure-password"}'
```

With a real token from the widget:

```bash
curl -i -X POST http://localhost:3100/v1/auth/signup \
  -H "Origin: http://localhost:3000" \
  -H "Content-Type: application/json" \
  -H "Turnstile-Token: TOKEN_FROM_FRONTEND_WIDGET" \
  -d '{"workspaceName":"Acme","email":"owner@example.com","password":"a-secure-password"}'
```

Tenant form submissions should return `202` even when `TURNSTILE_SECRET_KEY` is configured:

```bash
curl -i -X POST http://localhost:3100/v1/forms/YOUR_PUBLIC_KEY/submissions \
  -H "Origin: https://tenant.example.com" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: test-submit-001" \
  -d '{"name":"Jane","email":"jane@example.com","message":"Hello"}'
```

Automated tests:

- `requires bot verification for tenant signup when Turnstile is configured`
- `does not require bot verification for form submissions when Turnstile is configured`
- `requires Turnstile verification when configured` (website contact)

Run them with `npm test` in `backend/`.

## Troubleshooting a 403

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `403 Bot verification failed.` on signup | No token sent, widget not rendered, or secret is configured but `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is empty | Render the widget and forward the token header |
| Widget renders but every submit fails | Site key and secret key are from different widgets | Use the matching pair from the same Cloudflare Turnstile widget |
| Works locally, fails in production | Production frontend has no site key, or CSP blocks Cloudflare | Set `NEXT_PUBLIC_TURNSTILE_SITE_KEY`; allow `https://challenges.cloudflare.com` in `script-src` and `frame-src` |
| `403` from a tenant form | Should no longer happen for form submissions | Confirm you are running the updated backend; check the form origin allowlist instead |
| `403 Origin is not allowed for this form.` | Form submission from an origin not in `allowedOrigins` | Add the exact origin, including scheme and port |

## Security notes

- Keep `TURNSTILE_SECRET_KEY` server-only. Never expose it in browser code.
- The site key is public and safe to ship to browsers.
- Verification is fail-closed; an outage at Cloudflare blocks protected requests rather than silently allowing them.
- Turnstile is one layer. Keep the JSON Schema, origin allowlist, honeypot, rate limiting, and workspace limits enabled.
