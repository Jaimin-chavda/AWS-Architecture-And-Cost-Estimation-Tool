/**
 * ruleEngine.test.ts
 *
 * Tests for the deterministic rule engine (BuildOrder Stage 1).
 * Uses Node.js built-in test runner (node:test + node:assert) — no extra deps.
 *
 * Run: node --experimental-strip-types --test src/lib/__tests__/ruleEngine.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runRuleEngine } from "../ruleEngine.ts";
import type { RuleInput } from "../ruleEngine.ts";
import { SERVICE_IDS, ServicePlanSchema } from "../schema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<RuleInput> = {}): RuleInput {
  return {
    description: "",
    fileContent: "",
    fileNames: [],
    inputKind: "description",
    grounding: "description",
    truncated: false,
    parseErrors: [],
    ...overrides,
  };
}

function serviceIds(plan: ReturnType<typeof runRuleEngine>): string[] {
  return Object.values(plan.slots).map((s) => s.serviceId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runRuleEngine — always produces a valid ServicePlan", () => {
  it("empty input returns a valid plan (generic pattern fallback)", () => {
    const plan = runRuleEngine(makeInput());
    const result = ServicePlanSchema.safeParse(plan);
    assert.ok(result.success, `Schema failed: ${!result.success && JSON.stringify(result.error.issues)}`);
  });

  it("passes schema validation in all cases (catalog allowlist)", () => {
    const inputs: Partial<RuleInput>[] = [
      { description: "a real-time chat app with react frontend" },
      { fileNames: ["Dockerfile", "docker-compose.yml"], fileContent: "FROM node:22" },
      { fileNames: ["serverless.yml"], fileContent: "aws-lambda handler dynamodb" },
      { description: "machine learning model training pipeline with sagemaker" },
      { description: "data pipeline with kinesis redshift s3 etl" },
    ];
    for (const inp of inputs) {
      const plan = runRuleEngine(makeInput(inp));
      const result = ServicePlanSchema.safeParse(plan);
      assert.ok(result.success, `Schema failed for input ${JSON.stringify(inp)}: ${!result.success && JSON.stringify(result.error.issues)}`);
    }
  });

  it("every serviceId in slots is in the catalog allowlist", () => {
    const plan = runRuleEngine(makeInput({
      description: "react app with express api postgres s3 cloudfront cloudwatch cognito sqs sns",
      fileContent: "DATABASE_URL=postgresql://localhost:5432/db",
    }));
    const ids = serviceIds(plan);
    const allowlist = new Set<string>(SERVICE_IDS);
    for (const id of ids) {
      assert.ok(allowlist.has(id), `${id} is not in catalog allowlist`);
    }
  });

  it("never exceeds 12 distinct services", () => {
    // Give it a ton of signals to stress the cap
    const plan = runRuleEngine(makeInput({
      description: "lambda apigateway dynamodb s3 cloudfront route53 sqs sns eventbridge cognito elasticache rds ec2 ecs fargate eks ecr alb kinesis sagemaker",
      fileContent: "sagemaker rekognition comprehend bedrock DATABASE_URL=postgresql://localhost REDIS_URL=redis://localhost",
      fileNames: ["Dockerfile", "serverless.yml", "docker-compose.yml", "terraform/main.tf"],
    }));
    const unique = new Set(serviceIds(plan));
    assert.ok(unique.size <= 12, `Expected ≤12 services, got ${unique.size}`);
  });
});

describe("runRuleEngine — pattern classification", () => {
  it("classifies static site correctly", () => {
    const plan = runRuleEngine(makeInput({
      description: "a gatsby static site deployed to s3 with cloudfront cdn",
      fileNames: ["vercel.json"],
    }));
    assert.strictEqual(plan.pattern, "static-site");
  });

  it("classifies serverless API correctly — serverless.yml signal", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["serverless.yml"],
      fileContent: "aws-lambda handler dynamodb apigateway",
    }));
    assert.strictEqual(plan.pattern, "serverless-api");
  });

  it("classifies serverless API — SAM template.yaml signal", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["template.yaml"],
      fileContent: "AWS::Lambda::Function AWS::ApiGateway::RestApi",
    }));
    assert.strictEqual(plan.pattern, "serverless-api");
  });

  it("classifies containerised app — Dockerfile present", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["Dockerfile", "docker-compose.yml"],
      fileContent: "FROM node:22\nfargate ecs",
    }));
    assert.strictEqual(plan.pattern, "containerised-app");
  });

  it("classifies ML pipeline", () => {
    const plan = runRuleEngine(makeInput({
      description: "sagemaker training job pytorch model with s3 dataset and inference endpoint",
    }));
    assert.strictEqual(plan.pattern, "ml-pipeline");
  });

  it("classifies event-driven when SQS/Kinesis signals dominate", () => {
    const plan = runRuleEngine(makeInput({
      description: "kafka consumer producer sqs eventbridge async message queue worker",
    }));
    assert.strictEqual(plan.pattern, "event-driven");
  });

  it("classifies data pipeline", () => {
    const plan = runRuleEngine(makeInput({
      description: "ETL data pipeline kinesis s3 glue redshift athena data warehouse",
    }));
    assert.strictEqual(plan.pattern, "data-pipeline");
  });

  it("falls back to generic when signals are too weak", () => {
    const plan = runRuleEngine(makeInput({ description: "my cool project" }));
    const result = ServicePlanSchema.safeParse(plan);
    assert.ok(result.success);
  });
});

describe("Fix 5 — Two-tier signals & CloudWatch gating", () => {
  it("(a) Docker-only repo → RDS/ElastiCache do NOT appear in services, only suggestedServices", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["Dockerfile"],
      fileContent: "FROM node:22\nCOPY . .\nCMD ['node', 'index.js']\n// mentioning postgres and redis in comments only",
    }));
    const ids = serviceIds(plan);
    assert.ok(!ids.includes("RDS"), "RDS must not appear in services[] for Docker-only repo without DB connection/infra");
    assert.ok(!ids.includes("ElastiCache"), "ElastiCache must not appear in services[] for Docker-only repo");

    const suggestedIds = (plan.suggestedServices ?? []).map((s) => s.serviceId);
    assert.ok(suggestedIds.includes("RDS"), "RDS should appear in suggestedServices");
    assert.ok(suggestedIds.includes("ElastiCache"), "ElastiCache should appear in suggestedServices");
  });

  it("(b) Docker + Postgres connection string → RDS promoted to services[]", () => {
    const plan = runRuleEngine(makeInput({
      fileNames: ["Dockerfile", ".env.example"],
      fileContent: "FROM node:22\nDATABASE_URL=postgresql://user:pass@localhost:5432/mydb",
    }));
    const ids = serviceIds(plan);
    assert.ok(ids.includes("RDS"), "RDS should be promoted to services[] when corroborated by connection string");
  });

  it("(c) empty plan → no CloudWatch", () => {
    const plan = runRuleEngine(makeInput({ description: "" }));
    const ids = serviceIds(plan);
    assert.ok(!ids.includes("CloudWatch"), "CloudWatch must not be added when no compute service is present");
  });

  it("(d) Lambda present → CloudWatch present", () => {
    const plan = runRuleEngine(makeInput({
      description: "aws-lambda handler",
    }));
    const ids = serviceIds(plan);
    assert.ok(ids.includes("Lambda"), "Lambda should be present");
    assert.ok(ids.includes("CloudWatch"), "CloudWatch must be present when Lambda (compute) is present");
  });
});

describe("runRuleEngine — service detection", () => {
  it("detects Lambda from aws-lambda text", () => {
    const plan = runRuleEngine(makeInput({
      description: "aws-lambda function handler.js",
    }));
    assert.ok(serviceIds(plan).includes("Lambda"), "Expected Lambda to be detected");
  });

  it("detects DynamoDB from dynamo keyword", () => {
    const plan = runRuleEngine(makeInput({
      description: "dynamodb table for storing user sessions",
    }));
    assert.ok(serviceIds(plan).includes("DynamoDB"), "Expected DynamoDB");
  });

  it("detects S3 from s3:// prefix", () => {
    const plan = runRuleEngine(makeInput({
      fileContent: "aws s3 cp myfile.zip s3://my-bucket/",
    }));
    assert.ok(serviceIds(plan).includes("S3"), "Expected S3");
  });

  it("detects EKS from kubernetes keyword", () => {
    const plan = runRuleEngine(makeInput({
      description: "kubernetes cluster k8s kubectl deployment",
    }));
    assert.ok(serviceIds(plan).includes("EKS"), "Expected EKS from k8s signal");
  });

  it("detects Aurora (not RDS) when aurora keyword present", () => {
    const plan = runRuleEngine(makeInput({
      fileContent: "aurora mysql cluster endpoint",
    }));
    assert.ok(serviceIds(plan).includes("Aurora"), "Expected Aurora");
    assert.ok(!serviceIds(plan).includes("RDS"), "Should not have both Aurora and RDS");
  });
});

describe("runRuleEngine — metadata passthrough", () => {
  it("passes grounding from input to plan.metadata", () => {
    const plan = runRuleEngine(makeInput({ grounding: "repo", inputKind: "github_url" }));
    assert.strictEqual(plan.metadata.grounding, "repo");
  });

  it("passes truncated flag", () => {
    const plan = runRuleEngine(makeInput({ truncated: true }));
    assert.strictEqual(plan.metadata.truncated, true);
  });

  it("passes parseErrors", () => {
    const plan = runRuleEngine(makeInput({ parseErrors: ["bad.yaml"] }));
    assert.deepStrictEqual(plan.metadata.parseErrors, ["bad.yaml"]);
  });

  it("preserves inputKind on the plan", () => {
    const planGh = runRuleEngine(makeInput({ inputKind: "github_url", grounding: "repo" }));
    assert.strictEqual(planGh.inputKind, "github_url");
    const planDesc = runRuleEngine(makeInput({ inputKind: "description" }));
    assert.strictEqual(planDesc.inputKind, "description");
  });
});
