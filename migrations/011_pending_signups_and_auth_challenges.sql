CREATE TABLE IF NOT EXISTS pending_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  workspace_name text NOT NULL,
  password_hash text NOT NULL,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_signups_expires_idx ON pending_signups(expires_at);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('signup', 'password_reset')),
  email text NOT NULL,
  pending_signup_id uuid REFERENCES pending_signups(id) ON DELETE SET NULL,
  admin_id uuid REFERENCES admin_users(id) ON DELETE CASCADE,
  otp_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  resend_available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  locked_until timestamptz,
  consumed_at timestamptz,
  reset_token_hash text,
  reset_token_expires_at timestamptz,
  reset_consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (purpose = 'signup' AND admin_id IS NULL) OR
    (purpose = 'password_reset' AND pending_signup_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS auth_challenges_lookup_idx ON auth_challenges(email, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_challenges_expires_idx ON auth_challenges(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS auth_challenges_reset_token_idx ON auth_challenges(reset_token_hash) WHERE reset_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_challenges_active_signup_idx ON auth_challenges(email) WHERE purpose = 'signup' AND consumed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS auth_challenges_active_reset_idx ON auth_challenges(email) WHERE purpose = 'password_reset' AND consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_expires_idx ON auth_rate_limits(expires_at);
