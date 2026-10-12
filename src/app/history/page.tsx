/**
 * /history — the caller's saved analyses, newest first (client).
 *
 * Open loads the saved result into the main view without re-running
 * analysis: the full record is fetched, stashed in sessionStorage under
 * HISTORY_OPEN_KEY, and "/" picks it up on mount. Delete removes the row.
 * Guests see a sign-in prompt.
 */

"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FolderOpen, History as HistoryIcon, Trash2 } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { HISTORY_OPEN_KEY } from "@/lib/history-model";
import { SiteHeader } from "@/components/SiteHeader";

interface HistoryListItem {
  id: string;
  title: string;
  source_type: "repo" | "idea";
  source_input: string;
  region: string;
  user_count: number;
  created_at: string;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function HistoryPage() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const [items, setItems] = useState<HistoryListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/history");
      if (res.status === 401) {
        setItems([]);
        return;
      }
      if (!res.ok) throw new Error(`Server error (HTTP ${res.status})`);
      const data = (await res.json()) as { items: HistoryListItem[] };
      setItems(data.items ?? []);
    } catch (err) {
      setError((err as Error).message ?? "Could not load history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isPending) return;
    // Deferred so the effect body itself performs no synchronous setState
    // (sessionStorage/session fetch results apply async).
    const t = setTimeout(() => {
      if (session?.user) load();
      else setLoading(false);
    }, 0);
    return () => clearTimeout(t);
  }, [isPending, session, load]);

  async function handleOpen(id: string) {
    setOpeningId(id);
    setError(null);
    try {
      const res = await fetch(`/api/history/${id}`);
      if (!res.ok) throw new Error(`Server error (HTTP ${res.status})`);
      const data = (await res.json()) as { item: unknown };
      sessionStorage.setItem(HISTORY_OPEN_KEY, JSON.stringify(data.item));
      router.push("/");
    } catch (err) {
      setError((err as Error).message ?? "Could not open this analysis.");
      setOpeningId(null);
    }
  }

  async function handleDelete(id: string) {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    setConfirmId(null);
    setError(null);
    try {
      const res = await fetch(`/api/history/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Server error (HTTP ${res.status})`);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      setError((err as Error).message ?? "Could not delete this analysis.");
    }
  }

  const signedIn = Boolean(session?.user);

  return (
    <div className="relative flex min-h-screen flex-col font-sans">
      <SiteHeader />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent-light">
            <HistoryIcon className="h-3.5 w-3.5 text-accent" />
            <span>Saved analyses</span>
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            History
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted">
            {signedIn
              ? "Your past analyses, newest first. Open one to view it again without re-running the analysis."
              : "Sign in to see your saved analyses."}
          </p>
        </div>

        {isPending || (signedIn && loading) ? (
          <div className="glass-panel mx-auto w-full max-w-2xl rounded-3xl p-8 text-center text-sm text-muted">
            Loading…
          </div>
        ) : !signedIn ? (
          <div className="glass-panel mx-auto w-full max-w-md rounded-3xl p-8 text-center shadow-2xl">
            <p className="text-sm text-muted">
              You need an account to keep history. Guests can still generate architectures — nothing is saved for them.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-on-accent shadow-[0_0_15px_rgba(167,139,250,0.4)] transition-all hover:brightness-110 active:scale-95"
            >
              Sign in
            </Link>
          </div>
        ) : error ? (
          <div className="mx-auto w-full max-w-2xl rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-xs text-red-300">
            <span className="font-semibold text-red-200">Couldn&apos;t load history</span>
            <p className="mt-0.5 text-red-300/80">{error}</p>
            <button
              type="button"
              onClick={load}
              className="mt-3 rounded-full border border-border bg-surface px-4 py-1.5 text-xs font-medium text-muted transition-all hover:text-foreground"
            >
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="glass-panel mx-auto w-full max-w-2xl rounded-3xl p-8 text-center shadow-2xl">
            <p className="text-sm text-muted">
              No saved analyses yet. Run an analysis while signed in and it will appear here.
            </p>
            <Link
              href="/"
              className="mt-6 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/15 px-6 py-2.5 text-sm font-semibold text-accent-light transition-all hover:bg-accent/25 active:scale-95"
            >
              New analysis
            </Link>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="glass-panel flex flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {item.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                    <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono">
                      {item.source_type === "repo" ? "repo" : "idea"}
                    </span>
                    <span className="font-mono">{item.region}</span>
                    <span className="font-mono">{item.user_count.toLocaleString()} users</span>
                    <span>{formatDate(item.created_at)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleOpen(item.id)}
                    disabled={openingId === item.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/15 px-4 py-1.5 text-xs font-semibold text-accent-light transition-all hover:bg-accent/25 active:scale-95 disabled:opacity-60"
                  >
                    <FolderOpen className="h-3.5 w-3.5 text-accent" />
                    <span>{openingId === item.id ? "Opening…" : "Open"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(item.id)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-xs font-medium transition-all active:scale-95 ${
                      confirmId === item.id
                        ? "border-red-500/50 bg-red-500/15 font-semibold text-red-200"
                        : "border-border bg-surface text-muted hover:border-red-500/40 hover:text-red-300"
                    }`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>{confirmId === item.id ? "Confirm?" : "Delete"}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="border-t border-border/40 py-6 text-center text-xs text-muted">
        <p>AWS Architecture Estimator · SGP University Project</p>
      </footer>
    </div>
  );
}
