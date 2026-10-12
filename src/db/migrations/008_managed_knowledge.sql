CREATE TABLE IF NOT EXISTS managed_knowledge_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL UNIQUE REFERENCES knowledge_documents(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('knowledge', 'course', 'qa', 'institutional', 'rule', 'procedure', 'document')),
  category text NOT NULL DEFAULT 'Geral',
  title text NOT NULL,
  content text NOT NULL,
  course_name text,
  structured_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'active', 'inactive', 'conflict', 'error')),
  active boolean NOT NULL DEFAULT false,
  conflict_details text,
  source_filename text,
  source_mime text,
  source_size integer,
  source_data bytea,
  content_hash text NOT NULL,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS managed_knowledge_project_idx
  ON managed_knowledge_entries(project_id, active, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS managed_knowledge_search_idx
  ON managed_knowledge_entries USING gin(to_tsvector('portuguese', title || ' ' || content || ' ' || coalesce(course_name, '') || ' ' || category));
CREATE UNIQUE INDEX IF NOT EXISTS managed_knowledge_content_unique
  ON managed_knowledge_entries(project_id, content_hash) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS managed_knowledge_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL REFERENCES managed_knowledge_entries(id) ON DELETE CASCADE,
  version integer NOT NULL,
  snapshot jsonb NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(entry_id, version)
);

CREATE INDEX IF NOT EXISTS managed_knowledge_versions_entry_idx
  ON managed_knowledge_versions(entry_id, version DESC);

CREATE TABLE IF NOT EXISTS knowledge_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entry_id uuid REFERENCES managed_knowledge_entries(id) ON DELETE SET NULL,
  course_name text,
  category text NOT NULL DEFAULT 'Geral',
  description text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  filename text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  sha256 text NOT NULL,
  data bytea NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS knowledge_media_project_idx
  ON knowledge_media(project_id, active, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS knowledge_media_search_idx
  ON knowledge_media USING gin(to_tsvector('portuguese', description || ' ' || coalesce(course_name, '') || ' ' || category));
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_media_sha_unique
  ON knowledge_media(project_id, sha256) WHERE deleted_at IS NULL;
