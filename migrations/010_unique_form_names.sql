-- Normalize existing form names toward slugify-style identifiers, then
-- enforce uniqueness within each tenant so two forms cannot share a name.
DO $$
DECLARE
  r RECORD;
  base text;
  candidate text;
  n integer;
BEGIN
  FOR r IN SELECT id, tenant_id, name FROM forms ORDER BY created_at, id LOOP
    base := trim(both '-' from lower(regexp_replace(regexp_replace(normalize(r.name, NFKC), '[^a-zA-Z0-9]+', '-', 'g'), '-{2,}', '-', 'g')));
    IF base = '' THEN
      base := 'form';
    END IF;
    candidate := left(base, 200);
    n := 2;
    WHILE EXISTS (
      SELECT 1 FROM forms WHERE tenant_id = r.tenant_id AND name = candidate AND id <> r.id
    ) LOOP
      candidate := left(base, greatest(1, 200 - length('-' || n::text))) || '-' || n::text;
      n := n + 1;
    END LOOP;
    UPDATE forms SET name = candidate WHERE id = r.id AND name IS DISTINCT FROM candidate;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS forms_tenant_name_unique ON forms (tenant_id, name);
