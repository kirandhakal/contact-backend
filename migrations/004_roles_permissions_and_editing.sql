ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_role_check;
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_check;
ALTER TABLE admin_users DROP CONSTRAINT IF EXISTS admin_users_tenant_check;

UPDATE admin_users SET role = 'tenant' WHERE role = 'site';
UPDATE admin_users SET role = 'super' WHERE role = 'service';
UPDATE admin_users
SET role = 'sudo'
WHERE id = (
  SELECT id FROM admin_users
  WHERE role = 'super' AND tenant_id IS NULL
  ORDER BY created_at
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM admin_users WHERE role = 'sudo');

ALTER TABLE admin_users
  ADD CONSTRAINT admin_users_role_check CHECK (role IN ('sudo', 'super', 'tenant')),
  ADD CONSTRAINT admin_users_tenant_check CHECK (
    (role IN ('sudo', 'super') AND tenant_id IS NULL) OR
    (role = 'tenant' AND tenant_id IS NOT NULL)
  );

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS max_origins_per_form integer NOT NULL DEFAULT 5 CHECK (max_origins_per_form > 0),
  ADD COLUMN IF NOT EXISTS max_forms integer NOT NULL DEFAULT 10 CHECK (max_forms > 0),
  ADD COLUMN IF NOT EXISTS max_total_submissions integer NOT NULL DEFAULT 10000 CHECK (max_total_submissions > 0),
  ADD COLUMN IF NOT EXISTS max_daily_submissions integer NOT NULL DEFAULT 1000 CHECK (max_daily_submissions > 0);
