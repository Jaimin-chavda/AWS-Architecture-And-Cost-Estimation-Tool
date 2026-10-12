/**
 * SiteHeader — top navigation bar (client).
 *
 * Guests see a "Sign in" button. Signed-in users see a menu with "History"
 * and "Sign out". Styling matches the existing app header (sticky, blurred,
 * pill buttons). Pages pass page-specific buttons via `actions`.
 */

"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Compass, History, LogOut, User } from "lucide-react";
import { useSession, signOut } from "@/lib/auth-client";

function GithubIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

export function SiteHeader({ actions }: { actions?: React.ReactNode }) {
  const { data: session, isPending } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const router = useRouter();

  const user = session?.user ?? null;

  async function handleSignOut() {
    setMenuOpen(false);
    await signOut();
    router.push("/");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-40 border-b border-border/40 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3.5 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-2xl bg-gradient-to-tr from-accent to-indigo-500 text-on-accent shadow-[0_0_20px_rgba(167,139,250,0.35)]">
            <Compass className="h-5 w-5" />
          </div>
          <div>
            <span className="font-semibold tracking-tight text-foreground sm:text-base">
              AWS Architect
            </span>
            <span className="ml-2 hidden rounded-full border border-accent/25 bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent sm:inline">
              SGP Cloud Modeler
            </span>
          </div>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          {actions}
          <a
            href="https://github.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-surface-2/60 px-3.5 py-1.5 text-xs font-medium text-muted transition-all hover:border-accent/40 hover:text-foreground"
          >
            <GithubIcon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">GitHub</span>
          </a>

          {isPending ? (
            <span className="inline-flex items-center rounded-full border border-border/60 bg-surface px-4 py-1.5 text-xs text-muted">
              …
            </span>
          ) : user ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                className="inline-flex max-w-40 items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-3.5 py-1.5 text-xs font-medium text-accent-light transition-all hover:bg-accent/20 active:scale-95"
              >
                <User className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="truncate">{user.email}</span>
              </button>
              {menuOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Close menu"
                    className="fixed inset-0 z-10 cursor-default"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div
                    role="menu"
                    className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
                  >
                    <Link
                      href="/history"
                      role="menuitem"
                      onClick={() => setMenuOpen(false)}
                      className="flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-2"
                    >
                      <History className="h-3.5 w-3.5 text-accent" />
                      History
                    </Link>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={handleSignOut}
                      className="flex w-full items-center gap-2 border-t border-border/60 px-4 py-2.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-xs font-semibold text-on-accent shadow-[0_0_15px_rgba(167,139,250,0.4)] transition-all hover:brightness-110 active:scale-95"
            >
              Sign in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
