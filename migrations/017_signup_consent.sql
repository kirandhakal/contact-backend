-- Consent evidence for signup and for re-acceptance after policy changes.
--
-- The acceptance is captured on the signup form (before an account exists) and
-- carried on the pending signup through email verification. When the account is
-- created, an immutable consent_records row is written with the user id,
-- timestamp, accepted versions and the request IP.
--
-- Idempotent: safe to re-run.

ALTER TABLE pending_signups
  ADD COLUMN IF NOT EXISTS terms_version text,
  ADD COLUMN IF NOT EXISTS privacy_version text,
  ADD COLUMN IF NOT EXISTS accepted_ip text,
  ADD COLUMN IF NOT EXISTS accepted_user_agent text,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

CREATE TABLE IF NOT EXISTS consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  terms_version text NOT NULL,
  privacy_version text NOT NULL,
  ip_address text,
  user_agent text,
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_records_admin
  ON consent_records(admin_id, accepted_at DESC);
