/**
 * history.test.ts
 *
 * Tests for the analysis_history store (history.ts):
 *  - all queries are parameterized ($1, $2, ...) — values ride in params,
 *    never interpolated into SQL text (injection check with a hostile title)
 *  - list/get/remove are always scoped to the session user_id
 *  - buildHistoryTitle derives repo names / truncates descriptions
 *
 * No real database — a mock QueryFn captures (text, params).
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/history.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHistoryStore } from "../history.ts";
import type { QueryFn } from "../history.ts";
import {
  buildHistoryTitle,
  HISTORY_OPEN_KEY,
} from "../history-model.ts";

interface Captured {
  text: string;
  params: unknown[];
}

function makeMock(rows: Array<Record<string, unknown>> = [], rowCount = 0) {
  const captured: Captured[] = [];
  const fn: QueryFn = async (text, params) => {
    captured.push({ text, params });
    return { rows, rowCount };
  };
  return { fn, captured };
}

const DB_ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  user_id: "user_abc",
  title: "vercel/next.js",
  source_type: "repo",
  source_input: "https://github.com/vercel/next.js",
  region: "us-east-1",
  user_count: 10000,
  plan_json: { service_plan: { ok: true } },
  diagram_xml: "<mxfile/>",
  created_at: new Date("2026-10-01T00:00:00.000Z"),
};

describe("history store — parameterized queries", () => {
  it("save passes values as $1..$8 params, never interpolated", async () => {
    const { fn, captured } = makeMock([DB_ROW], 1);
    const store = createHistoryStore(fn);
    const hostile = `x'); DROP TABLE analysis_history; --`;
    await store.save({
      userId: "user_abc",
      title: hostile,
      sourceType: "repo",
      sourceInput: "https://github.com/vercel/next.js",
      region: "us-east-1",
      userCount: 10000,
      planJson: { service_plan: { ok: true } },
      diagramXml: "<mxfile/>",
    });
    assert.equal(captured.length, 1);
    const { text, params } = captured[0];
    assert.match(text, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8\)/);
    assert.ok(!text.includes(hostile), "hostile title leaked into SQL text");
    assert.equal(params[0], "user_abc");
    assert.equal(params[1], hostile);
    assert.equal(params[2], "repo");
    assert.equal(params[6], JSON.stringify({ service_plan: { ok: true } }));
  });

  it("list is scoped to one user, newest first", async () => {
    const { fn, captured } = makeMock([DB_ROW], 1);
    const store = createHistoryStore(fn);
    const rows = await store.list("user_abc");
    assert.match(captured[0].text, /WHERE user_id = \$1/);
    assert.match(captured[0].text, /ORDER BY created_at DESC/);
    assert.deepEqual(captured[0].params, ["user_abc", 50]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, DB_ROW.id);
    assert.equal(rows[0].created_at, "2026-10-01T00:00:00.000Z");
  });

  it("get requires both id and owning user_id", async () => {
    const { fn, captured } = makeMock([DB_ROW], 1);
    const store = createHistoryStore(fn);
    const row = await store.get("user_abc", "some-id");
    assert.match(captured[0].text, /WHERE id = \$1 AND user_id = \$2/);
    assert.deepEqual(captured[0].params, ["some-id", "user_abc"]);
    assert.ok(row);
    assert.equal(row?.user_id, "user_abc");
  });

  it("get returns null when the row is not owned by the user", async () => {
    const { fn } = makeMock([], 0);
    const store = createHistoryStore(fn);
    assert.equal(await store.get("other_user", "some-id"), null);
  });

  it("remove requires both id and owning user_id, reports deletion", async () => {
    const { fn, captured } = makeMock([], 1);
    const store = createHistoryStore(fn);
    assert.equal(await store.remove("user_abc", "some-id"), true);
    assert.match(captured[0].text, /DELETE FROM analysis_history/);
    assert.match(captured[0].text, /WHERE id = \$1 AND user_id = \$2/);
    assert.deepEqual(captured[0].params, ["some-id", "user_abc"]);
  });

  it("remove returns false when no row died", async () => {
    const { fn } = makeMock([], 0);
    const store = createHistoryStore(fn);
    assert.equal(await store.remove("user_abc", "missing-id"), false);
  });
});

describe("buildHistoryTitle", () => {
  it("uses owner/repo for github urls", () => {
    assert.equal(
      buildHistoryTitle("github_url", "https://github.com/vercel/next.js"),
      "vercel/next.js"
    );
  });

  it("keeps short descriptions whole, truncates long ones", () => {
    assert.equal(buildHistoryTitle("description", "Small shop site"), "Small shop site");
    const long = `a`.repeat(100);
    assert.equal(buildHistoryTitle("description", long), `${`a`.repeat(60)}…`);
  });
});

describe("history open handoff", () => {
  it("HISTORY_OPEN_KEY is a stable non-empty key", () => {
    assert.ok(HISTORY_OPEN_KEY.length > 0);
    assert.equal(HISTORY_OPEN_KEY, "aws-architect:open-history");
  });
});
