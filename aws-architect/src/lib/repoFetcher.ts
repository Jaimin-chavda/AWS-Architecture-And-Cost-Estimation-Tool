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

export type KeyFileKind = "readme" | "manifest" | "container_ci" | "source";

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

export interface SdkEvidence {
  file: string;
  match: string;
  service: string;
  line?: number;
  filePath?: string;
  matchSnippet?: string;
  serviceHint?: string;
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
  /** Extracted AWS SDK and service evidence from code */
  sdkEvidence: SdkEvidence[];
}

// ---------------------------------------------------------------------------
// Key-file allowlist & patterns (Fix 3 & Fix 4)
// Priority groups: README > manifests > container/CI > source
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

// Monorepo nested manifests (e.g. packages/core/package.json, apps/web/package.json)
const NESTED_MANIFEST_PATTERNS = [
  /^(?:packages|apps|modules|services|libs)\/[^/]+\/(?:package\.json|pom\.xml|build\.gradle(\.kts)?|Cargo\.toml|pyproject\.toml|requirements\.txt|go\.mod)$/i,
];

const CONTAINER_CI_PATTERNS = [
  /^Dockerfile(\.[\w.-]+)?$/i,
  /^(?:docker|build|infra)\/Dockerfile(\.[\w.-]+)?$/i,
  /^docker-compose(\.[\w.-]+)?\.(yml|yaml)$/i,
  /^serverless(\.[\w.-]+)?\.(yml|yaml)$/i,
  /^(?:src|infra|services|functions)\/.*serverless(\.[\w.-]+)?\.(yml|yaml)$/i,
  /^\.github\/workflows\/[^/]+\.(yml|yaml)$/i,
  /^vercel\.json$/i,
  /^netlify\.toml$/i,
  /^amplify\.ya?ml$/i,
  /^amplify\/.*$/i,
  /^cdk\.json$/i,
  /^appspec\.ya?ml$/i,
  /^buildspec\.ya?ml$/i,
  /^\.ebextensions\/.*$/i,
  /^(?:cloudformation|\.cloudformation)\/.*\.(ya?ml|json)$/i,
  /^(?:terraform|infra|\.infra)\/.*\.tf$/i,
  /^.*\.tf$/i,
  /^template\.ya?ml$/i,
  /^sam\.ya?ml$/i,
  /^.*\.template\.ya?ml$/i,
  /^(?:k8s|kubernetes|helm)\/.*\.(ya?ml|json)$/i,
];

const SOURCE_HIGH_PRIORITY_PATTERNS = [
  /(?:^|\/)(?:handler|lambda_function|main|app|server|index)\.(?:js|ts|mjs|cjs|py|go|rs|java)$/i,
  /(?:^|\/)cmd\/main\.go$/i,
  /(?:^|\/)(?:manage|wsgi|asgi)\.py$/i,
  /(?:^|\/).*\.controller\.(?:ts|js)$/i,
];

const SOURCE_GLOB_PATTERNS = [
  /^src\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
  /^src\/[^/]+\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
  /^app\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
  /^app\/[^/]+\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
  /^server\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
  /^server\/[^/]+\/[^/]+\.(?:ts|js|py|go|java|rs|cs|php|rb)$/i,
];

const MAX_TREE_PATHS = 50_000;
const MAX_FILES = 40;
const MAX_FILE_BYTES = 4 * 1024; // 4 KB per file (Fix 3)
const MAX_TOTAL_PAYLOAD_BYTES = 150 * 1024; // 150 KB total payload (Fix 3)
const MAX_COMPACT_TOP_LEVEL = 40;
const GITHUB_API = "https://api.github.com";
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// File-kind classifier & relevance scoring (Fix 3)
// ---------------------------------------------------------------------------

