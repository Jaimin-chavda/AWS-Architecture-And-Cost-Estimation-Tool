/**
 * integrationRegistry.ts — STEP 1: Integration Registry (data, not logic).
 *
 * One table. Each row: dependency-name regex, ecosystem, role, hosting,
 * optional awsService, protocol, label.
 *
 * Adding support for a new service = adding a row here, never editing code.
 * Policy, layout and validator code must never contain package, repo or
 * framework names — they read this table (or the traits derived from it).
 *
 * Matching is always per dependency name, never against a joined string.
 */

import type { ServiceId } from "./schema.ts";

export type IntegrationEcosystem =
  | "npm"
  | "pip"
  | "maven"
  | "composer"
  | "go"
  | "cargo"
  | "gem"
  | "dotnet"
  | "elixir"
  | "any";

export type IntegrationRole =
  | "data-store"
  | "auth"
  | "payment"
  | "email"
  | "storage"
  | "analytics"
  | "messaging"
  | "llm"
  | "other";

export type IntegrationHosting = "aws-managed" | "third-party" | "in-process";

export type IntegrationProtocol = "HTTPS" | "SMTP" | "SDK" | "TCP";

export interface IntegrationRow {
  /** Matched against a single dependency name (case-insensitive). */
  match: RegExp;
  ecosystem: IntegrationEcosystem | "any";
  role: IntegrationRole;
  hosting: IntegrationHosting;
  /** AWS equivalent when one exists; absent for pure-external services. */
  awsService?: ServiceId;
  protocol: IntegrationProtocol;
  label: string;
}

function r(src: string): RegExp {
  return new RegExp(src, "i");
}

/**
 * Seed table. Broad coverage: databases, BaaS, payment, email, auth, LLM,
 * monitoring SDKs, messaging, storage, analytics. Extend by adding rows.
 */
