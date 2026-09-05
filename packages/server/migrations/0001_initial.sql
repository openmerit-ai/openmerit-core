CREATE TABLE IF NOT EXISTS openmerit_records (
 workspace text NOT NULL,
 kind text NOT NULL,
 id text NOT NULL,
 data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (workspace, kind, id)
);
CREATE INDEX IF NOT EXISTS openmerit_records_workspace_kind ON openmerit_records(workspace, kind);
CREATE TABLE IF NOT EXISTS openmerit_usage (
 workspace text NOT NULL,
 day text NOT NULL,
 used integer NOT NULL DEFAULT 0,
 PRIMARY KEY (workspace, day)
);
