-- Operação IA-only, fila durável, retenção e régua mensal real.
UPDATE automation_settings
SET followup_interval_days = 30,
    followup_schedule_days = ARRAY[30, 60, 90],
    updated_at = now();

ALTER TABLE automation_settings ALTER COLUMN followup_schedule_days SET DEFAULT ARRAY[30, 60, 90];

ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_failure_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_locked_at timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_lock_token uuid;

CREATE TABLE IF NOT EXISTS webhook_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_message_id text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS webhook_jobs_pending_idx
  ON webhook_jobs(status, available_at, created_at);

-- Metadados brutos antigos não são necessários para o atendimento e ampliam a exposição de PII.
UPDATE messages SET metadata = '{}'::jsonb WHERE direction = 'inbound' AND metadata <> '{}'::jsonb;
