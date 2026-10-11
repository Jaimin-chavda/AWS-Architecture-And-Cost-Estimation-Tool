/**
 * workloadTraits.ts — STEP 3: Traits, not stacks.
 *
 * Derives workload traits from evidence. Both inference paths feed this
 * module; everything downstream reads traits, never stack names.
 *
 * This file contains no package, repo or framework names. Technology
 * recognition happens only through integrationRegistry lookups, whose
 * results are consumed as abstract roles — never matched by name here.
 */

import { matchIntegration } from "./integrationRegistry.ts";
import type { ProjectProfile } from "./repoAnalyzer.ts";
import type { ServiceId } from "./schema.ts";

export type ComputeModel = "container" | "vm" | "serverless" | "none";

export interface WorkloadTraits {
  /** A long-running server process (or endpoint) serves requests. */
  servesRequests: boolean;
  /** Batch-only workload (training, workers): no ingress. */
  batchOnly: boolean;
  /** Static frontend only: CDN + object storage origin, no compute. */
  staticOnly: boolean;
  /** Compute shape. "none" when no backend compute ships with the repo. */
  computeModel: ComputeModel;
  hasRelationalDb: boolean;
  hasDocumentDb: boolean;
  hasKvStore: boolean;
  /** Credentials/tokens/keys in config, or sensitive-role external egress. */
  hasSecrets: boolean;
  /** Third-party integrations whose protocol is network-based (egress). */
  egressTargets: string[];
  /** Cited evidence per trait, for policy explanations. */
  evidence: Partial<Record<keyof Omit<WorkloadTraits, "evidence">, string>>;
}

const CREDENTIAL_RE =
  /\b(password|passwd|secret(_key|key)?|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key|client[_-]?secret|aws_secret|db_password|database_url)\b/i;

const CONTAINER_FILES_RE = /(?:^|\/)dockerfile(\.[\w.-]+)?$/i;
const COMPOSE_FILES_RE = /docker-compose(\.[\w.-]+)?\.(ya?ml)$/i;
const SERVERLESS_FILES_RE =
  /(?:^|\/)(?:serverless(\.[^.]*)?\.(ya?ml)|(template|sam)\.(ya?ml))$/i;
const K8S_FILES_RE =
  /(?:^|\/)(?:k8s|kubernetes(?:-manifests)?|helm(?:-chart)?|deploy|manifests)\//i;

const SERVERLESS_SERVICES: ReadonlySet<string> = new Set([
  "Lambda",
  "StepFunctions",
  "EventBridgeScheduler",
]);
const CONTAINER_SERVICES: ReadonlySet<string> = new Set([
  "ECS",
  "EKS",
  "Fargate",
  "AppRunner",
  "Batch",
]);
const VM_SERVICES: ReadonlySet<string> = new Set([
  "EC2",
  "Lightsail",
  "ElasticBeanstalk",
]);
const RELATIONAL_SERVICES: ReadonlySet<string> = new Set(["RDS", "Aurora"]);
const DOCUMENT_SERVICES: ReadonlySet<string> = new Set([
  "DocumentDB",
  "DynamoDB",
  "Neptune",
  "Keyspaces",
]);
const KV_SERVICES: ReadonlySet<string> = new Set(["ElastiCache", "MemoryDB"]);

const NETWORK_PROTOCOLS: ReadonlySet<string> = new Set([
  "HTTPS",
  "SMTP",
  "TCP",
]);

export interface TraitInputs {
  profile?: ProjectProfile | null;
  /** Detected/mapped AWS service ids from either inference path. */
  serviceIds?: ServiceId[];
  fileNames?: string[];
  /** Combined non-README code/config text for secret scanning. */
  combinedText?: string;
}

function fileHas(fileNames: string[] | undefined, re: RegExp): boolean {
  return (fileNames ?? []).some((f) => re.test(f));
}

/**
 * Collects abstract registry roles for every detected technology label in
 * the profile. Matching is per label through the registry; no name is
 * compared here — only the returned role/hosting/protocol are read.
 */
function registryRoles(profile: ProjectProfile | undefined): {
  roles: Set<string>;
  egress: string[];
  relational: boolean;
  document: boolean;
  kv: boolean;
} {
  const roles = new Set<string>();
  const egress: string[] = [];
  let relational = false;
  let document = false;
  let kv = false;
  if (!profile) return { roles, egress, relational, document, kv };
  const labels = [
    ...profile.frameworks.map((f) => f.name),
    ...profile.databases.map((d) => d.name),
  ];
  const seen = new Set<string>();
  for (const label of labels) {
    const hit = matchIntegration(label);
    if (!hit) continue;
    roles.add(hit.role);
    if (
      hit.hosting === "third-party" &&
      NETWORK_PROTOCOLS.has(hit.protocol) &&
      !seen.has(hit.label)
    ) {
      seen.add(hit.label);
      egress.push(hit.label);
    }
    if (hit.awsService) {
      if (RELATIONAL_SERVICES.has(hit.awsService)) relational = true;
      if (DOCUMENT_SERVICES.has(hit.awsService)) document = true;
      if (KV_SERVICES.has(hit.awsService)) kv = true;
    }
    // Registry rows without an AWS equivalent still carry a role: a
    // third-party document store implies a document workload, etc.
    if (!hit.awsService && hit.hosting !== "in-process") {
      if (hit.role === "data-store" && /document|mongo|nosql/i.test(hit.label)) {
        document = true;
      }
    }
  }
  return { roles, egress, relational, document, kv };
}

