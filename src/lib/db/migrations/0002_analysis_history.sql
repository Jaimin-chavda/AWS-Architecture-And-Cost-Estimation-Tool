-- 0002_analysis_history.sql — saved architecture analyses per user.
--
-- One frozen snapshot per successful analysis (logged-in users only).
-- plan_json holds the bundle the main view needs to re-render without
-- re-running analysis: { service_plan, cost_rows, warnings, input_kind,
-- grounding }. Idempotent: safe to run more than once.
-- Run: npm run db:migrate

CREATE TABLE IF NOT EXISTS analysis_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('repo', 'idea')),
  source_input TEXT NOT NULL,
  region TEXT NOT NULL,
  user_count INTEGER NOT NULL,
  plan_json JSONB NOT NULL,
  diagram_xml TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analysis_history_user_created
  ON analysis_history (user_id, created_at DESC);
