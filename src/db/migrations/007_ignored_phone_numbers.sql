CREATE TABLE IF NOT EXISTS ignored_phone_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  phone_hash text NOT NULL,
  name text,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, phone_hash)
);

CREATE INDEX IF NOT EXISTS ignored_phone_numbers_active_lookup_idx
  ON ignored_phone_numbers(project_id, phone_hash) WHERE active = true;
