/**
 * repoFetcher.ts  —  FLOW.md Stage 2: Evidence extraction
 *
 * Fetches README + key config files from a GitHub repo via the REST API.
 * All bounds from Decision 22–27 / flaw 1 are applied here:
 *   - 50 k-path tree cap
 *   - 20-file cap, priority-ordered (README → manifests → container/CI)
 *   - 64 KB raw read cap per file
 *   - Structured files compacted (JSON → first 40 top-level keys re-serialised;
 *     YAML → parseDocument → first 40 top-level entries stringified)
 *   - Unparseable → {name, sizeBytes} filename-only signal
 *   - SSRF: only github.com host, no redirect following
 *   - Unauthenticated path works (60 req/hr); GITHUB_TOKEN lifts to 5k/hr
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KeyFileKind = "readme" | "manifest" | "container_ci";

export interface KeyFile {
  path: string;
  kind: KeyFileKind;
  /** Full (possibly compacted) content, or null if only filename-only signal */
  content: string | null;
  /** Original byte size before any cap/compaction */
  sizeBytes: number;
  /** True if this file was size-capped or compacted */
  truncated: boolean;
}

export interface RepoSignals {
  repoName: string; // "owner/repo"
  defaultBranch: string;
  keyFiles: KeyFile[];
  /** True if any file or the tree was capped */
  truncated: boolean;
  parseErrors: string[]; // paths that failed structured parse
  /** Raw character length of the README content (0 if no README) */
  readmeLength: number;
}

// ---------------------------------------------------------------------------
// Key-file allowlist (Decision 23)
// Priority groups: README > manifests > container/CI
// ---------------------------------------------------------------------------

const README_PATTERNS = [/^readme(\.\w+)?$/i];

const MANIFEST_PATTERNS = [
  /^package\.json$/,
  /^requirements\.txt$/,
  /^pyproject\.toml$/,
  /^go\.mod$/,
  /^cargo\.toml$/i,
  /^gemfile$/i,
  /^composer\.json$/,
  /^pom\.xml$/,
  /^build\.gradle(\.kts)?$/,
  /^[\w.-]+\.csproj$/,
];

const CONTAINER_CI_PATTERNS = [
  /^dockerfile$/i,
  /^docker-compose\.(yml|yaml)$/i,
  /^serverless\.(yml|yaml)$/,
  /^\.github\/workflows\/[^/]+\.(yml|yaml)$/,
  /^vercel\.json$/,
  /^netlify\.toml$/,
  /^terraform\/[^/]+\.tf$/,
  /^template\.yaml$/,
];

const MAX_TREE_PATHS = 50_000;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 64 * 1024; // 64 KB
const MAX_COMPACT_TOP_LEVEL = 40;
const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// File-kind classifier
// ---------------------------------------------------------------------------

function classifyFile(
  path: string
): { kind: KeyFileKind; priority: number } | null {
  const name = path.split("/").pop() ?? path;
  const depth = path.split("/").length - 1; // 0 = root, 1 = one level deep

  for (const re of README_PATTERNS) {
    if (re.test(name) && depth === 0) return { kind: "readme", priority: 0 };
  }
  for (const re of MANIFEST_PATTERNS) {
    if (re.test(name) && depth <= 1) return { kind: "manifest", priority: 1 };
  }
  for (const re of CONTAINER_CI_PATTERNS) {
    if (re.test(path)) return { kind: "container_ci", priority: 2 };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Structured-file compaction helpers (Decision 24)
// ---------------------------------------------------------------------------

function compactJson(raw: string): { content: string; truncated: boolean } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      // Not a plain object — return raw (capped) rather than corrupted
      return { content: raw, truncated: false };
    }
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length <= MAX_COMPACT_TOP_LEVEL) {
      return { content: JSON.stringify(obj, null, 2), truncated: false };
    }
    const compact: Record<string, unknown> = {};
    for (const k of keys.slice(0, MAX_COMPACT_TOP_LEVEL)) compact[k] = obj[k];
    return { content: JSON.stringify(compact, null, 2), truncated: true };
  } catch {
    return { content: raw, truncated: false }; // unparseable — caller marks parseError
  }
}

function compactYaml(raw: string): { content: string; truncated: boolean; error?: boolean } {
  try {
    const parsed: unknown = parseYaml(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { content: raw, truncated: false };
    }
    const obj = parsed as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length <= MAX_COMPACT_TOP_LEVEL) {
      return { content: stringifyYaml(obj), truncated: false };
    }
    const compact: Record<string, unknown> = {};
    for (const k of keys.slice(0, MAX_COMPACT_TOP_LEVEL)) compact[k] = obj[k];
    return { content: stringifyYaml(compact), truncated: true };
  } catch {
    return { content: raw, truncated: false, error: true };
  }
}

