CREATE TABLE IF NOT EXISTS dashboard_sessions (
  nonce text PRIMARY KEY,
  username text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dashboard_sessions_active_idx
  ON dashboard_sessions(expires_at) WHERE revoked_at IS NULL;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_project_phone_hash_unique
  ON contacts(project_id, phone_hash) WHERE phone_hash IS NOT NULL;