export function classifyFile(
  path: string
): { kind: KeyFileKind; priority: number; score: number } | null {
  const name = path.split("/").pop() ?? path;
  const depth = path.split("/").length - 1; // 0 = root, 1 = one level deep

  for (const re of README_PATTERNS) {
    if (re.test(name) && depth === 0) {
      return { kind: "readme", priority: 0, score: 100 };
    }
  }

  for (const re of MANIFEST_PATTERNS) {
    if (re.test(name) && depth <= 1) {
      return { kind: "manifest", priority: 1, score: 95 - depth * 5 };
    }
  }

  for (const re of NESTED_MANIFEST_PATTERNS) {
    if (re.test(path)) {
      return { kind: "manifest", priority: 1, score: 90 - depth * 5 };
    }
  }

  for (const re of CONTAINER_CI_PATTERNS) {
    if (re.test(path)) {
      return { kind: "container_ci", priority: 2, score: 85 - depth * 5 };
    }
  }

  for (const re of SOURCE_HIGH_PRIORITY_PATTERNS) {
    if (re.test(path)) {
      return { kind: "source", priority: 3, score: 80 - depth * 5 };
    }
  }

  for (const re of SOURCE_GLOB_PATTERNS) {
    if (re.test(path)) {
      return { kind: "source", priority: 3, score: 65 - depth * 5 };
    }
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
// SDK Evidence extraction pass (Fix 3)
// ---------------------------------------------------------------------------

export function extractSdkEvidence(keyFiles: KeyFile[]): SdkEvidence[] {
  const evidence: SdkEvidence[] = [];
  const seen = new Set<string>();

  const add = (file: string, match: string, service: string, line?: number) => {
    const key = `${file}:${service}:${match}`;
    if (!seen.has(key)) {
      seen.add(key);
      evidence.push({
        file,
        filePath: file,
        match: match.slice(0, 100),
        matchSnippet: match.slice(0, 100),
        service,
        serviceHint: service,
        line,
      });
    }
  };

  for (const file of keyFiles) {
    if (!file.content) continue;
    const content = file.content;

    // boto3.client('service') or boto3.resource('service')
    const botoMatches = content.matchAll(/boto3\.(?:client|resource)\(\s*['"]([a-zA-Z0-9_-]+)['"]/g);
    for (const m of botoMatches) {
      const rawSvc = m[1].toLowerCase();
      const svcMap: Record<string, string> = {
        s3: "S3",
        dynamodb: "DynamoDB",
        sqs: "SQS",
        sns: "SNS",
        lambda: "Lambda",
        rds: "RDS",
        ecs: "ECS",
        ec2: "EC2",
        "cognito-idp": "Cognito",
        "cognito-identity": "Cognito",
        eventbridge: "EventBridge",
        events: "EventBridge",
        kinesis: "Kinesis",
        ses: "SES",
        apigateway: "APIGateway",
        cloudwatch: "CloudWatch",
        logs: "CloudWatch",
      };
      const svc = svcMap[rawSvc] ?? rawSvc.toUpperCase();
      add(file.path, m[0], svc);
    }

    // require('aws-sdk')
    const awsSdkMatches = content.matchAll(/require\(\s*['"]aws-sdk['"]\s*\)/g);
    for (const m of awsSdkMatches) {
      add(file.path, m[0], "AWS SDK");
    }

    // require('@aws-sdk/client-...') or from '@aws-sdk/client-...'
    const v3Matches = content.matchAll(/(?:require\(\s*['"]|from\s+['"])@aws-sdk\/client-([\w-]+)['"]/g);
    for (const m of v3Matches) {
      const rawClient = m[1].toLowerCase();
      const clientMap: Record<string, string> = {
        s3: "S3",
        lambda: "Lambda",
        dynamodb: "DynamoDB",
        sqs: "SQS",
        sns: "SNS",
        rds: "RDS",
        "cognito-identity-provider": "Cognito",
        "cognito-idp": "Cognito",
        cloudwatch: "CloudWatch",
        ec2: "EC2",
        ecs: "ECS",
        ses: "SES",
        eventbridge: "EventBridge",
        kinesis: "Kinesis",
        "api-gateway": "APIGateway",
        apigatewayv2: "APIGateway",
      };
      const svc = clientMap[rawClient] ?? rawClient;
      add(file.path, m[0], svc);
    }

    // S3 operations: PutObjectCommand, s3.putObject, s3.upload, etc.
    const s3Ops = content.matchAll(/(?:PutObjectCommand|s3\.putObject|s3\.upload|S3.*PutObject|s3\.getObject|GetObjectCommand)/gi);
    for (const m of s3Ops) {
      add(file.path, m[0], "S3");
    }

    // SQS operations: sqs.sendMessage, SendMessageCommand, etc.
    const sqsOps = content.matchAll(/(?:sqs\.sendMessage|SendMessageCommand|sqs\.send_message|sqs\.receiveMessage)/gi);
    for (const m of sqsOps) {
      add(file.path, m[0], "SQS");
    }

    // DynamoDB operations
    const dynamoOps = content.matchAll(/(?:dynamodb\.putItem|PutItemCommand|dynamodb\.query|QueryCommand|dynamodb\.getItem)/gi);
    for (const m of dynamoOps) {
      add(file.path, m[0], "DynamoDB");
    }

    // WebSocket / socket server bindings
    const wsMatches = content.matchAll(/(?:WebSocketServer|socket\.io|new\s+WebSocket\(|ws\.on\()/gi);
    for (const m of wsMatches) {
      add(file.path, m[0], "APIGateway");
    }

    // cron / schedule decorators
    const cronMatches = content.matchAll(/(?:@schedule|croniter|node-cron|cron\.schedule|@cron)/gi);
    for (const m of cronMatches) {
      add(file.path, m[0], "EventBridge");
    }
  }

  return evidence;
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

  // 3. Classify and relevance-sort files (Fix 3)
  type Candidate = { path: string; kind: KeyFileKind; priority: number; score: number };
  const candidates: Candidate[] = [];
  for (const path of treePaths) {
    const c = classifyFile(path);
    if (c) candidates.push({ path, ...c });
  }

  // Sort by relevance score desc, with shorter path length as tiebreaker
  candidates.sort((a, b) =>
    a.score !== b.score
      ? b.score - a.score
      : a.path.length - b.path.length
  );

  // Apply 40-file cap
  const selected = candidates.slice(0, MAX_FILES);
  if (candidates.length > MAX_FILES) overallTruncated = true;

  // 4. Fetch each selected file (enforcing 4KB/file and 150KB total payload cap)
  const keyFiles: KeyFile[] = [];
  let readmeLength = 0;
  let totalPayloadBytes = 0;

  for (const candidate of selected) {
    if (totalPayloadBytes >= MAX_TOTAL_PAYLOAD_BYTES) {
      overallTruncated = true;
      keyFiles.push({
        path: candidate.path,
        kind: candidate.kind,
        content: null,
        sizeBytes: 0,
        truncated: true,
      });
      continue;
    }

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
        // Read up to MAX_FILE_BYTES (4KB) from file start
        const reader = rawFetch.body?.getReader();
        if (!reader) throw new Error("No body reader");
        const chunks: Uint8Array[] = [];
        let bytesRead = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            bytesRead += value.byteLength;
            if (bytesRead >= MAX_FILE_BYTES) {
              fileTruncated = true;
              overallTruncated = true;
              break;
            }
          }
        }
        reader.cancel().catch(() => {});
        sizeBytes = bytesRead;
        const mergedBytes = chunks.reduce((acc, c) => {
          const merged = new Uint8Array(acc.byteLength + c.byteLength);
          merged.set(acc);
          merged.set(c, acc.byteLength);
          return merged;
        }, new Uint8Array(0));
        rawContent = new TextDecoder().decode(mergedBytes.slice(0, MAX_FILE_BYTES));
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
            if (decoded.length > MAX_FILE_BYTES) {
              fileTruncated = true;
              overallTruncated = true;
            }
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

    totalPayloadBytes += processed.content.length;
    if (totalPayloadBytes > MAX_TOTAL_PAYLOAD_BYTES) {
      overallTruncated = true;
    }

    keyFiles.push({
      path: candidate.path,
      kind: candidate.kind,
      content: processed.content,
      sizeBytes,
      truncated: fileTruncated,
    });
  }

  const sdkEvidence = extractSdkEvidence(keyFiles);

  return {
    repoName,
    defaultBranch,
    keyFiles,
    truncated: overallTruncated,
    parseErrors,
    readmeLength,
    sdkEvidence,
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
    sdkEvidence: [],
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

import type { Grounding } from "./schema.ts";

/**
 * Converts RepoSignals into the flat RuleInput that the rule engine expects.
 */
export function signalsToRuleInput(
  signals: RepoSignals,
  inputKind: "github_url" | "description",
  grounding: Grounding
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
