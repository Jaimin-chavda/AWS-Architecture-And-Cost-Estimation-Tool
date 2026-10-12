/**
 * /api/history — GET: newest-first list of the caller's saved analyses.
 *
 * Login required. Rows are scoped by the session user_id — it comes from
 * getSessionUser(), never from client input.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { historyStore } from "@/lib/history";

export async function GET(): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to view history." }, { status: 401 });
  }
  try {
    const items = await historyStore.list(user.id);
    // List view needs no bulky payloads — drop the plan bundle + diagram XML.
    const slim = items.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      title: row.title,
      source_type: row.source_type,
      source_input: row.source_input,
      region: row.region,
      user_count: row.user_count,
      created_at: row.created_at,
    }));
    return NextResponse.json({ items: slim });
  } catch (err) {
    console.error("[history] list failed:", err);
    return NextResponse.json({ error: "Could not load history." }, { status: 500 });
  }
}
