-- Give object-deletion jobs a terminal failure state. Without it a permanently
-- failing object key was retried forever. The worker now parks a job as "dead"
-- after the same 8-attempt threshold used by the delivery outbox.
ALTER TABLE upload_deletion_jobs
  DROP CONSTRAINT IF EXISTS upload_deletion_jobs_status_check;

ALTER TABLE upload_deletion_jobs
  ADD CONSTRAINT upload_deletion_jobs_status_check
  CHECK (status IN ('pending', 'processing', 'failed', 'deleted', 'dead'));
