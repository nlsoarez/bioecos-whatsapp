ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workflow_state text NOT NULL DEFAULT 'ai_attending'
  CHECK (workflow_state IN ('ai_attending', 'awaiting_coordinator', 'coordinator_attending', 'conversation_finished', 'enrollment_completed', 'not_interested'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS current_owner text NOT NULL DEFAULT 'ai';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handoff_reason text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS coordinator_notification_status text NOT NULL DEFAULT 'not_required'
  CHECK (coordinator_notification_status IN ('not_required', 'pending', 'sent', 'failed'));

ALTER TABLE leads ADD COLUMN IF NOT EXISTS main_questions jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS objections jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS enrollment_status text NOT NULL DEFAULT 'pending'
  CHECK (enrollment_status IN ('pending', 'completed', 'not_interested'));
ALTER TABLE leads ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS followup_sequence_id uuid NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE automation_settings ADD COLUMN IF NOT EXISTS followup_schedule_days integer[] NOT NULL DEFAULT ARRAY[15, 30, 45];

CREATE TABLE IF NOT EXISTS lead_temperature_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_temperature text CHECK (from_temperature IS NULL OR from_temperature IN ('cold', 'warm', 'hot')),
  to_temperature text NOT NULL CHECK (to_temperature IN ('cold', 'warm', 'hot')),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coordinator_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS followup_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL,
  step integer NOT NULL CHECK (step BETWEEN 1 AND 3),
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'cancelled')),
  content text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_temperature_history_lead_idx ON lead_temperature_history(lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS coordinator_notifications_failed_idx ON coordinator_notifications(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS followup_events_lead_idx ON followup_events(lead_id, created_at DESC);

INSERT INTO lead_temperature_history(lead_id, from_temperature, to_temperature, reason)
SELECT l.id, null, l.temperature, 'Migração do estado existente'
FROM leads l
WHERE NOT EXISTS (SELECT 1 FROM lead_temperature_history h WHERE h.lead_id = l.id);

UPDATE conversations
SET workflow_state = 'awaiting_coordinator', current_owner = 'coordinator',
  handoff_reason = coalesce(handoff_reason, 'Conversa já estava pausada antes da migração')
WHERE automation_paused = true AND workflow_state = 'ai_attending';

-- A régua anterior tinha semântica mensal diferente. Ela é invalidada para evitar
-- disparos inesperados; novas sequências só nascem depois de nova interação elegível.
UPDATE leads SET followup_enabled = false, followup_next_at = null;
UPDATE automation_settings SET monthly_followup_enabled = false, updated_at = now();
