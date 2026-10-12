/**
 * history-model.ts — pure history shapes + helpers (client-safe).
 *
 * No database imports here: client pages ("/", "/history") import from this
 * module so `pg` never enters the browser bundle. Server code (history.ts,
 * API routes) imports the store from history.ts, which re-exports this.
 */

export type SourceType = "repo" | "idea";

export interface AnalysisHistoryRow {
  id: string;
  user_id: string;
  title: string;
  source_type: SourceType;
  source_input: string;
  region: string;
  user_count: number;
  plan_json: unknown;
  diagram_xml: string | null;
  created_at: string;
}

export interface SaveAnalysisInput {
  userId: string;
  title: string;
  sourceType: SourceType;
  sourceInput: string;
  region: string;
  userCount: number;
  /** Bundle the main view needs to re-render without re-analysis. */
  planJson: unknown;
  diagramXml: string | null;
}

/** sessionStorage key the history page uses to hand an opened item to "/". */
export const HISTORY_OPEN_KEY = "aws-architect:open-history";

/** Short display title: repo name or first 60 chars of description. */
export function buildHistoryTitle(
  kind: "github_url" | "description",
  value: string
): string {
  const clean = value.trim();
  if (kind === "github_url") {
    try {
      const url = new URL(clean);
      const name = url.pathname.replace(/^\//, "").replace(/\/$/, "");
      return name.slice(0, 120) || clean.slice(0, 120);
    } catch {
      return clean.slice(0, 120);
    }
  }
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}
