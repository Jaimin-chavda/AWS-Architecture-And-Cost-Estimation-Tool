/**
 * /api/history/[id] — GET one saved analysis, DELETE one saved analysis.
 *
 * Login required. Both routes scope by the session user_id (never client
 * input): a user can only read or delete their own rows.
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { historyStore } from "@/lib/history";

// Next 15+: context.params is a Promise, must be awaited.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to view history." }, { status: 401 });
  }
  const { id } = await params;
  try {
    const item = await historyStore.get(user.id, id);
    if (!item) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json({ item });
  } catch (err) {
    console.error("[history] get failed:", err);
    return NextResponse.json({ error: "Could not load history item." }, { status: 500 });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to manage history." }, { status: 401 });
  }
  const { id } = await params;
  try {
    const deleted = await historyStore.remove(user.id, id);
    if (!deleted) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[history] delete failed:", err);
    return NextResponse.json({ error: "Could not delete history item." }, { status: 500 });
  }
}
