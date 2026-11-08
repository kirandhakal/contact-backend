-- Lease-based ownership for outbox workers. Existing processing rows keep
-- NULL lease values and are recovered only after the lease window elapses.
ALTER TABLE outbox_jobs
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS lease_id uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

ALTER TABLE site_contact_outbox_jobs
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS lease_id uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_outbox_jobs_processing_lease
  ON outbox_jobs(lease_expires_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_site_contact_outbox_processing_lease
  ON site_contact_outbox_jobs(lease_expires_at) WHERE status = 'processing';

-- Durable object-deletion queue. The object key is copied here so deletion can
-- still be retried even if the upload record is later removed. No foreign key
-- cascade is used deliberately.
CREATE TABLE IF NOT EXISTS upload_deletion_jobs (
  upload_id uuid PRIMARY KEY,
  object_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'failed', 'deleted')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  lease_id uuid,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_upload_deletion_jobs_claim
  ON upload_deletion_jobs(status, available_at);
CREATE INDEX IF NOT EXISTS idx_upload_deletion_jobs_processing_lease
  ON upload_deletion_jobs(lease_expires_at) WHERE status = 'processing';

-- Keep the deletion queue correct even if an older worker (or a future code
-- path) marks an upload deleted without explicitly enqueueing the object key.
CREATE OR REPLACE FUNCTION queue_upload_object_deletion() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'deleted' AND OLD.status IS DISTINCT FROM 'deleted' THEN
    INSERT INTO upload_deletion_jobs(upload_id, object_key)
    VALUES (NEW.id, NEW.object_key)
    ON CONFLICT (upload_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS uploads_queue_object_deletion ON uploads;
CREATE TRIGGER uploads_queue_object_deletion
  AFTER UPDATE OF status ON uploads
  FOR EACH ROW EXECUTE FUNCTION queue_upload_object_deletion();