export function deriveTraits(inputs: TraitInputs): WorkloadTraits {
  const { profile, serviceIds = [], fileNames = [], combinedText = "" } = inputs;
  const evidence: WorkloadTraits["evidence"] = {};
  const services = new Set<string>(serviceIds);

  const reg = registryRoles(profile ?? undefined);

  const workload =
    profile?.workloadClassification?.primaryWorkload ??
    profile?.workloadClassification?.type ??
    "generic";

  const compTypes = new Set(
    (profile?.discoveredComponents ?? []).map((c) => c.type)
  );
  const hasBackendLike = compTypes.has("backend") || compTypes.has("api");
  const hasFrontend = compTypes.has("frontend");
  const hasWorkerLike = compTypes.has("worker") || compTypes.has("scheduler");

  const isTrainingLike = workload === "ml-training" || workload === "batch";
  const batchOnly =
    isTrainingLike || (hasWorkerLike && !hasBackendLike && !hasFrontend);
  if (isTrainingLike) {
    evidence.batchOnly = `workload classification is ${workload}`;
  }

  const hasComputeService = [...services].some(
    (s) =>
      SERVERLESS_SERVICES.has(s) ||
      CONTAINER_SERVICES.has(s) ||
      VM_SERVICES.has(s) ||
      s === "SageMaker"
  );

  const containerFiles =
    fileHas(fileNames, CONTAINER_FILES_RE) ||
    fileHas(fileNames, COMPOSE_FILES_RE) ||
    fileHas(fileNames, K8S_FILES_RE);
  const serverlessFiles = fileHas(fileNames, SERVERLESS_FILES_RE);

  const staticOnly =
    !batchOnly &&
    !hasBackendLike &&
    !hasWorkerLike &&
    !hasComputeService &&
    !containerFiles &&
    !serverlessFiles &&
    (hasFrontend ||
      services.has("CloudFront") ||
      ((profile?.frameworks.length ?? 0) > 0 &&
        (profile?.databases.length ?? 0) === 0));

  const servesRequests =
    !batchOnly && !staticOnly && (hasBackendLike || hasFrontend || hasComputeService);
  if (servesRequests) {
    evidence.servesRequests =
      hasBackendLike
        ? "service component with ingress evidence"
        : hasComputeService
          ? "compute service with request evidence"
          : "frontend component serves traffic";
  }

  let computeModel: ComputeModel;
  if (staticOnly || profile?.isLibraryOrFramework) {
    computeModel = "none";
  } else if ([...services].some((s) => SERVERLESS_SERVICES.has(s))) {
    computeModel = "serverless";
    evidence.computeModel = "serverless compute service detected";
  } else if (
    [...services].some((s) => CONTAINER_SERVICES.has(s)) ||
    containerFiles
  ) {
    computeModel = "container";
    evidence.computeModel = containerFiles
      ? "container build evidence"
      : "container compute service detected";
  } else if ([...services].some((s) => VM_SERVICES.has(s))) {
    computeModel = "vm";
    evidence.computeModel = "virtual-machine compute service detected";
  } else if (serverlessFiles) {
    computeModel = "serverless";
    evidence.computeModel = "serverless config evidence";
  } else if (!hasComputeService && !hasBackendLike && !hasWorkerLike) {
    computeModel = "none";
  } else {
    computeModel = "container";
    evidence.computeModel = "backend process defaults to container host";
  }

  const hasRelationalDb =
    [...services].some((s) => RELATIONAL_SERVICES.has(s)) || reg.relational;
  const hasDocumentDb =
    [...services].some((s) => DOCUMENT_SERVICES.has(s)) || reg.document;
  const hasKvStore = [...services].some((s) => KV_SERVICES.has(s)) || reg.kv;
  if (hasRelationalDb) evidence.hasRelationalDb = "relational store evidence";
  if (hasDocumentDb) evidence.hasDocumentDb = "document store evidence";
  if (hasKvStore) evidence.hasKvStore = "key-value store evidence";

  const secretHit = combinedText.match(CREDENTIAL_RE);
  const sensitiveEgress = reg.egress.filter((label) => {
    const hit = matchIntegration(label);
    return (
      hit !== null &&
      (hit.role === "auth" ||
        hit.role === "payment" ||
        hit.role === "email" ||
        hit.role === "llm")
    );
  });
  const hasSecrets = Boolean(secretHit) || sensitiveEgress.length > 0;
  if (secretHit) {
    evidence.hasSecrets = `credential pattern in repository config`;
  } else if (sensitiveEgress.length > 0) {
    evidence.hasSecrets = `sensitive-role external integration: ${sensitiveEgress[0]}`;
  }

  const egressTargets = reg.egress;
  if (egressTargets.length > 0) {
    evidence.egressTargets = `${egressTargets.length} external egress target(s)`;
  }

  return {
    servesRequests,
    batchOnly,
    staticOnly,
    computeModel,
    hasRelationalDb,
    hasDocumentDb,
    hasKvStore,
    hasSecrets,
    egressTargets,
    evidence,
  };
}
