/**
 * repoAnalyzer.ts  —  Project Analysis Layer
 *
 * Takes raw RepoSignals and produces a ProjectProfile — a structured
 * understanding of what the repository actually contains, BEFORE any AWS
 * inference happens.
 *
 * Pipeline position:
 *   RepoSignals → analyzeProject() → ProjectProfile → ruleEngine + llmClient
 *
 * This separates the "what does the project use?" step from the
 * "which AWS services does it need?" step. The LLM previously had to do
 * both at once from raw files, which caused hallucinations. Now it only
 * does the inference step; this module does the analysis step deterministically.
 *
 * No network calls. No LLM. Pure TypeScript signal extraction.
 */

import type { RepoSignals, KeyFile } from "./repoFetcher.ts";

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface DetectedTech {
  name: string;
  /** Exact file path and field that proved this technology */
  evidence: string;
  /** How strong the signal is */
  confidence: "high" | "medium" | "low";
}

export interface ProjectProfile {
  /** Primary programming languages detected */
  languages: DetectedTech[];
  /** Frameworks and major libraries (React, Express, Django, etc.) */
  frameworks: DetectedTech[];
  /** Database technologies (PostgreSQL, MongoDB, Redis, etc.) */
  databases: DetectedTech[];
  /** Infrastructure configs found (Docker, K8s, Serverless, Terraform) */
  infrastructure: DetectedTech[];
  /** Entry-point files detected (index.js, main.py, handler.ts, etc.) */
  entryPoints: string[];
  /** Explicit AWS SDK / service references found in code or configs */
  awsUsage: DetectedTech[];
  /** PaaS / hosting configs (Vercel, Netlify, Amplify) */
  deploymentHints: DetectedTech[];
  /** File paths where structured manifest parsing failed */
  parseFailures?: string[];
  /**
   * A concise, structured summary of detected technologies.
   * This is what gets passed to the LLM instead of raw file content.
   */
  summary: string;
}

// ---------------------------------------------------------------------------
// Framework / library fingerprint tables
// ---------------------------------------------------------------------------

// Maps package name → { framework label, category }
export const NPM_FRAMEWORK_MAP: Record<string, { label: string; category: "framework" | "database" | "runtime" }> = {
  // Frontend frameworks
  react: { label: "React", category: "framework" },
  "react-dom": { label: "React", category: "framework" },
  vue: { label: "Vue.js", category: "framework" },
  "@vue/core": { label: "Vue.js", category: "framework" },
  angular: { label: "Angular", category: "framework" },
  "@angular/core": { label: "Angular", category: "framework" },
  svelte: { label: "Svelte", category: "framework" },
  "solid-js": { label: "SolidJS", category: "framework" },
  // Meta-frameworks
  next: { label: "Next.js", category: "framework" },
  nuxt: { label: "Nuxt.js", category: "framework" },
  remix: { label: "Remix", category: "framework" },
  gatsby: { label: "Gatsby", category: "framework" },
  astro: { label: "Astro", category: "framework" },
  // Build tools (signal for static site)
  vite: { label: "Vite", category: "framework" },
  webpack: { label: "Webpack", category: "framework" },
  // Backend frameworks
  express: { label: "Express.js", category: "framework" },
  fastify: { label: "Fastify", category: "framework" },
  koa: { label: "Koa", category: "framework" },
  "@nestjs/core": { label: "NestJS", category: "framework" },
  hono: { label: "Hono", category: "framework" },
  // Databases (npm packages → DB technology)
  mongoose: { label: "MongoDB", category: "database" },
  mongodb: { label: "MongoDB", category: "database" },
  pg: { label: "PostgreSQL", category: "database" },
  "pg-promise": { label: "PostgreSQL", category: "database" },
  postgres: { label: "PostgreSQL", category: "database" },
  mysql: { label: "MySQL", category: "database" },
  mysql2: { label: "MySQL", category: "database" },
  mariadb: { label: "MariaDB", category: "database" },
  sqlite3: { label: "SQLite", category: "database" },
  "better-sqlite3": { label: "SQLite", category: "database" },
  ioredis: { label: "Redis", category: "database" },
  redis: { label: "Redis", category: "database" },
  "@prisma/client": { label: "Prisma ORM", category: "database" },
  prisma: { label: "Prisma ORM", category: "database" },
  typeorm: { label: "TypeORM", category: "database" },
  sequelize: { label: "Sequelize ORM", category: "database" },
  knex: { label: "Knex.js (SQL)", category: "database" },
  "@aws-sdk/client-dynamodb": { label: "DynamoDB", category: "database" },
  "aws-sdk": { label: "AWS SDK v2", category: "framework" },
  // AWS SDK v3 (individual clients → explicit AWS usage)
  "@aws-sdk/client-s3": { label: "S3", category: "framework" },
  "@aws-sdk/client-lambda": { label: "Lambda", category: "framework" },
  "@aws-sdk/client-sqs": { label: "SQS", category: "framework" },
  "@aws-sdk/client-sns": { label: "SNS", category: "framework" },
  "@aws-sdk/client-rds": { label: "RDS", category: "framework" },
  "@aws-sdk/client-cognito-identity-provider": { label: "Cognito", category: "framework" },
  "@aws-sdk/client-cloudwatch": { label: "CloudWatch", category: "framework" },
  "@aws-sdk/client-ec2": { label: "EC2", category: "framework" },
  "@aws-sdk/client-ecs": { label: "ECS", category: "framework" },
  "@aws-sdk/client-ses": { label: "SES", category: "framework" },
  "@aws-sdk/client-eventbridge": { label: "EventBridge", category: "framework" },
  "@aws-sdk/client-kinesis": { label: "Kinesis", category: "framework" },
  // ML
  "@tensorflow/tfjs": { label: "TensorFlow.js", category: "framework" },
  "@tensorflow/tfjs-node": { label: "TensorFlow.js", category: "framework" },
  "openai": { label: "OpenAI SDK", category: "framework" },
  "@anthropic-ai/sdk": { label: "Anthropic SDK", category: "framework" },
};

