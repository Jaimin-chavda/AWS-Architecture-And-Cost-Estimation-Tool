/**
 * /login — email + password sign-in / sign-up (client).
 *
 * Inline errors, no query params. After login, redirect to the home page.
 * Styling matches the main input card (glass panel, pill tabs, accent CTA).
 */

"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Compass, ShieldAlert } from "lucide-react";
import { signIn, signUp } from "@/lib/auth-client";
import { SiteHeader } from "@/components/SiteHeader";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        const res = await signIn.email({ email: email.trim(), password });
        if (res.error) {
          setError(res.error.message ?? "Sign in failed. Check your credentials.");
          return;
        }
      } else {
        if (name.trim().length < 2) {
          setError("Name must be at least 2 characters long.");
          return;
        }
        const res = await signUp.email({
          email: email.trim(),
          password,
          name: name.trim(),
        });
        if (res.error) {
          setError(res.error.message ?? "Sign up failed. Try a different email.");
          return;
        }
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message ?? "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  return (
    <div className="relative flex min-h-screen flex-col font-sans">
      <SiteHeader />

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center px-4 py-6 sm:px-6 sm:py-8">
        <div className="my-auto flex w-full flex-col items-center">
          <div className="mb-8 text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent-light shadow-[0_0_20px_rgba(167,139,250,0.12)]">
              <Compass className="h-3.5 w-3.5 text-accent" />
              <span>Account access</span>
            </div>
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              {mode === "signin" ? "Welcome back" : "Create your account"}
            </h1>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-muted">
              {mode === "signin"
                ? "Sign in to save architectures and reopen them anytime."
                : "Sign up to save architectures and reopen them anytime."}{" "}
              Guests can still generate architectures without logging in — nothing is saved for them.
            </p>
          </div>

          <div className="glass-panel w-full max-w-md rounded-3xl p-6 shadow-2xl sm:p-8">
            <div className="mb-6 flex rounded-full border border-border bg-surface-2 p-1">
              {(["signin", "signup"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => switchMode(m)}
                  className={`flex flex-1 items-center justify-center rounded-full py-2 text-xs font-medium transition-all ${
                    mode === m
                      ? "bg-accent font-semibold text-on-accent shadow-md"
                      : "text-muted hover:text-foreground"
                  }`}
                >
                  {m === "signin" ? "Sign in" : "Sign up"}
                </button>
              ))}
            </div>

            <form onSubmit={handleSubmit}>
              {mode === "signup" && (
                <div className="mb-4">
                  <label
                    htmlFor="name"
                    className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted"
                  >
                    Name
                  </label>
                  <input
                    id="name"
                    type="text"
                    autoComplete="name"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required={mode === "signup"}
                    className="w-full rounded-2xl border border-border bg-surface-2/70 px-4 py-3 text-sm text-foreground placeholder:text-muted/50 transition-all focus:border-accent/60 focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/20"
                  />
                </div>
              )}

              <div className="mb-4">
                <label
                  htmlFor="email"
                  className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted"
                >
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="w-full rounded-2xl border border-border bg-surface-2/70 px-4 py-3 text-sm text-foreground placeholder:text-muted/50 transition-all focus:border-accent/60 focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/20"
                />
              </div>

              <div>
                <label
                  htmlFor="password"
                  className="mb-2 block text-xs font-medium uppercase tracking-wider text-muted"
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  placeholder={mode === "signin" ? "Your password" : "8+ characters"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full rounded-2xl border border-border bg-surface-2/70 px-4 py-3 text-sm text-foreground placeholder:text-muted/50 transition-all focus:border-accent/60 focus:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent/20"
                />
                {mode === "signup" && (
                  <p className="mt-2 text-[11px] text-muted">
                    At least 8 characters.
                  </p>
                )}
              </div>

              {error && (
                <div className="mt-4 flex items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-xs text-red-300 backdrop-blur-md">
                  <ShieldAlert className="h-5 w-5 shrink-0 text-red-400" />
                  <div>
                    <span className="font-semibold text-red-200">
                      {mode === "signin" ? "Sign in failed" : "Sign up failed"}
                    </span>
                    <p className="mt-0.5 text-red-300/80">{error}</p>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={busy}
                className="mt-6 flex w-full items-center justify-center gap-2.5 rounded-full bg-gradient-to-r from-accent-secondary via-accent to-purple-400 py-3.5 text-sm font-semibold text-on-accent shadow-[0_0_25px_rgba(167,139,250,0.35)] transition-all hover:shadow-[0_0_35px_rgba(167,139,250,0.5)] hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span>{busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</span>
                <ArrowRight className="h-4 w-4" />
              </button>
            </form>

            <p className="mt-5 text-center text-xs text-muted">
              <Link href="/" className="transition-colors hover:text-foreground">
                ← Back to the analyzer (no login needed)
              </Link>
            </p>
          </div>
        </div>
      </main>

      <footer className="border-t border-border/40 py-6 text-center text-xs text-muted">
        <p>AWS Architecture Estimator · SGP University Project</p>
      </footer>
    </div>
  );
}