export const INTEGRATION_REGISTRY: IntegrationRow[] = [
  // --- Relational databases (aws-managed equivalents) ---
  { match: r("^pg$|^pg-promise$|^postgres$|^postgresql$|^psycopg2(-binary)?$|^jackc\\/pgx$|^lib\\/pq$|^gorm\\.io\\/driver\\/postgres$|^org\\.postgresql:postgresql$"), ecosystem: "any", role: "data-store", hosting: "aws-managed", awsService: "RDS", protocol: "TCP", label: "PostgreSQL" },
  { match: r("^mysql2?$|^mariadb$|^pymysql$|^go-sql-driver\\/mysql$|^gorm\\.io\\/driver\\/mysql$|^mysql:mysql-connector-j(a)?$|^mysql-connector-j(ava)?$"), ecosystem: "any", role: "data-store", hosting: "aws-managed", awsService: "RDS", protocol: "TCP", label: "MySQL" },
  { match: r("^sqlite3$|^better-sqlite3$|^mattn\\/go-sqlite3$|^modernc\\.org\\/sqlite$|^gorm\\.io\\/driver\\/sqlite$"), ecosystem: "any", role: "data-store", hosting: "in-process", protocol: "TCP", label: "SQLite" },
  { match: r("^mssql$|^tedious$|^microsoft\\.data\\.sqlclient$|^system\\.data\\.sqlclient$|^microsoft\\.entityframeworkcore\\.sqlserver$"), ecosystem: "any", role: "data-store", hosting: "aws-managed", awsService: "RDS", protocol: "TCP", label: "SQL Server" },
  // --- Document / NoSQL ---
  { match: r("^mongoose$|^mongodb$|^pymongo$|^motor$|^mongodb\\.driver$|^mongodb\\.driver\\.core$|^mongodb\\/mongo-go-driver$|^spring-boot-starter-data-mongodb$|^mongodb-driver-sync$|^mongo-java-driver$"), ecosystem: "any", role: "data-store", hosting: "third-party", awsService: "DocumentDB", protocol: "HTTPS", label: "MongoDB Atlas" },
  // --- Key-value / cache ---
  { match: r("^redis$|^ioredis$|^aioredis$|^django-redis$|^predis\\/predis$|^go-redis\\/redis$|^jedis$|^lettuce$|^redix$"), ecosystem: "any", role: "data-store", hosting: "aws-managed", awsService: "ElastiCache", protocol: "TCP", label: "Redis" },
  { match: r("^memcached$|^memjs$"), ecosystem: "any", role: "data-store", hosting: "aws-managed", awsService: "ElastiCache", protocol: "TCP", label: "Memcached" },
  // --- ORMs (in-process libraries, no network) ---
  { match: r("^@prisma\\/client$|^prisma$|^typeorm$|^sequelize$|^knex$|^sqlalchemy$|^django$|^gorm\\.io\\/gorm$|^hibernate(-core)?$|^doctrine\\/orm$|^microsoft\\.entityframeworkcore$|^ecto(_sql)?$|^activerecord$|^eloquent"), ecosystem: "any", role: "data-store", hosting: "in-process", protocol: "SDK", label: "ORM" },
  { match: r("^alembic$|^flyway-core$|^liquibase-core$|^knex"), ecosystem: "any", role: "data-store", hosting: "in-process", protocol: "SDK", label: "Migration tool" },
  // --- BaaS ---
  { match: r("^firebase$|^firebase-admin$|^firebase-functions$|^firebase-auth$|^firebase-storage$|^@firebase\\/auth$|^@firebase\\/storage$|^@angular\\/fire$"), ecosystem: "any", role: "data-store", hosting: "third-party", protocol: "SDK", label: "Firebase" },
  { match: r("^supabase$|^@supabase\\/.*"), ecosystem: "any", role: "data-store", hosting: "third-party", protocol: "HTTPS", label: "Supabase" },
  { match: r("^appwrite$"), ecosystem: "any", role: "data-store", hosting: "third-party", protocol: "HTTPS", label: "Appwrite" },
  // --- Payment (third-party, network egress) ---
  { match: r("^stripe$|^@stripe\\/stripe-js$|^stripe-python$|^stripe-go$"), ecosystem: "any", role: "payment", hosting: "third-party", protocol: "HTTPS", label: "Stripe" },
  { match: r("^razorpay(-node|-python)?$"), ecosystem: "any", role: "payment", hosting: "third-party", protocol: "HTTPS", label: "Razorpay" },
  { match: r("^paypal.*$|^braintree$|^square$"), ecosystem: "any", role: "payment", hosting: "third-party", protocol: "HTTPS", label: "Payment gateway" },
  // --- Email ---
  { match: r("^nodemailer$|^@sendgrid\\/mail$|^sendgrid(-python|-go)?$|^mailgun$|^smtplib$|^spring-boot-starter-mail$"), ecosystem: "any", role: "email", hosting: "third-party", protocol: "SMTP", label: "Email provider" },
  { match: r("^@aws-sdk\\/client-ses$|^aws-sdk-php.*|.*ses.*"), ecosystem: "any", role: "email", hosting: "aws-managed", awsService: "SES", protocol: "SDK", label: "Amazon SES" },
  // --- Auth ---
  // Self-hosted identity provider: runs inside the VPC as a container, so it
  // is not external egress (unlike SaaS identity providers below). Maps to
  // the managed substitution, never to a secrets store.
  { match: r("^keycloak.*$|^keycloak-js$|^keycloak-connect$|^keycloak-spring-boot-starter$|^keycloak-adapter-core$"), ecosystem: "any", role: "auth", hosting: "in-process", protocol: "SDK", label: "Keycloak" },
  { match: r("^jsonwebtoken$|^passport$|^bcrypt$|^next-auth$|^@auth\\/core$|^oauth$"), ecosystem: "any", role: "auth", hosting: "in-process", protocol: "SDK", label: "Auth library" },
  { match: r("^auth0.*$|^@auth0\\/.*|^okta.*$|^clerk.*$"), ecosystem: "any", role: "auth", hosting: "third-party", protocol: "HTTPS", label: "Identity provider" },
  { match: r("^@aws-sdk\\/client-cognito-identity-provider$"), ecosystem: "any", role: "auth", hosting: "aws-managed", awsService: "Cognito", protocol: "SDK", label: "Amazon Cognito" },
  // --- Storage ---
  { match: r("^@aws-sdk\\/client-s3$|^aws-sdk.*s3$|^awssdk\\.s3$|^boto3$"), ecosystem: "any", role: "storage", hosting: "aws-managed", awsService: "S3", protocol: "SDK", label: "Object storage" },
  { match: r("^multer$|^express-fileupload$|^formidable$"), ecosystem: "any", role: "storage", hosting: "in-process", protocol: "SDK", label: "File upload" },
  // --- Analytics / monitoring SDKs ---
  { match: r("^@sentry\\/.*$|^sentry.*$|^newrelic$|^datadog.*$|^micrometer-registry-prometheus$|^prometheus.*$|^grafana.*$|^zipkin-reporter$|^jaeger.*$"), ecosystem: "any", role: "analytics", hosting: "third-party", protocol: "HTTPS", label: "Observability SDK" },
  { match: r("^mixpanel.*$|^amplitude.*$|^posthog.*$|^segment.*$"), ecosystem: "any", role: "analytics", hosting: "third-party", protocol: "HTTPS", label: "Product analytics" },
  // --- Messaging / queues ---
  { match: r("^kafkajs$|^@confluentinc\\/kafka-javascript$|^confluent-kafka$|^kafka-python$|^spring-kafka$|^kafka-clients$|^kafka-avro-serializer$"), ecosystem: "any", role: "messaging", hosting: "aws-managed", awsService: "MSK", protocol: "TCP", label: "Kafka" },
  { match: r("^bull(mq)?$|^celery$|^sidekiq$|^amqplib$|^pika$"), ecosystem: "any", role: "messaging", hosting: "in-process", protocol: "SDK", label: "Task queue" },
  { match: r("^@aws-sdk\\/client-sqs$|^@aws-sdk\\/client-sns$|^@aws-sdk\\/client-eventbridge$|^@aws-sdk\\/client-kinesis$"), ecosystem: "any", role: "messaging", hosting: "aws-managed", awsService: "SQS", protocol: "SDK", label: "AWS messaging SDK" },
  // --- Search ---
  { match: r("^@opensearch-project\\/opensearch$|^@elastic\\/elasticsearch$|^opensearch-py$|^elasticsearch$|^opensearch(-rest.*|java)?$|^spring-data-(opensearch|elasticsearch)$"), ecosystem: "any", role: "data-store", hosting: "aws-managed", awsService: "OpenSearch", protocol: "HTTPS", label: "OpenSearch" },
  // --- LLM ---
  { match: r("^openai$|^@anthropic-ai\\/sdk$|^@ai-sdk\\/.*$|^ai$|^langchain.*$|^transformers$|^huggingface.*$"), ecosystem: "any", role: "llm", hosting: "third-party", protocol: "HTTPS", label: "LLM provider" },
  { match: r("^torch$|^tensorflow$|^scikit-learn$|^keras$"), ecosystem: "any", role: "llm", hosting: "in-process", protocol: "SDK", label: "ML framework" },
  // --- AWS SDKs (aws-managed, direct service evidence) ---
  { match: r("^@aws-sdk\\/client-dynamodb$"), ecosystem: "npm", role: "data-store", hosting: "aws-managed", awsService: "DynamoDB", protocol: "SDK", label: "DynamoDB SDK" },
  { match: r("^@aws-sdk\\/client-lambda$"), ecosystem: "npm", role: "other", hosting: "aws-managed", awsService: "Lambda", protocol: "SDK", label: "Lambda SDK" },
  { match: r("^@aws-sdk\\/client-rds$"), ecosystem: "npm", role: "data-store", hosting: "aws-managed", awsService: "RDS", protocol: "SDK", label: "RDS SDK" },
  { match: r("^@aws-sdk\\/client-ec2$|^@aws-sdk\\/client-ecs$|^@aws-sdk\\/client-ses$|^@aws-sdk\\/client-cloudwatch$|^@aws-sdk\\/client-kinesis$|^@aws-sdk\\/client-eventbridge$"), ecosystem: "npm", role: "other", hosting: "aws-managed", awsService: "CloudWatch", protocol: "SDK", label: "AWS SDK" },
];

