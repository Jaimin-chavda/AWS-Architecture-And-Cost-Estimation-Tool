/**
 * history.ts — analysis_history persistence (SERVER ONLY — imports `pg`).
 *
 * Every query uses positional parameters ($1, $2, ...). user_id always comes
 * from the server session (getSessionUser), never from client input — the
 * API routes enforce this, and the store functions take userId explicitly so
 * ownership scoping is visible and testable.
 *
 * Client pages must import from history-model.ts instead, so `pg` never
 * enters the browser bundle.
 *
 * The default store runs against the shared pg pool. Tests inject a mock
 * query function via createHistoryStore().
 */

import { query as poolQuery } from "./db.ts";
import type {
  AnalysisHistoryRow,
  SaveAnalysisInput,
} from "./history-model.ts";

export type { AnalysisHistoryRow, SaveAnalysisInput, SourceType } from "./history-model.ts";
export { HISTORY_OPEN_KEY, buildHistoryTitle } from "./history-model.ts";

export type QueryFn = (
  text: string,
  params: unknown[]
) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }>;

function rowToHistory(r: Record<string, unknown>): AnalysisHistoryRow {
  return {
    id: String(r.id),
    user_id: String(r.user_id),
    title: String(r.title),
    source_type: r.source_type === "repo" ? "repo" : "idea",
    source_input: String(r.source_input),
    region: String(r.region),
    user_count: Number(r.user_count),
    plan_json: r.plan_json,
    diagram_xml: r.diagram_xml == null ? null : String(r.diagram_xml),
    created_at:
      r.created_at instanceof Date
        ? r.created_at.toISOString()
        : String(r.created_at),
  };
}

export function createHistoryStore(runQuery: QueryFn = poolQuery) {
  return {
    /** Insert one saved analysis. Throws on DB error — callers decide. */
    async save(input: SaveAnalysisInput): Promise<AnalysisHistoryRow> {
      const res = await runQuery(
        `INSERT INTO analysis_history
           (user_id, title, source_type, source_input, region, user_count, plan_json, diagram_xml)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, user_id, title, source_type, source_input, region, user_count, plan_json, diagram_xml, created_at`,
        [
          input.userId,
          input.title,
          input.sourceType,
          input.sourceInput,
          input.region,
          input.userCount,
          JSON.stringify(input.planJson),
          input.diagramXml,
        ]
      );
      return rowToHistory(res.rows[0]);
    },

    /** Newest-first list for one user. */
    async list(userId: string, limit = 50): Promise<AnalysisHistoryRow[]> {
      const res = await runQuery(
        `SELECT id, user_id, title, source_type, source_input, region, user_count, plan_json, diagram_xml, created_at
         FROM analysis_history
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, limit]
      );
      return res.rows.map(rowToHistory);
    },

    /** Single row, only when owned by the user. */
    async get(userId: string, id: string): Promise<AnalysisHistoryRow | null> {
      const res = await runQuery(
        `SELECT id, user_id, title, source_type, source_input, region, user_count, plan_json, diagram_xml, created_at
         FROM analysis_history
         WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
      if (res.rows.length === 0) return null;
      return rowToHistory(res.rows[0]);
    },

    /** Delete one row, only when owned by the user. True when a row died. */
    async remove(userId: string, id: string): Promise<boolean> {
      const res = await runQuery(
        `DELETE FROM analysis_history
         WHERE id = $1 AND user_id = $2`,
        [id, userId]
      );
      return res.rowCount > 0;
    },
  };
}

/** Default store against the shared pool. */
export const historyStore = createHistoryStore();
