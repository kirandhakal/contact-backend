CREATE TABLE IF NOT EXISTS reply_batches (
  form_id uuid NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  queued integer NOT NULL DEFAULT 0,
  PRIMARY KEY (form_id, request_id)
);
