-- Backfill uploads orphaned by admin deletes performed before the cascade fix.
-- Hard deletes set uploads.submission_id to NULL via ON DELETE SET NULL while
-- leaving status = 'attached', so nothing could find them again. Marking them
-- deleted fires uploads_queue_object_deletion and enqueues object removal.
-- Idempotent: subsequent runs match no rows, and the trigger's insert uses
-- ON CONFLICT (upload_id) DO NOTHING.
UPDATE uploads
SET status = 'deleted'
WHERE status = 'attached' AND submission_id IS NULL;