// Maps pip package name → label
export const PYTHON_PACKAGE_MAP: Record<string, { label: string; category: "framework" | "database" | "runtime" }> = {
  django: { label: "Django", category: "framework" },
  flask: { label: "Flask", category: "framework" },
  fastapi: { label: "FastAPI", category: "framework" },
  starlette: { label: "Starlette", category: "framework" },
  tornado: { label: "Tornado", category: "framework" },
  aiohttp: { label: "aiohttp", category: "framework" },
  celery: { label: "Celery (task queue)", category: "framework" },
  gunicorn: { label: "Gunicorn", category: "framework" },
  uvicorn: { label: "Uvicorn", category: "framework" },
  // Databases
  psycopg2: { label: "PostgreSQL", category: "database" },
  "psycopg2-binary": { label: "PostgreSQL", category: "database" },
  pymysql: { label: "MySQL", category: "database" },
  pymongo: { label: "MongoDB", category: "database" },
  motor: { label: "MongoDB (async)", category: "database" },
  redis: { label: "Redis", category: "database" },
  aioredis: { label: "Redis (async)", category: "database" },
  sqlalchemy: { label: "SQLAlchemy ORM", category: "database" },
  "django-redis": { label: "Redis", category: "database" },
  boto3: { label: "AWS SDK (boto3)", category: "framework" },
  // ML
  tensorflow: { label: "TensorFlow", category: "framework" },
  torch: { label: "PyTorch", category: "framework" },
  "scikit-learn": { label: "scikit-learn", category: "framework" },
  transformers: { label: "HuggingFace Transformers", category: "framework" },
  openai: { label: "OpenAI SDK", category: "framework" },
};

// Maps Go module path fragment → label
export const GO_MODULE_MAP: Record<string, { label: string; category: "framework" | "database" | "runtime" }> = {
  "gin-gonic/gin": { label: "Gin", category: "framework" },
  "labstack/echo": { label: "Echo", category: "framework" },
  "gofiber/fiber": { label: "Fiber", category: "framework" },
  "gorilla/mux": { label: "Gorilla Mux", category: "framework" },
  "go-chi/chi": { label: "Chi", category: "framework" },
  "jackc/pgx": { label: "PostgreSQL", category: "database" },
  "lib/pq": { label: "PostgreSQL", category: "database" },
  "go-sql-driver/mysql": { label: "MySQL", category: "database" },
  "go-redis/redis": { label: "Redis", category: "database" },
  "mongodb/mongo-go-driver": { label: "MongoDB", category: "database" },
  "aws/aws-sdk-go": { label: "AWS SDK (Go v1)", category: "framework" },
  "aws/aws-sdk-go-v2": { label: "AWS SDK (Go v2)", category: "framework" },
};

// Maps Cargo crate name → label (Fix 6)
export const CARGO_PACKAGE_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  tokio: { label: "Tokio", category: "framework" },
  "actix-web": { label: "Actix Web", category: "framework" },
  axum: { label: "Axum", category: "framework" },
  rocket: { label: "Rocket", category: "framework" },
  diesel: { label: "Diesel ORM", category: "database" },
  sqlx: { label: "SQLx", category: "database" },
  "sea-orm": { label: "SeaORM", category: "database" },
  redis: { label: "Redis", category: "database" },
  mongodb: { label: "MongoDB", category: "database" },
  "aws-sdk-s3": { label: "AWS SDK (S3)", category: "aws" },
  "aws-sdk-dynamodb": { label: "AWS SDK (DynamoDB)", category: "aws" },
  "aws-sdk-lambda": { label: "AWS SDK (Lambda)", category: "aws" },
  "aws-sdk-sqs": { label: "AWS SDK (SQS)", category: "aws" },
  "aws-sdk-sns": { label: "AWS SDK (SNS)", category: "aws" },
  rusoto_core: { label: "AWS SDK (Rusoto)", category: "aws" },
  rusoto_s3: { label: "AWS SDK (S3 / Rusoto)", category: "aws" },
  rusoto_dynamodb: { label: "AWS SDK (DynamoDB / Rusoto)", category: "aws" },
  rusoto_sqs: { label: "AWS SDK (SQS / Rusoto)", category: "aws" },
};

