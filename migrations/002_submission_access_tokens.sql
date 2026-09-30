ALTER TABLE submissions ADD COLUMN IF NOT EXISTS access_token_hash text;
CREATE INDEX IF NOT EXISTS idx_submissions_access_token_hash ON submissions(access_token_hash);
