CREATE INDEX IF NOT EXISTS forms_tenant_status_created_idx ON forms(tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS submissions_form_status_created_idx ON submissions(form_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS submissions_tenant_created_idx ON submissions(tenant_id, created_at DESC) WHERE status <> 'deleted';
