-- Centralized media upload support.
-- Forms may restrict uploads per form; uploads are tracked so submissions can
-- reference them securely instead of accepting arbitrary object URLs.

ALTER TABLE forms
  ADD COLUMN IF NOT EXISTS upload_config jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  url text NOT NULL,
  original_filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached', 'deleted')),
  submission_id uuid REFERENCES submissions(id) ON DELETE SET NULL,
  field_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_form_status ON uploads(form_id, status);
CREATE INDEX IF NOT EXISTS idx_uploads_tenant_status ON uploads(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_uploads_submission ON uploads(submission_id);
CREATE INDEX IF NOT EXISTS idx_uploads_expires_at ON uploads(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_uploads_reference ON uploads(form_id, id);
CREATE INDEX IF NOT EXISTS idx_uploads_url ON uploads(form_id, url);
