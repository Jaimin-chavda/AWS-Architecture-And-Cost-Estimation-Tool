/**
 * fetchCoverage.test.ts — Fix 4
 *
 * Verifies that repoFetcher's allowlist covers every pattern recognized by
 * repoAnalyzer's recognition tables (Infra signals, deployment hints,
 * manifests, and entrypoints).
 *
 * Fails CI if any recognized pattern has no corresponding fetch rule in repoFetcher.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyFile } from "../repoFetcher.ts";
import {
  INFRA_FILE_SIGNALS,
  DEPLOYMENT_HINT_SIGNALS,
  LANG_FROM_MANIFEST,
  ENTRY_POINT_PATTERNS,
} from "../repoAnalyzer.ts";

describe("Fix 4 — fetchCoverage: repoFetcher covers repoAnalyzer patterns", () => {
  // Representative sample filenames for each pattern
  const samplePaths: Record<string, string[]> = {
    "Docker (Dockerfile)": ["Dockerfile", "docker/Dockerfile", "build/Dockerfile"],
    "Docker Compose": ["docker-compose.yml", "docker-compose.yaml", "docker-compose.dev.yml"],
    "Serverless Framework": ["serverless.yml", "serverless.yaml", "services/serverless.yml"],
    "AWS SAM (template.yaml)": ["template.yaml", "sam.yaml"],
    "Terraform": ["main.tf", "terraform/main.tf", "infra/vpc.tf"],
    "GitHub Actions CI/CD": [".github/workflows/ci.yml", ".github/workflows/deploy.yaml"],
    "Kubernetes manifests": ["k8s/deployment.yaml", "kubernetes/service.yml", "helm/values.yaml"],
    "Vercel deployment config": ["vercel.json"],
    "Netlify deployment config": ["netlify.toml"],
    "AWS Amplify config": ["amplify.yml", "amplify.yaml", "amplify/backend.ts"],
    "Elastic Beanstalk config": [".ebextensions/options.config"],
    "AWS CodeDeploy config": ["appspec.yml", "appspec.yaml"],
    "AWS CodeBuild config": ["buildspec.yml", "buildspec.yaml"],
    "AWS CloudFormation": ["cloudformation/template.yaml", ".cloudformation/stack.yml"],
    "AWS CDK config": ["cdk.json"],
    "Vercel": ["vercel.json"],
    "Netlify": ["netlify.toml"],
    "AWS Amplify": ["amplify.yml"],
    "AWS Elastic Beanstalk": [".ebextensions/app.config"],
  };

  it("covers all INFRA_FILE_SIGNALS pattern branches", () => {
    for (const signal of INFRA_FILE_SIGNALS) {
      const paths = samplePaths[signal.label];
      assert.ok(
        paths && paths.length > 0,
        `Missing sample path definition for infra signal: "${signal.label}"`
      );

      for (const samplePath of paths) {
        // Assert repoAnalyzer recognizes it
        assert.ok(
          signal.pattern.test(samplePath),
          `repoAnalyzer pattern for "${signal.label}" does not match sample path "${samplePath}"`
        );

        // Assert repoFetcher classifies / fetches it
        const classified = classifyFile(samplePath);
        assert.ok(
          classified !== null,
          `repoFetcher allowlist gap: does not fetch "${samplePath}" recognized by "${signal.label}"`
        );
      }
    }
  });

  it("covers all DEPLOYMENT_HINT_SIGNALS pattern branches", () => {
    for (const hint of DEPLOYMENT_HINT_SIGNALS) {
      const paths = samplePaths[hint.label];
      assert.ok(
        paths && paths.length > 0,
        `Missing sample path definition for hint: "${hint.label}"`
      );

      for (const samplePath of paths) {
        assert.ok(
          hint.pattern.test(samplePath),
          `repoAnalyzer hint pattern for "${hint.label}" does not match "${samplePath}"`
        );

        const classified = classifyFile(samplePath);
        assert.ok(
          classified !== null,
          `repoFetcher allowlist gap: does not fetch "${samplePath}" recognized by hint "${hint.label}"`
        );
      }
    }
  });

  it("covers all LANG_FROM_MANIFEST pattern branches including monorepo manifests", () => {
    const manifestSamples = [
      "package.json",
      "requirements.txt",
      "pyproject.toml",
      "go.mod",
      "cargo.toml",
      "Cargo.toml",
      "gemfile",
      "Gemfile",
      "composer.json",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "App.csproj",
      "packages/server/package.json",
      "apps/web/package.json",
      "modules/api/pom.xml",
    ];

    for (const manifestPath of manifestSamples) {
      const classified = classifyFile(manifestPath);
      assert.ok(
        classified !== null,
        `repoFetcher allowlist gap: does not fetch manifest path "${manifestPath}"`
      );
      assert.strictEqual(classified!.kind, "manifest");
    }
  });

  it("covers all ENTRY_POINT_PATTERNS branches", () => {
    const entrySamples = [
      "index.ts",
      "src/index.js",
      "main.py",
      "src/main.ts",
      "app.py",
      "src/app.ts",
      "server.js",
      "src/server.ts",
      "handler.py",
      "src/handler.js",
      "cmd/main.go",
      "manage.py",
      "wsgi.py",
      "asgi.py",
    ];

    for (const entryPath of entrySamples) {
      const isRecognizedByAnalyzer = ENTRY_POINT_PATTERNS.some((p) => p.test(entryPath));
      assert.ok(
        isRecognizedByAnalyzer,
        `repoAnalyzer ENTRY_POINT_PATTERNS does not match "${entryPath}"`
      );

      const classified = classifyFile(entryPath);
      assert.ok(
        classified !== null,
        `repoFetcher allowlist gap: does not fetch entrypoint path "${entryPath}"`
      );
    }
  });
});
