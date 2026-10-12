ALTER TABLE coordinator_notifications DROP CONSTRAINT IF EXISTS coordinator_notifications_status_check;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_coordinator_notification_status_check;

UPDATE coordinator_notifications SET status = 'accepted' WHERE status = 'sent';
UPDATE conversations SET coordinator_notification_status = 'accepted' WHERE coordinator_notification_status = 'sent';

ALTER TABLE coordinator_notifications
  ADD COLUMN IF NOT EXISTS source_message_id text,
  ADD COLUMN IF NOT EXISTS recipient_phone text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS accepted_at timestamptz;

ALTER TABLE coordinator_notifications ADD CONSTRAINT coordinator_notifications_status_check
  CHECK (status IN ('pending', 'processing', 'accepted', 'sent', 'failed'));
ALTER TABLE conversations ADD CONSTRAINT conversations_coordinator_notification_status_check
  CHECK (coordinator_notification_status IN ('not_required', 'pending', 'processing', 'accepted', 'sent', 'failed'));

CREATE UNIQUE INDEX IF NOT EXISTS coordinator_notifications_request_idx
  ON coordinator_notifications(conversation_id, source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coordinator_notifications_due_idx
  ON coordinator_notifications(status, next_attempt_at, created_at);
