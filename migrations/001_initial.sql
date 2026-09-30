CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  public_key text NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  allowed_origins text[] NOT NULL,
  success_message text NOT NULL,
  honeypot_field text NOT NULL DEFAULT '_website',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS form_versions (
  form_id uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  version integer NOT NULL,
  schema jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (form_id, version)
);

CREATE TABLE IF NOT EXISTS destinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('email', 'webhook')),
  config jsonb NOT NULL,
  secret text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  form_version integer NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted', 'spam', 'deleted')),
  source_origin text,
  source_ip_hash text NOT NULL,
  idempotency_key text,
  access_token_hash text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (form_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  destination_id uuid NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forms_public_key_active ON forms(public_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_submissions_form_created ON submissions(form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_expires_at ON submissions(expires_at);
CREATE INDEX IF NOT EXISTS idx_outbox_claim ON outbox_jobs(status, available_at);
