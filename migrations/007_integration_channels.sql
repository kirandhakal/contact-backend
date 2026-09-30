ALTER TABLE destinations DROP CONSTRAINT IF EXISTS destinations_kind_check;
ALTER TABLE destinations ADD CONSTRAINT destinations_kind_check CHECK (kind IN ('email', 'webhook', 'sms', 'discord'));
