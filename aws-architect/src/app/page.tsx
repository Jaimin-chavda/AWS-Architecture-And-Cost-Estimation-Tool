"use client";

/**
 * page.tsx — Stage 6: Main application UI
 *
 * Client Component (all interactivity lives here):
 * - Input form: GitHub URL tab + freeform description tab
 * - Loading spinner states
 * - Results tabs: Diagram tab + Cost tab
 * - Diagram tab: draw.io embed iframe via postMessage (init → load XML)
 * - Cost tab: per-service cost table + monthly total
 * - User-count slider (100 → 1M) — pure client-side math via scaleCostRows
 * - Region picker dropdown → POST /api/prices for updated prices
 * - .drawio download button (client-side Blob generation)
 * - Grounding banner ("Inferred from description only…")
 * - Assumptions disclosure (expandable)
 * - Insufficient-signal UI (prompt to switch to freeform)
 * - Warnings display
 */

import { useState, useEffect, useRef, useCallback } from "react";
import type { CostResult } from "@/lib/cost";
import type { ServicePlan, Grounding } from "@/lib/schema";
import { scaleCostRows } from "@/lib/cost";

// ---------------------------------------------------------------------------
// Types matching /api/analyze response
// ---------------------------------------------------------------------------
interface AnalyzeResponse {
  input_kind: string;
  grounding: Grounding;
  service_plan: ServicePlan;
  diagram_xml: string | null;
  cost_rows: CostResult | null;
  warnings: string[];
}

interface InsufficientSignalResponse {
  status: "insufficient_signal";
  message: string;
  prefill: { repoName: string; readmeSnippet: string };
}

