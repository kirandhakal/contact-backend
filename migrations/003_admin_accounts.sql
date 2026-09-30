CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('service', 'site')),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role = 'service' AND tenant_id IS NULL) OR (role = 'site' AND tenant_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);
