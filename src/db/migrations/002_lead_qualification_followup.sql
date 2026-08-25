ALTER TABLE leads ADD COLUMN IF NOT EXISTS qualification_step text
  CHECK (qualification_step IS NULL OR qualification_step IN ('name', 'email', 'city', 'objective'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS temperature text NOT NULL DEFAULT 'cold'
  CHECK (temperature IN ('cold', 'warm', 'hot'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_opt_out boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_next_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_last_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_last_error text;

CREATE TABLE IF NOT EXISTS automation_settings (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  monthly_followup_enabled boolean NOT NULL DEFAULT false,
  followup_interval_days integer NOT NULL DEFAULT 30 CHECK (followup_interval_days BETWEEN 28 AND 90),
  followup_max_attempts integer NOT NULL DEFAULT 3 CHECK (followup_max_attempts BETWEEN 1 AND 12),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO automation_settings(project_id)
SELECT id FROM projects WHERE slug = 'bioecos'
ON CONFLICT(project_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS leads_monthly_followup_idx
  ON leads(followup_next_at)
  WHERE temperature = 'hot' AND followup_enabled = true AND followup_opt_out = false;