type ApiResult = AnalyzeResponse | InsufficientSignalResponse;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const REGIONS = [
  { value: "us-east-1", label: "US East (N. Virginia)" },
  { value: "us-east-2", label: "US East (Ohio)" },
  { value: "us-west-1", label: "US West (N. California)" },
  { value: "us-west-2", label: "US West (Oregon)" },
  { value: "eu-west-1", label: "EU (Ireland)" },
  { value: "eu-west-2", label: "EU (London)" },
  { value: "eu-central-1", label: "EU (Frankfurt)" },
  { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { value: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
  { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { value: "ap-south-1", label: "Asia Pacific (Mumbai)" },
  { value: "sa-east-1", label: "South America (São Paulo)" },
  { value: "ca-central-1", label: "Canada (Central)" },
];

const DRAWIO_EMBED_URL = "https://embed.diagrams.net/?embed=1&ui=atlas&spin=1&modified=unsavedChanges&proto=json";

const USER_COUNT_MARKS = [100, 1_000, 10_000, 100_000, 1_000_000];

function formatUserCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function formatUsd(n: number): string {
  if (n < 0.01) return "< $0.01";
  return `$${n.toFixed(2)}`;
}

function logToLinear(logVal: number): number {
  // Map 0..1 log-space to 100..1_000_000
  return Math.round(100 * Math.pow(10000, logVal));
}

function linearToLog(linear: number): number {
  return Math.log10(linear / 100) / Math.log10(10000);
}

// ---------------------------------------------------------------------------
// Icons (inline SVG, stroke 1.5, consistent)
// ---------------------------------------------------------------------------
function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0"
      aria-hidden="true"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 transition-transform duration-200 ${
        open ? "rotate-180" : ""
      }`}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function GroundingBanner({ grounding }: { grounding: Grounding }) {
  if (grounding === "repo" || grounding === "repoFiles") return null;
  if (grounding === "filenameOnly") {
    return (
      <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
        <AlertIcon />
        <p>
          <span className="font-medium">Inferred from repository file names only</span> — file contents could not be retrieved. Confidence is capped at{" "}
          <span className="font-mono text-amber-200">low</span> for all services.
        </p>
      </div>
    );
  }
  if (grounding === "unfounded") {
    return (
      <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
        <AlertIcon />
        <p>
          <span className="font-medium">Unfounded inference</span> — repository could not be accessed and no file names were resolved. Confidence is capped at{" "}
          <span className="font-mono text-red-200">low</span> for all services.
        </p>
      </div>
    );
  }
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
      <AlertIcon />
      <p>
        <span className="font-medium">Inferred from description only</span> — not
        verified against repository code. Confidence is capped at{" "}
        <span className="font-mono text-amber-200">low</span> for all services.
      </p>
    </div>
  );
}

function WarningsBanner({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="mb-4 space-y-1">
      {warnings.map((w, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-300"
        >
          <AlertIcon />
          <span>{w}</span>
        </div>
      ))}
    </div>
  );
}

function AssumptionsDisclosure({ plan }: { plan: ServicePlan }) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(plan.slots);
  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-border bg-surface-2">
      <button
        className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>Inference assumptions ({entries.length} services)</span>
        <ChevronIcon open={open} />
      </button>
      {open && (
        <ul className="divide-y divide-border border-t border-border">
          {entries.map(([slot, s]) => (
            <li key={slot} className="px-4 py-2 text-xs">
              <span
                className={`mr-2 inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                  s.confidence === "high"
                    ? "bg-accent/15 text-accent"
                    : s.confidence === "medium"
                    ? "bg-sky-500/15 text-sky-400"
                    : "bg-muted/20 text-muted"
                }`}
              >
                {s.confidence}
              </span>
              <span className="font-semibold text-foreground">{s.serviceId}</span>
              <span className="ml-1 text-muted">({slot})</span>
              <span className="ml-2 text-muted">— {s.evidence}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabs (underline-style, shared by input + results)
// ---------------------------------------------------------------------------
function UnderlineTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div
      role="tablist"
      className="flex gap-1 border-b border-border"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
            className={`-mb-px border-b-2 px-3 pb-2.5 pt-1 text-sm font-medium transition-colors ${
              isActive
                ? "border-accent text-foreground"
                : "border-transparent text-muted hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiagramTab: draw.io iframe embed
// ---------------------------------------------------------------------------
function DiagramTab({
  diagramXml,
  filename,
}: {
  diagramXml: string;
  filename: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (ev.source !== iframeRef.current?.contentWindow) return;
      try {
        const msg = JSON.parse(ev.data as string) as { event: string };
        if (msg.event === "init") {
          // draw.io iframe is ready — send the XML
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({ action: "load", xml: diagramXml }),
            "*"
          );
          setReady(true);
        }
      } catch {
        // non-JSON messages from draw.io are expected
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [diagramXml]);

  function handleDownload() {
    const blob = new Blob([diagramXml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          Powered by{" "}
          <a
            href="https://draw.io"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
          >
            draw.io
          </a>
          . Drag nodes to rearrange.
        </p>
        <button
          onClick={handleDownload}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-accent/50 hover:text-accent"
        >
          <DownloadIcon />
          Download .drawio
        </button>
      </div>
      <div className="relative overflow-hidden rounded-lg border border-border">
        {!ready && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-2">
            <span className="text-sm text-muted">Loading diagram…</span>
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={DRAWIO_EMBED_URL}
          className="h-[520px] w-full"
          title="Architecture Diagram"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CostTab: cost table + slider + region picker
// ---------------------------------------------------------------------------
function CostTab({
  initialCost,
  servicePlan,
}: {
  initialCost: CostResult;
  servicePlan: ServicePlan;
}) {
  const [costData, setCostData] = useState<CostResult>(initialCost);
  const [sliderVal, setSliderVal] = useState(linearToLog(initialCost.userCount));
  const [region, setRegion] = useState(initialCost.region);
  const [isRefetching, setIsRefetching] = useState(false);
  const [refetchError, setRefetchError] = useState<string | null>(null);

  const displayedUserCount = Math.round(logToLinear(sliderVal));

  // Scale cost rows client-side for slider changes
  const scaledCost = scaleCostRows(costData, displayedUserCount);

  // Region change → POST /api/prices
  const handleRegionChange = useCallback(
    async (newRegion: string) => {
      setRegion(newRegion);
      setIsRefetching(true);
      setRefetchError(null);
      try {
        const res = await fetch("/api/prices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            service_plan: servicePlan,
            region: newRegion,
            userCount: displayedUserCount,
          }),
        });
        if (!res.ok) {
          const err = (await res.json()) as { error: string };
          throw new Error(err.error ?? "Request failed");
        }
        const data = (await res.json()) as { cost_rows: CostResult };
        setCostData(data.cost_rows);
        setSliderVal(linearToLog(data.cost_rows.userCount));
      } catch (err) {
        setRefetchError((err as Error).message ?? "Failed to fetch prices");
      } finally {
        setIsRefetching(false);
      }
    },
    [servicePlan, displayedUserCount]
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
        {/* User count slider */}
        <div className="flex-1">
          <label className="mb-1.5 block text-xs font-medium text-muted">
            Monthly active users:{" "}
            <span className="font-mono font-semibold text-accent">
              {formatUserCount(displayedUserCount)}
            </span>
          </label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.001}
            value={sliderVal}
            onChange={(e) => setSliderVal(parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="mt-1 flex justify-between text-[10px] text-muted/60">
            {USER_COUNT_MARKS.map((m) => (
              <span key={m}>{formatUserCount(m)}</span>
            ))}
          </div>
        </div>

        {/* Region picker */}
        <div className="min-w-[220px]">
          <label className="mb-1.5 block text-xs font-medium text-muted">
            Region
          </label>
          <select
            value={region}
            onChange={(e) => handleRegionChange(e.target.value)}
            disabled={isRefetching}
            className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground transition-colors focus:border-accent/60 focus:outline-none disabled:opacity-60"
          >
            {REGIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {refetchError && (
        <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-red-400">
          <AlertIcon />
          <span>
            Could not update prices for selected region: {refetchError}. Showing
            previous prices.
          </span>
        </div>
      )}

      {isRefetching && (
        <div className="text-xs text-muted">
          Fetching prices for {region}…
        </div>
      )}

      {/* Cost table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead>
            <tr className="bg-surface">
              <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted">
                Service
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted">
                Unit
              </th>
              <th className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-muted">
                Qty
              </th>
              <th className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-muted">
                Unit Price
              </th>
              <th className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wider text-muted">
                Monthly Est.
              </th>
              <th className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted">
                Source
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-background">
            {scaledCost.rows.map((row) => (
              <tr
                key={row.serviceId}
                className="transition-colors hover:bg-surface"
              >
                <td className="whitespace-nowrap px-4 py-2.5 font-medium text-foreground">
                  {row.serviceId}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted">{row.unitLabel}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs text-muted">
                  {row.quantity >= 1_000_000
                    ? `${(row.quantity / 1_000_000).toFixed(1)}M`
                    : row.quantity >= 1_000
                    ? `${(row.quantity / 1_000).toFixed(1)}k`
                    : row.quantity.toFixed(1)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right font-mono text-xs text-muted">
                  ${row.unitPrice.toPrecision(4)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium text-foreground">
                  {formatUsd(row.monthlyUsd)}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                      row.priceSource === "live"
                        ? "bg-accent/15 text-accent"
                        : "bg-muted/15 text-muted"
                    }`}
                    title={
                      row.priceSource === "live"
                        ? "Fetched from AWS Bulk Pricing"
                        : "Static fallback price"
                    }
                  >
                    {row.priceSource === "live" ? "live" : "fallback"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-surface">
              <td
                colSpan={4}
                className="px-4 py-3 text-sm font-semibold text-muted"
              >
                Estimated Monthly Total
              </td>
              <td className="px-4 py-3 text-right text-base font-bold text-accent">
                {formatUsd(scaledCost.totalMonthlyUsd)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Unpriced services */}
      {scaledCost.unpricedRows.length > 0 && (
        <div className="rounded-lg border border-border bg-surface-2 px-4 py-3">
          <p className="mb-2 text-xs font-semibold text-muted">
            Services without pricing data:
          </p>
          <ul className="space-y-1">
            {scaledCost.unpricedRows.map((r) => (
              <li key={r.serviceId} className="text-xs text-muted">
                <span className="font-medium text-foreground">{r.serviceId}</span> —{" "}
                {r.note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Disclaimer */}
      <p className="text-center text-[11px] text-muted/70">
        This is <strong className="text-muted">not a bill</strong>. Estimates are
        based on baseline quantities and may not reflect your actual usage,
        reserved pricing, savings plans, data transfer, or support costs. Always
        consult the{" "}
        <a
          href="https://calculator.aws/pricing/2/home"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
        >
          AWS Pricing Calculator
        </a>{" "}
        for accurate quotes.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page component
// ---------------------------------------------------------------------------
export default function Home() {
  // Input state
  const [activeTab, setActiveTab] = useState<"github" | "description">("github");
  const [githubUrl, setGithubUrl] = useState("");
  const [description, setDescription] = useState("");

  // Result state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [insufficientSignal, setInsufficientSignal] =
    useState<InsufficientSignalResponse | null>(null);
  const [resultTab, setResultTab] = useState<"diagram" | "cost">("diagram");

  // Submission handler
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setResult(null);
      setInsufficientSignal(null);
      setLoading(true);

      const input =
        activeTab === "github"
          ? { kind: "github_url" as const, value: githubUrl.trim() }
          : { kind: "description" as const, value: description.trim() };

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input }),
        });

        const data = (await res.json()) as ApiResult;

        if (!res.ok) {
          setError((data as { error?: string }).error ?? `HTTP ${res.status}`);
          return;
        }

        if ("status" in data && data.status === "insufficient_signal") {
          setInsufficientSignal(data as InsufficientSignalResponse);
          return;
        }

        setResult(data as AnalyzeResponse);
        setResultTab("diagram");
      } catch (err) {
        setError((err as Error).message ?? "Unknown error");
      } finally {
        setLoading(false);
      }
    },
    [activeTab, githubUrl, description]
  );

  // Switch to description tab and prefill from insufficient signal
  function handleSwitchToDescription(prefill?: string) {
    if (prefill) setDescription(prefill);
    setActiveTab("description");
    setInsufficientSignal(null);
  }

  const diagramFilename = result
    ? `${result.service_plan.pattern}-architecture.drawio`
    : "architecture.drawio";

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-10 font-sans sm:px-6">
      {/* Header */}
      <header className="mb-10">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
          <h1 className="text-lg font-semibold tracking-tight text-foreground">
            AWS Architecture Estimator
          </h1>
        </div>
        <p className="mt-2 text-sm text-muted">
          Infer AWS services and monthly cost estimates from a GitHub repo or
          project description.
        </p>
      </header>

      {/* Input form */}
      <section className="mb-8 rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-5 pt-3">
          <UnderlineTabs
            tabs={[
              { id: "github", label: "GitHub URL" },
              { id: "description", label: "Describe your project" },
            ]}
            active={activeTab}
            onChange={setActiveTab}
          />
        </div>

        <form onSubmit={handleSubmit} className="p-5">
          {activeTab === "github" ? (
            <div>
              <label
                htmlFor="github-url"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                GitHub Repository URL
              </label>
              <input
                id="github-url"
                type="url"
                placeholder="https://github.com/owner/repo"
                value={githubUrl}
                onChange={(e) => setGithubUrl(e.target.value)}
                required
                className="w-full rounded-md border border-border bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/60 transition-colors focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>
          ) : (
            <div>
              <label
                htmlFor="description"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                Project Description
              </label>
              <textarea
                id="description"
                placeholder="Describe your application: what it does, expected traffic, storage needs, any specific AWS services you know you'll use…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                rows={5}
                maxLength={8000}
                className="w-full resize-y rounded-md border border-border bg-background px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/60 transition-colors focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
              <p className="mt-1 text-right text-xs text-muted/60">
                {description.length}/8000
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-6 py-2.5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent/90 active:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <>
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-on-accent border-t-transparent" />
                Analysing…
              </>
            ) : (
              "Analyse Architecture"
            )}
          </button>
        </form>
      </section>

      {/* Error */}
      {error && (
        <div className="mb-6 flex items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-red-400">
          <AlertIcon />
          <span>
            <span className="font-semibold">Error:</span> {error}
          </span>
        </div>
      )}

      {/* Insufficient signal */}
      {insufficientSignal && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-5">
          <h2 className="mb-1 text-sm font-semibold text-amber-300">
            Not enough signal from this repository
          </h2>
          <p className="mb-3 text-sm text-amber-200/80">
            {insufficientSignal.message}
          </p>
          {insufficientSignal.prefill.readmeSnippet && (
            <blockquote className="mb-3 rounded border-l-2 border-amber-500/50 bg-background px-3 py-2 text-xs italic text-muted">
              {insufficientSignal.prefill.readmeSnippet}…
            </blockquote>
          )}
          <button
            onClick={() =>
              handleSwitchToDescription(
                insufficientSignal.prefill.readmeSnippet
                  ? `${insufficientSignal.prefill.repoName}: ${insufficientSignal.prefill.readmeSnippet}`
                  : ""
              )
            }
            className="rounded-md border border-amber-500/40 px-4 py-2 text-sm font-medium text-amber-300 transition-colors hover:border-amber-500/70 hover:bg-amber-500/10"
          >
            Switch to freeform description →
          </button>
        </div>
      )}

      {/* Results */}
      {result && (
        <section className="rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-5 pt-3">
            <UnderlineTabs
              tabs={[
                { id: "diagram", label: "Architecture Diagram" },
                { id: "cost", label: "Cost Estimate" },
              ]}
              active={resultTab}
              onChange={setResultTab}
            />
          </div>

          <div className="p-5">
            {/* Metadata banners */}
            <GroundingBanner grounding={result.grounding} />
            <WarningsBanner warnings={result.warnings} />
            <AssumptionsDisclosure plan={result.service_plan} />

            {resultTab === "diagram" &&
              (result.diagram_xml ? (
                <DiagramTab
                  diagramXml={result.diagram_xml}
                  filename={diagramFilename}
                />
              ) : (
                <div className="rounded-lg bg-surface-2 py-12 text-center text-sm text-muted">
                  Diagram unavailable for this architecture.
                </div>
              ))}

            {resultTab === "cost" &&
              (result.cost_rows ? (
                <CostTab
                  initialCost={result.cost_rows}
                  servicePlan={result.service_plan}
                />
              ) : (
                <div className="rounded-lg bg-surface-2 py-12 text-center text-sm text-muted">
                  Cost estimate unavailable.
                </div>
              ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <footer className="mt-10 text-center text-xs text-muted/70">
        AWS Architecture Estimator — results are illustrative only and may not
        reflect your actual infrastructure.
      </footer>
    </div>
  );
}