export interface MatchedIntegration extends IntegrationRow {
  dependency: string;
}

/**
 * Match ONE dependency name against the registry. Never call with a joined
 * string — callers must loop over parsed package names individually.
 */
export function matchIntegration(
  dependencyName: string,
  ecosystem: IntegrationEcosystem = "any"
): MatchedIntegration | null {
  const name = dependencyName.trim();
  if (!name) return null;
  // Strip version specifiers and group prefixes for matching, keep original.
  const bare = name.split("@")[0].split(":").pop() ?? name;
  for (const row of INTEGRATION_REGISTRY) {
    if (row.ecosystem !== "any" && ecosystem !== "any" && row.ecosystem !== ecosystem) continue;
    // Reset regex state (global flag not used, but be safe).
    row.match.lastIndex = 0;
    if (row.match.test(name) || row.match.test(bare) || row.match.test(bare.toLowerCase())) {
      return { ...row, dependency: name };
    }
  }
  return null;
}

/** Match each name individually; returns one entry per matched dependency. */
export function matchAllIntegrations(
  dependencyNames: string[],
  ecosystem: IntegrationEcosystem = "any"
): MatchedIntegration[] {
  const out: MatchedIntegration[] = [];
  const seen = new Set<string>();
  for (const dep of dependencyNames) {
    const m = matchIntegration(dep, ecosystem);
    if (m && !seen.has(`${m.label}|${m.role}`)) {
      seen.add(`${m.label}|${m.role}`);
      out.push(m);
    }
  }
  return out;
}