/** Line-trim for TOML/XML/prose (never raw-truncate mid-structure for YAML/JSON) */
function lineLimit(raw: string, maxLines: number): { content: string; truncated: boolean } {
  const lines = raw.split("\n");
  if (lines.length <= maxLines) return { content: raw, truncated: false };
  return { content: lines.slice(0, maxLines).join("\n"), truncated: true };
}

// ---------------------------------------------------------------------------
// Process a single file's raw content
// ---------------------------------------------------------------------------

function processContent(
  path: string,
  raw: string,
  parseErrors: string[]
): { content: string; truncated: boolean } {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "json") {
    const result = compactJson(raw);
    // If compactJson couldn't even parse, the raw is returned — detect that
    try { JSON.parse(raw); } catch { parseErrors.push(path); return { content: raw.slice(0, 1000), truncated: true }; }
    return result;
  }

  if (ext === "yml" || ext === "yaml") {
    const result = compactYaml(raw);
    if (result.error) {
      parseErrors.push(path);
      return { content: raw.slice(0, 1000), truncated: true };
    }
    return { content: result.content, truncated: result.truncated };
  }

  if (ext === "toml" || ext === "xml") {
    return lineLimit(raw, 200);
  }

  // Prose / README / plain text: just line-cap (already byte-capped before this call)
  return { content: raw, truncated: false };
}

// ---------------------------------------------------------------------------
// GitHub REST fetch helpers
// ---------------------------------------------------------------------------