// Maps Maven / Gradle artifact name → label (Fix 6)
export const MAVEN_ARTIFACT_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  "spring-boot": { label: "Spring Boot", category: "framework" },
  "spring-boot-starter-web": { label: "Spring Boot", category: "framework" },
  "spring-boot-starter-data-jpa": { label: "Spring Data JPA", category: "framework" },
  quarkus: { label: "Quarkus", category: "framework" },
  "quarkus-core": { label: "Quarkus", category: "framework" },
  micronaut: { label: "Micronaut", category: "framework" },
  "micronaut-core": { label: "Micronaut", category: "framework" },
  hibernate: { label: "Hibernate ORM", category: "database" },
  "hibernate-core": { label: "Hibernate ORM", category: "database" },
  postgresql: { label: "PostgreSQL", category: "database" },
  "mysql-connector-java": { label: "MySQL", category: "database" },
  "mysql-connector-j": { label: "MySQL", category: "database" },
  jedis: { label: "Redis", category: "database" },
  lettuce: { label: "Redis", category: "database" },
  "aws-java-sdk-s3": { label: "AWS SDK (S3)", category: "aws" },
  "aws-java-sdk-dynamodb": { label: "AWS SDK (DynamoDB)", category: "aws" },
  "aws-java-sdk-lambda": { label: "AWS SDK (Lambda)", category: "aws" },
  "aws-java-sdk-sqs": { label: "AWS SDK (SQS)", category: "aws" },
  s3: { label: "AWS SDK v2 (S3)", category: "aws" },
  dynamodb: { label: "AWS SDK v2 (DynamoDB)", category: "aws" },
  lambda: { label: "AWS SDK v2 (Lambda)", category: "aws" },
  sqs: { label: "AWS SDK v2 (SQS)", category: "aws" },
};

// Maps Ruby gem name → label (Fix 6)
export const RUBY_GEM_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  rails: { label: "Ruby on Rails", category: "framework" },
  sinatra: { label: "Sinatra", category: "framework" },
  pg: { label: "PostgreSQL", category: "database" },
  mysql2: { label: "MySQL", category: "database" },
  redis: { label: "Redis", category: "database" },
  sidekiq: { label: "Sidekiq (task queue)", category: "framework" },
  "aws-sdk-s3": { label: "AWS SDK (S3)", category: "aws" },
  "aws-sdk-dynamodb": { label: "AWS SDK (DynamoDB)", category: "aws" },
  "aws-sdk-sqs": { label: "AWS SDK (SQS)", category: "aws" },
  "aws-sdk": { label: "AWS SDK (Ruby)", category: "aws" },
};

// Maps PHP Composer package name → label (Fix 6)
export const PHP_COMPOSER_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  "laravel/framework": { label: "Laravel", category: "framework" },
  "symfony/framework-bundle": { label: "Symfony", category: "framework" },
  "doctrine/orm": { label: "Doctrine ORM", category: "database" },
  "predis/predis": { label: "Redis", category: "database" },
  "aws/aws-sdk-php": { label: "AWS SDK (PHP)", category: "aws" },
};

// Maps .NET / NuGet package name → label (Fix 6)
export const DOTNET_PACKAGE_MAP: Record<string, { label: string; category: "framework" | "database" | "aws" }> = {
  "Microsoft.AspNetCore.App": { label: "ASP.NET Core", category: "framework" },
  "Microsoft.EntityFrameworkCore": { label: "Entity Framework Core", category: "database" },
  "Npgsql.EntityFrameworkCore.PostgreSQL": { label: "PostgreSQL", category: "database" },
  "Pomelo.EntityFrameworkCore.MySql": { label: "MySQL", category: "database" },
  "StackExchange.Redis": { label: "Redis", category: "database" },
  "AWSSDK.S3": { label: "AWS SDK (S3)", category: "aws" },
  "AWSSDK.DynamoDBv2": { label: "AWS SDK (DynamoDB)", category: "aws" },
  "AWSSDK.SQS": { label: "AWS SDK (SQS)", category: "aws" },
  "AWSSDK.Lambda": { label: "AWS SDK (Lambda)", category: "aws" },
  "AWSSDK.Core": { label: "AWS SDK (.NET)", category: "aws" },
};

// ---------------------------------------------------------------------------
// Language detection from file extensions in the tree
// ---------------------------------------------------------------------------

export const LANG_FROM_MANIFEST: Array<{ file: RegExp; lang: string }> = [
  { file: /^package\.json$/, lang: "Node.js/TypeScript" },
  { file: /^requirements\.txt$|^pyproject\.toml$|^setup\.py$/, lang: "Python" },
  { file: /^go\.mod$/, lang: "Go" },
  { file: /^cargo\.toml$/i, lang: "Rust" },
  { file: /^gemfile$/i, lang: "Ruby" },
  { file: /^composer\.json$/, lang: "PHP" },
  { file: /^pom\.xml$|^build\.gradle(\.kts)?$/, lang: "Java/JVM" },
  { file: /^[\w.-]+\.csproj$/, lang: "C#/.NET" },
];