export interface ExternalFallback {
  /** Display name, e.g. "External: api.example.com" or "External: STRIPE_API_KEY". */
  name: string;
  /** Exact cited location: "path:line → snippet". Always present. */
  evidence: string;
  confidence: "low";
}

const ENV_VAR_RE =
  /\b([A-Z][A-Z0-9_]*_(?:API_KEY|API_SECRET|SECRET_KEY|SECRET|TOKEN|URL|ENDPOINT|HOST|DSN|PASSWORD))\b/;
const HOST_RE = /https?:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?:\.[a-z]{2,}))/gi;
const IGNORED_HOSTS = [
  "github.com",
  "raw.githubusercontent.com",
  "amazonaws.com",
  "localhost",
  "example.com",
  "w3.org",
];

/**
 * STEP 2: generic fallback for unknown services.
 * Scans manifest/config content for outbound-endpoint evidence (env var
 * names like *_API_KEY / *_URL / *_ENDPOINT and external hostnames).
 * Emits low-confidence external-service candidates, each with an exact
 * file:line citation. Never emits one without a cited location.
 */
export function detectExternalFallback(
  files: Array<{ path: string; content: string | null }>
): ExternalFallback[] {
  const out: ExternalFallback[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.content) continue;
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (out.length >= 8) return out;
      const env = line.match(ENV_VAR_RE);
      if (env) {
        const key = `var:${env[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            name: `External: ${env[1]}`,
            evidence: `${file.path}:${i + 1} → ${line.trim().slice(0, 120)}`,
            confidence: "low",
          });
        }
        continue;
      }
      HOST_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = HOST_RE.exec(line)) !== null) {
        const host = m[1].toLowerCase();
        if (
          IGNORED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ||
          host.endsWith(".local") ||
          /^\d+\.\d+\.\d+\.\d+$/.test(host)
        ) {
          continue;
        }
        const key = `host:${host}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({
            name: `External: ${host}`,
            evidence: `${file.path}:${i + 1} → ${line.trim().slice(0, 120)}`,
            confidence: "low",
          });
        }
        if (out.length >= 8) return out;
      }
    }
  }
  return out;
}