function ghHeaders(token?: string): HeadersInit {
  const h: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function ghFetch(url: string, token?: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: ghHeaders(token),
      signal: controller.signal,
      redirect: "error", // SSRF guard: never follow redirects
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fetches evidence signals from a GitHub repo URL.
 * Decision 26: server-side GITHUB_TOKEN via env; unauthenticated path works at 60 req/hr.
 * Decision 27: host allowlist enforced before this is called (in the route); here we
 *              additionally never follow redirects.
 * Never throws — errors in individual file fetches are swallowed and flagged as parseErrors.
 */
export async function fetchRepoSignals(
  repoUrl: string,
  githubToken?: string
): Promise<RepoSignals> {
  // Parse owner/repo from URL
  const url = new URL(repoUrl);
  const parts = url.pathname.replace(/^\//, "").split("/");
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/, "");

  if (!owner || !repo) {
    return emptySignals(`${owner ?? "?"}/${repo ?? "?"}`, "could-not-parse-url");
  }

  const repoName = `${owner}/${repo}`;
  const parseErrors: string[] = [];
  let overallTruncated = false;

  // 1. Get default branch
  let defaultBranch = "main";
  try {
    const metaRes = await ghFetch(`${GITHUB_API}/repos/${owner}/${repo}`, githubToken);
    if (metaRes.ok) {
      const meta = (await metaRes.json()) as { default_branch?: string };
      defaultBranch = meta.default_branch ?? "main";
    }
  } catch {
    // fall through with "main"
  }

  // 2. Get file tree
  let treePaths: string[] = [];
  try {
    const treeRes = await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`,
      githubToken
    );
    if (treeRes.ok) {
      const treeData = (await treeRes.json()) as {
        tree?: { path: string; type: string; size?: number }[];
        truncated?: boolean;
      };
      if (treeData.truncated) overallTruncated = true;
      treePaths = (treeData.tree ?? [])
        .filter((t) => t.type === "blob")
        .map((t) => t.path)
        .slice(0, MAX_TREE_PATHS);
    }
  } catch {
    // fall through with empty tree — freeform description still works
  }

  // 3. Classify and priority-sort files
  type Candidate = { path: string; kind: KeyFileKind; priority: number };
  const candidates: Candidate[] = [];
  for (const path of treePaths) {
    const c = classifyFile(path);
    if (c) candidates.push({ path, ...c });
  }
  // Sort: README (0) → manifests (1) → container/CI (2); within group, shorter path first
  candidates.sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : a.path.length - b.path.length
  );

  // Apply 20-file cap
  const selected = candidates.slice(0, MAX_FILES);
  if (candidates.length > MAX_FILES) overallTruncated = true;

  // 4. Fetch each selected file
  const keyFiles: KeyFile[] = [];
  let readmeLength = 0;

  for (const candidate of selected) {
    let raw: string | null = null;
    let sizeBytes = 0;
    let fileTruncated = false;

    try {
      const rawRes = await ghFetch(
        `${GITHUB_API}/repos/${owner}/${repo}/contents/${candidate.path}`,
        githubToken
      );
      // Request raw content
      const rawController = new AbortController();
      const rawTimer = setTimeout(() => rawController.abort(), FETCH_TIMEOUT_MS);
      let rawContent: string;
      try {
        const rawFetch = await fetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${candidate.path}`,
          {
            headers: githubToken ? { Authorization: `Bearer ${githubToken}` } : {},
            signal: rawController.signal,
            redirect: "error",
          }
        );
        clearTimeout(rawTimer);
        if (!rawFetch.ok) throw new Error(`HTTP ${rawFetch.status}`);
        // Read up to MAX_FILE_BYTES
        const reader = rawFetch.body?.getReader();
        if (!reader) throw new Error("No body reader");
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            totalBytes += value.byteLength;
            if (totalBytes >= MAX_FILE_BYTES) {
              fileTruncated = true;
              overallTruncated = true;
              break;
            }
          }
        }
        reader.cancel().catch(() => {});
        sizeBytes = totalBytes;
        rawContent = new TextDecoder().decode(
          chunks.reduce((acc, c) => {
            const merged = new Uint8Array(acc.byteLength + c.byteLength);
            merged.set(acc); merged.set(c, acc.byteLength);
            return merged;
          }, new Uint8Array(0))
        );
        raw = rawContent;
      } catch {
        clearTimeout(rawTimer);
        // Try the JSON contents API as fallback (returns base64)
        if (rawRes.ok) {
          const data = (await rawRes.json()) as { content?: string; size?: number };
          sizeBytes = data.size ?? 0;
          if (data.content) {
            const decoded = Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
            raw = decoded.slice(0, MAX_FILE_BYTES);
            if (decoded.length > MAX_FILE_BYTES) { fileTruncated = true; overallTruncated = true; }
          }
        }
      }
    } catch {
      // File fetch failed entirely — filename-only signal
      parseErrors.push(candidate.path);
      keyFiles.push({ path: candidate.path, kind: candidate.kind, content: null, sizeBytes: 0, truncated: false });
      continue;
    }

    if (raw === null) {
      parseErrors.push(candidate.path);
      keyFiles.push({ path: candidate.path, kind: candidate.kind, content: null, sizeBytes, truncated: false });
      continue;
    }

    // Track README length (before compaction)
    if (candidate.kind === "readme") {
      readmeLength = raw.length;
    }

    // Process / compact content
    const processed = processContent(candidate.path, raw, parseErrors);
    if (processed.truncated) { fileTruncated = true; overallTruncated = true; }

    keyFiles.push({
      path: candidate.path,
      kind: candidate.kind,
      content: processed.content,
      sizeBytes,
      truncated: fileTruncated,
    });
  }

  return {
    repoName,
    defaultBranch,
    keyFiles,
    truncated: overallTruncated,
    parseErrors,
    readmeLength,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySignals(repoName: string, _reason: string): RepoSignals {
  return {
    repoName,
    defaultBranch: "main",
    keyFiles: [],
    truncated: false,
    parseErrors: [],
    readmeLength: 0,
  };
}

/**
 * Checks the insufficient-signal gate (Decision 20 / flaw 8).
 * Returns true if the repo has too little signal to run inference.
 */
export function isInsufficientSignal(signals: RepoSignals): boolean {
  const hasManifestOrCI = signals.keyFiles.some(
    (f) => f.kind === "manifest" || f.kind === "container_ci"
  );
  return !hasManifestOrCI && signals.readmeLength < 100;
}

/**
 * Converts RepoSignals into the flat RuleInput that the rule engine expects.
 */
export function signalsToRuleInput(
  signals: RepoSignals,
  inputKind: "github_url" | "description",
  grounding: "repo" | "description"
): import("./ruleEngine.ts").RuleInput {
  const fileContent = signals.keyFiles
    .map((f) => (f.content ? `### ${f.path}\n${f.content}` : `### ${f.path} (parse error)`))
    .join("\n\n");
  const fileNames = signals.keyFiles.map((f) => f.path.split("/").pop() ?? f.path);

  return {
    description: "",
    fileContent,
    fileNames,
    inputKind,
    grounding,
    truncated: signals.truncated,
    parseErrors: signals.parseErrors,
  };
}
