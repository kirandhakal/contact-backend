CREATE TABLE IF NOT EXISTS login_lockouts (
  account_key text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  level integer NOT NULL DEFAULT 0,
  locked_until bigint NOT NULL DEFAULT 0
);
