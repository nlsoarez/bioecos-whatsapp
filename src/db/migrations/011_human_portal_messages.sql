CREATE TABLE human_outbound_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 request_key uuid NOT NULL,
 ownership_version integer NOT NULL,
 actor text NOT NULL,
 content text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','accepted','failed','unknown','cancelled')),
 attempts integer NOT NULL DEFAULT 0,
 provider_message_id text,
 last_error text,
 available_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,request_key)
);
CREATE INDEX human_outbound_due ON human_outbound_jobs(status,available_at);
CREATE INDEX conversation_message_page ON messages(conversation_id,timestamp DESC,id DESC);
