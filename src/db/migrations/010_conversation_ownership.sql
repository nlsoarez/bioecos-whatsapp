ALTER TABLE conversations ADD COLUMN ownership_version integer NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN automation_resumed_at timestamptz;
ALTER TABLE coordinator_notifications ADD COLUMN customer_ack_at timestamptz;
ALTER TABLE coordinator_notifications ADD COLUMN customer_ack_provider_id text;
ALTER TABLE coordinator_notifications ADD COLUMN customer_ack_error text;
-- Conflicting legacy flags never grant permission to the automation.
UPDATE conversations SET automation_paused = true
WHERE current_owner <> 'ai' OR workflow_state <> 'ai_attending';