// ---------------------------------------------------------------------------
// Infrastructure detection
// ---------------------------------------------------------------------------

export interface InfraSignal {
  pattern: RegExp;
  label: string;
  confidence: "high" | "medium" | "low";
}

export const INFRA_FILE_SIGNALS: InfraSignal[] = [
  { pattern: /(?:^|\/)Dockerfile(\.[\w.-]+)?$/i, label: "Docker (Dockerfile)", confidence: "high" },
  { pattern: /(?:^|\/)docker-compose(\.[\w.-]+)?\.(ya?ml)$/i, label: "Docker Compose", confidence: "high" },
  { pattern: /(?:^|\/)serverless(\.[\w.-]+)?\.(ya?ml)$/i, label: "Serverless Framework", confidence: "high" },
  { pattern: /(?:^|\/)(?:template|sam)\.(ya?ml)$/i, label: "AWS SAM (template.yaml)", confidence: "high" },
  { pattern: /^(?:terraform|infra|\.infra)\/.*\.tf$|^.*\.tf$/i, label: "Terraform", confidence: "high" },
  { pattern: /^\.github\/workflows\/.+\.(ya?ml)$/i, label: "GitHub Actions CI/CD", confidence: "medium" },
  { pattern: /^(?:kubernetes|k8s|helm)\//i, label: "Kubernetes manifests", confidence: "high" },
  { pattern: /^vercel\.json$/i, label: "Vercel deployment config", confidence: "high" },
  { pattern: /^netlify\.toml$/i, label: "Netlify deployment config", confidence: "high" },
  { pattern: /^amplify\.ya?ml$|^amplify\//i, label: "AWS Amplify config", confidence: "high" },
  { pattern: /^\.ebextensions\//i, label: "Elastic Beanstalk config", confidence: "high" },
  { pattern: /^appspec\.ya?ml$/i, label: "AWS CodeDeploy config", confidence: "high" },
  { pattern: /^buildspec\.ya?ml$/i, label: "AWS CodeBuild config", confidence: "high" },
  { pattern: /^(?:\.cloudformation|cloudformation)\/.*$/i, label: "AWS CloudFormation", confidence: "high" },
  { pattern: /^cdk\.json$/i, label: "AWS CDK config", confidence: "high" },
];

export const DEPLOYMENT_HINT_SIGNALS: InfraSignal[] = [
  { pattern: /^vercel\.json$/i, label: "Vercel", confidence: "high" },
  { pattern: /^netlify\.toml$/i, label: "Netlify", confidence: "high" },
  { pattern: /^amplify\.ya?ml$|^amplify\//i, label: "AWS Amplify", confidence: "high" },
  { pattern: /^\.ebextensions\//i, label: "AWS Elastic Beanstalk", confidence: "high" },
];

// ---------------------------------------------------------------------------
// AWS SDK content-level detection
// ---------------------------------------------------------------------------

const AWS_SDK_CONTENT_PATTERNS: Array<{ pattern: RegExp; service: string }> = [
  { pattern: /from\s+['"]@aws-sdk\/client-s3['"]/,         service: "S3" },
  { pattern: /from\s+['"]@aws-sdk\/client-lambda['"]/,     service: "Lambda" },
  { pattern: /from\s+['"]@aws-sdk\/client-sqs['"]/,        service: "SQS" },
  { pattern: /from\s+['"]@aws-sdk\/client-sns['"]/,        service: "SNS" },
  { pattern: /from\s+['"]@aws-sdk\/client-dynamodb['"]/,   service: "DynamoDB" },
  { pattern: /from\s+['"]@aws-sdk\/client-rds['"]/,        service: "RDS" },
  { pattern: /from\s+['"]@aws-sdk\/client-cognito/,        service: "Cognito" },
  { pattern: /from\s+['"]@aws-sdk\/client-cloudwatch['"]/,  service: "CloudWatch" },
  { pattern: /from\s+['"]@aws-sdk\/client-ec2['"]/,        service: "EC2" },
  { pattern: /from\s+['"]@aws-sdk\/client-ecs['"]/,        service: "ECS" },
  { pattern: /from\s+['"]@aws-sdk\/client-ses['"]/,        service: "SES" },
  { pattern: /from\s+['"]@aws-sdk\/client-eventbridge['"]/,service: "EventBridge" },
  { pattern: /from\s+['"]@aws-sdk\/client-kinesis['"]/,    service: "Kinesis" },
  { pattern: /import boto3/,                                service: "AWS SDK (boto3)" },
  { pattern: /boto3\.client\(['"]([a-z0-9-]+)['"]\)/,      service: "AWS SDK (boto3)" },
  { pattern: /aws-sdk-go/,                                  service: "AWS SDK (Go)" },
];

// ---------------------------------------------------------------------------
// Parsers for specific manifest formats (Fix 6)
// ---------------------------------------------------------------------------

export interface ParsedPackage {
  name: string;
  version?: string;
}

export function parsePyprojectToml(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const lines = content.split(/\r?\n/);
  let section = "";
  let inDepArray = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      inDepArray = false;
      continue;
    }

    if (section === "project.dependencies" || section === "project") {
      if (line.startsWith("dependencies")) {
        inDepArray = true;
      }
      if (inDepArray || section === "project.dependencies") {
        const matches = line.matchAll(/['"]([a-zA-Z0-9_.-]+)(?:\[[^\]]*\])?(?:[><=~!^@][^'"]*)?['"]/g);
        for (const m of matches) {
          if (m[1].toLowerCase() !== "dependencies") {
            packages.push({ name: m[1].toLowerCase() });
          }
        }
        // Only terminate array if line ends with ] (not inside a string like [standard])
        if (/\]\s*,?$/.test(line) && !line.startsWith("dependencies")) {
          inDepArray = false;
        } else if (line.startsWith("dependencies") && line.endsWith("]")) {
          inDepArray = false;
        }
      }
    }

    if (
      section === "tool.poetry.dependencies" ||
      section === "tool.poetry.dev-dependencies" ||
      section.startsWith("tool.poetry.group.")
    ) {
      const poetryMatch = line.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(?:['"]([^'"]+)['"]|\{.*?version\s*=\s*['"]([^'"]+)['"].*\}|.+)/);
      if (poetryMatch && poetryMatch[1].toLowerCase() !== "python") {
        packages.push({
          name: poetryMatch[1].toLowerCase(),
          version: poetryMatch[2] || poetryMatch[3],
        });
      }
    }
  }

  return packages;
}

export function parseCargoToml(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const lines = content.split(/\r?\n/);
  let inDeps = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      const sec = sectionMatch[1].trim().toLowerCase();
      inDeps = /dependencies/.test(sec);
      continue;
    }

    if (inDeps) {
      const match = line.match(/^([a-zA-Z0-9_-]+)\s*=\s*(?:['"]([^'"]+)['"]|\{.*?(?:version\s*=\s*['"]([^'"]+)['"])?.*?\})/);
      if (match) {
        packages.push({
          name: match[1].toLowerCase(),
          version: match[2] || match[3],
        });
      }
    }
  }

  return packages;
}

export function parsePomXml(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const depBlocks = content.match(/<dependency>[\s\S]*?<\/dependency>/gi) || [];
  for (const block of depBlocks) {
    const groupMatch = block.match(/<groupId>([\s\S]*?)<\/groupId>/i);
    const artifactMatch = block.match(/<artifactId>([\s\S]*?)<\/artifactId>/i);
    const versionMatch = block.match(/<version>([\s\S]*?)<\/version>/i);

    const groupId = groupMatch ? groupMatch[1].trim() : "";
    const artifactId = artifactMatch ? artifactMatch[1].trim() : "";
    const version = versionMatch ? versionMatch[1].trim() : undefined;

    if (artifactId) {
      packages.push({
        name: groupId ? `${groupId}:${artifactId}` : artifactId,
        version,
      });
    }
  }
  return packages;
}

export function parseBuildGradle(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("//") || line.startsWith("/*")) continue;

    const match = line.match(/(?:implementation|compile|api|runtimeOnly|testImplementation)\s*[\(\s]['"]([^:'"\s]+):([^:'"\s]+)(?::([^'"\s]+))?['"]\)?/);
    if (match) {
      packages.push({
        name: `${match[1]}:${match[2]}`,
        version: match[3],
      });
    }
  }
  return packages;
}

export function parseGemfile(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;

    const match = line.match(/^gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/);
    if (match) {
      packages.push({
        name: match[1].toLowerCase(),
        version: match[2],
      });
    }
  }
  return packages;
}

export function parseComposerJson(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const all = {
    ...((parsed.require as Record<string, string>) ?? {}),
    ...((parsed["require-dev"] as Record<string, string>) ?? {}),
  };
  for (const [pkg, ver] of Object.entries(all)) {
    packages.push({ name: pkg.toLowerCase(), version: typeof ver === "string" ? ver : undefined });
  }
  return packages;
}

export function parseCsProj(content: string): ParsedPackage[] {
  const packages: ParsedPackage[] = [];
  const matches = content.matchAll(/<PackageReference\s+[^>]*Include=["']([^"']+)["'][^>]*(?:Version=["']([^"']+)["'])?[^>]*\/?>/gi);
  for (const m of matches) {
    packages.push({
      name: m[1],
      version: m[2],
    });
  }
  return packages;
}

/**
 * Normalization helper mapping parsed packages to tech entries
 */
export function mapParsedPackages(
  pkgs: ParsedPackage[],
  filePath: string,
  mappingTable: Record<string, { label: string; category: "framework" | "database" | "aws" | "runtime" }>
): { frameworks: DetectedTech[]; databases: DetectedTech[]; awsUsage: DetectedTech[] } {
  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const awsUsage: DetectedTech[] = [];
  const seen = new Set<string>();

  for (const pkg of pkgs) {
    let match = mappingTable[pkg.name];
    if (!match) {
      const parts = pkg.name.split(":");
      if (parts.length > 1 && mappingTable[parts[1]]) {
        match = mappingTable[parts[1]];
      } else {
        for (const [key, val] of Object.entries(mappingTable)) {
          if (
            pkg.name.toLowerCase().includes(key.toLowerCase()) ||
            key.toLowerCase().includes(pkg.name.toLowerCase())
          ) {
            match = val;
            break;
          }
        }
      }
    }

    if (!match || seen.has(match.label)) continue;
    seen.add(match.label);

    const entry: DetectedTech = {
      name: match.label,
      evidence: `${filePath} → ${pkg.name}${pkg.version ? `@${pkg.version}` : ""}`,
      confidence: "high",
    };

    if (match.category === "aws" || match.label.startsWith("AWS SDK")) {
      awsUsage.push(entry);
    } else if (match.category === "database") {
      databases.push(entry);
    } else {
      frameworks.push(entry);
    }
  }

  return { frameworks, databases, awsUsage };
}

/**
 * Parses package.json and extracts frameworks + databases from dependencies.
 */
function analyzePackageJson(
  content: string,
  filePath: string
): { frameworks: DetectedTech[]; databases: DetectedTech[]; awsUsage: DetectedTech[] } {
  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const awsUsage: DetectedTech[] = [];
  const seen = new Set<string>();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse package.json at ${filePath}`);
  }

  const allDeps: Record<string, string> = {
    ...((parsed.dependencies as Record<string, string>) ?? {}),
    ...((parsed.devDependencies as Record<string, string>) ?? {}),
  };

  for (const [pkg, _version] of Object.entries(allDeps)) {
    const match = NPM_FRAMEWORK_MAP[pkg];
    if (!match || seen.has(match.label)) continue;
    seen.add(match.label);

    const entry: DetectedTech = {
      name: match.label,
      evidence: `${filePath} → ${parsed.dependencies && pkg in (parsed.dependencies as object) ? "dependencies" : "devDependencies"}.${pkg}`,
      confidence: "high",
    };

    if (match.category === "database") {
      databases.push(entry);
    } else if (match.label.startsWith("AWS") || match.label.includes("DynamoDB") || match.label.includes("S3") || match.label.includes("Lambda") || match.label.includes("SQS") || match.label.includes("SNS") || match.label.includes("Cognito") || match.label.includes("CloudWatch") || match.label.includes("EC2") || match.label.includes("ECS") || match.label.includes("SES") || match.label.includes("EventBridge") || match.label.includes("Kinesis") || match.label.includes("RDS")) {
      awsUsage.push(entry);
    } else {
      frameworks.push(entry);
    }
  }

  // Also check scripts for hints (e.g. "build": "vite build", "start": "node server.js")
  const scripts = (parsed.scripts as Record<string, string>) ?? {};
  if (scripts.build?.includes("vite") && !seen.has("Vite")) {
    seen.add("Vite");
    frameworks.push({ name: "Vite", evidence: `${filePath} → scripts.build`, confidence: "high" });
  }
  if ((scripts.start?.includes("next") || scripts.dev?.includes("next")) && !seen.has("Next.js")) {
    seen.add("Next.js");
    frameworks.push({ name: "Next.js", evidence: `${filePath} → scripts.start/dev`, confidence: "medium" });
  }

  return { frameworks, databases, awsUsage };
}

/**
 * Parses requirements.txt line by line and extracts Python packages.
 */
function analyzeRequirementsTxt(
  content: string,
  filePath: string
): { frameworks: DetectedTech[]; databases: DetectedTech[]; awsUsage: DetectedTech[] } {
  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const awsUsage: DetectedTech[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim().toLowerCase();
    if (!line || line.startsWith("#")) continue;
    // Strip version specifiers: flask>=2.0 → flask
    const pkgName = line.replace(/[><=!~\s].*/g, "").replace(/\[.*\]/, "");
    const match = PYTHON_PACKAGE_MAP[pkgName];
    if (!match || seen.has(match.label)) continue;
    seen.add(match.label);

    const entry: DetectedTech = {
      name: match.label,
      evidence: `${filePath} → ${pkgName}`,
      confidence: "high",
    };

    if (match.label.startsWith("AWS SDK")) {
      awsUsage.push(entry);
    } else if (match.category === "database") {
      databases.push(entry);
    } else {
      frameworks.push(entry);
    }
  }
  return { frameworks, databases, awsUsage };
}

/**
 * Parses go.mod and extracts Go packages/frameworks.
 */
function analyzeGoMod(
  content: string,
  filePath: string
): { frameworks: DetectedTech[]; databases: DetectedTech[]; awsUsage: DetectedTech[] } {
  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const awsUsage: DetectedTech[] = [];
  const seen = new Set<string>();

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) continue;
    // require lines: github.com/gin-gonic/gin v1.9.1
    const requireMatch = line.match(/^(?:require\s+)?(\S+)\s+v\S+/);
    if (!requireMatch) continue;
    const modulePath = requireMatch[1];

    for (const [fragment, info] of Object.entries(GO_MODULE_MAP)) {
      if (modulePath.includes(fragment) && !seen.has(info.label)) {
        seen.add(info.label);
        const entry: DetectedTech = {
          name: info.label,
          evidence: `${filePath} → ${modulePath}`,
          confidence: "high",
        };
        if (info.label.startsWith("AWS SDK")) {
          awsUsage.push(entry);
        } else if (info.category === "database") {
          databases.push(entry);
        } else {
          frameworks.push(entry);
        }
      }
    }
  }
  return { frameworks, databases, awsUsage };
}

/**
 * Scans raw file content for AWS SDK import patterns.
 */
function scanContentForAwsUsage(content: string, filePath: string): DetectedTech[] {
  const found: DetectedTech[] = [];
  const seen = new Set<string>();
  for (const { pattern, service } of AWS_SDK_CONTENT_PATTERNS) {
    if (pattern.test(content) && !seen.has(service)) {
      seen.add(service);
      found.push({
        name: service,
        evidence: `${filePath} → SDK import`,
        confidence: "high",
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Entry-point detection
// ---------------------------------------------------------------------------

export const ENTRY_POINT_PATTERNS = [
  /^(src\/)?index\.(js|ts|mjs|cjs)$/,
  /^(src\/)?main\.(js|ts|py|go|rs)$/,
  /^(src\/)?app\.(js|ts|py)$/,
  /^(src\/)?server\.(js|ts)$/,
  /^(src\/)?handler\.(js|ts|py)$/,
  /^cmd\/main\.go$/,
  /^main\.py$/,
  /^manage\.py$/,
  /^wsgi\.py$/,
  /^asgi\.py$/,
];

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Analyzes a set of RepoSignals and returns a structured ProjectProfile.
 * This runs deterministically — no network calls, no LLM.
 *
 * The resulting profile is what gets passed to both the rule engine and
 * the LLM prompt, replacing the raw file dump.
 */
export function analyzeProject(signals: RepoSignals): ProjectProfile {
  const languages: DetectedTech[] = [];
  const frameworks: DetectedTech[] = [];
  const databases: DetectedTech[] = [];
  const infrastructure: DetectedTech[] = [];
  const entryPoints: string[] = [];
  const awsUsage: DetectedTech[] = [];
  const deploymentHints: DetectedTech[] = [];

  // Track deduplication
  const seenLangs = new Set<string>();
  const seenFrameworks = new Set<string>();
  const seenDatabases = new Set<string>();
  const seenInfra = new Set<string>();
  const seenAwsUsage = new Set<string>();
  const seenHints = new Set<string>();

  const addUnique = <T extends DetectedTech>(arr: T[], item: T, seen: Set<string>) => {
    if (!seen.has(item.name)) {
      seen.add(item.name);
      arr.push(item);
    }
  };

  // ── Pass 1: file-path signals (no content needed) ─────────────────────────

  for (const file of signals.keyFiles) {
    const fileName = file.path.split("/").pop() ?? file.path;

    // Language detection from manifest presence
    for (const { file: re, lang } of LANG_FROM_MANIFEST) {
      if (re.test(fileName) && !seenLangs.has(lang)) {
        seenLangs.add(lang);
        languages.push({ name: lang, evidence: file.path, confidence: "high" });
      }
    }

    // Infrastructure detection
    for (const sig of INFRA_FILE_SIGNALS) {
      if (sig.pattern.test(file.path) && !seenInfra.has(sig.label)) {
        seenInfra.add(sig.label);
        infrastructure.push({ name: sig.label, evidence: file.path, confidence: sig.confidence });
      }
    }

    // Deployment hints
    for (const sig of DEPLOYMENT_HINT_SIGNALS) {
      if (sig.pattern.test(file.path) && !seenHints.has(sig.label)) {
        seenHints.add(sig.label);
        deploymentHints.push({ name: sig.label, evidence: file.path, confidence: sig.confidence });
      }
    }

    // Entry-point detection
    for (const re of ENTRY_POINT_PATTERNS) {
      if (re.test(file.path)) {
        entryPoints.push(file.path);
        break;
      }
    }
  }

  // ── Pass 2: file-content signals (manifest parsing + SDK scan) ────────────

  const parseFailures: string[] = [];

  for (const file of signals.keyFiles) {
    if (!file.content) continue;
    const fileName = file.path.split("/").pop() ?? file.path;

    try {
      // package.json
      if (fileName === "package.json") {
        const result = analyzePackageJson(file.content, file.path);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // requirements.txt
      if (fileName === "requirements.txt") {
        const result = analyzeRequirementsTxt(file.content, file.path);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // pyproject.toml (Fix 6)
      if (fileName === "pyproject.toml") {
        const pkgs = parsePyprojectToml(file.content);
        const result = mapParsedPackages(pkgs, file.path, PYTHON_PACKAGE_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // go.mod
      if (fileName === "go.mod") {
        const result = analyzeGoMod(file.content, file.path);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // Cargo.toml (Fix 6)
      if (/^cargo\.toml$/i.test(fileName)) {
        const pkgs = parseCargoToml(file.content);
        const result = mapParsedPackages(pkgs, file.path, CARGO_PACKAGE_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // pom.xml (Fix 6)
      if (fileName === "pom.xml") {
        const pkgs = parsePomXml(file.content);
        const result = mapParsedPackages(pkgs, file.path, MAVEN_ARTIFACT_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // build.gradle / build.gradle.kts (Fix 6)
      if (/^build\.gradle(\.kts)?$/i.test(fileName)) {
        const pkgs = parseBuildGradle(file.content);
        const result = mapParsedPackages(pkgs, file.path, MAVEN_ARTIFACT_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // Gemfile (Fix 6)
      if (/^gemfile$/i.test(fileName)) {
        const pkgs = parseGemfile(file.content);
        const result = mapParsedPackages(pkgs, file.path, RUBY_GEM_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // composer.json (Fix 6)
      if (fileName === "composer.json") {
        const pkgs = parseComposerJson(file.content);
        const result = mapParsedPackages(pkgs, file.path, PHP_COMPOSER_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }

      // *.csproj (Fix 6)
      if (/\.csproj$/i.test(fileName)) {
        const pkgs = parseCsProj(file.content);
        const result = mapParsedPackages(pkgs, file.path, DOTNET_PACKAGE_MAP);
        for (const f of result.frameworks) addUnique(frameworks, f, seenFrameworks);
        for (const d of result.databases) addUnique(databases, d, seenDatabases);
        for (const a of result.awsUsage) addUnique(awsUsage, a, seenAwsUsage);
      }
    } catch (err) {
      console.warn(`[repoAnalyzer] Failed to parse manifest ${file.path}:`, err);
      parseFailures.push(file.path);
    }

    // Scan all files for AWS SDK import statements
    const sdkHits = scanContentForAwsUsage(file.content, file.path);
    for (const a of sdkHits) addUnique(awsUsage, a, seenAwsUsage);

    // Serverless.yml: scan for explicit AWS resources (provider: aws)
    if (fileName === "serverless.yml" || fileName === "serverless.yaml") {
      if (file.content.includes("provider:") && file.content.includes("aws")) {
        if (!seenInfra.has("Serverless Framework (AWS provider)")) {
          seenInfra.add("Serverless Framework (AWS provider)");
          infrastructure.push({
            name: "Serverless Framework (AWS provider)",
            evidence: `${file.path} → provider: aws`,
            confidence: "high",
          });
        }
      }
    }

    // template.yaml (SAM): look for Transform: AWS::Serverless
    if (fileName === "template.yaml") {
      if (file.content.includes("AWS::Serverless") || file.content.includes("Transform")) {
        if (!seenInfra.has("AWS SAM template")) {
          seenInfra.add("AWS SAM template");
          infrastructure.push({
            name: "AWS SAM template",
            evidence: `${file.path} → AWS::Serverless Transform`,
            confidence: "high",
          });
        }
      }
    }
  }

  // ── Build summary ──────────────────────────────────────────────────────────

  const summary = buildSummary({
    languages,
    frameworks,
    databases,
    infrastructure,
    entryPoints,
    awsUsage,
    deploymentHints,
    repoName: signals.repoName,
  });

  return {
    languages,
    frameworks,
    databases,
    infrastructure,
    entryPoints,
    awsUsage,
    deploymentHints,
    parseFailures,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(data: Omit<ProjectProfile, "summary"> & { repoName: string }): string {
  const lines: string[] = [`Repository: ${data.repoName}`, ""];
  lines.push("DETECTED TECHNOLOGIES (extracted from repository files before inference):");
  lines.push("");

  if (data.languages.length > 0) {
    lines.push(`Languages/Runtime: ${data.languages.map((l) => `${l.name} [${l.evidence}]`).join(", ")}`);
  }

  if (data.frameworks.length > 0) {
    lines.push(`Frameworks/Libraries:`);
    for (const f of data.frameworks) {
      lines.push(`  - ${f.name}  [evidence: ${f.evidence}]`);
    }
  }

  if (data.databases.length > 0) {
    lines.push(`Databases:`);
    for (const d of data.databases) {
      lines.push(`  - ${d.name}  [evidence: ${d.evidence}]`);
    }
  }

  if (data.infrastructure.length > 0) {
    lines.push(`Infrastructure/DevOps:`);
    for (const i of data.infrastructure) {
      lines.push(`  - ${i.name}  [evidence: ${i.evidence}]`);
    }
  }

  if (data.deploymentHints.length > 0) {
    lines.push(`Deployment Hints:`);
    for (const h of data.deploymentHints) {
      lines.push(`  - ${h.name}  [evidence: ${h.evidence}]`);
    }
  }

  if (data.awsUsage.length > 0) {
    lines.push(`Explicit AWS SDK Usage:`);
    for (const a of data.awsUsage) {
      lines.push(`  - ${a.name}  [evidence: ${a.evidence}]`);
    }
  } else {
    lines.push(`Explicit AWS SDK Usage: none detected`);
  }

  if (data.entryPoints.length > 0) {
    lines.push(`Entry Points: ${data.entryPoints.join(", ")}`);
  }

  lines.push("");
  lines.push(
    "This structured analysis is the evidence base for building the application's " +
    "architecture model. Use only the technologies above; do not invent technologies " +
    "absent from this analysis."
  );

  return lines.join("\n");
}
