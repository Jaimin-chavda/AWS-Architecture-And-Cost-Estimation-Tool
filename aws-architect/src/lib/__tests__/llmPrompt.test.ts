import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStructuredPrompt } from "../llmClient.ts";
import type { ProjectProfile } from "../repoAnalyzer.ts";
import type { RepoSignals } from "../repoFetcher.ts";

describe("Fix 7 — LLM prompt hygiene & no raw file leakage", () => {
  it("includes profile summary, sdkEvidence, and user description, but NEVER raw file dump", () => {
    const rawFileSecret = "const SECRET_INTERNAL_VARIABLE = 12345;";
    const profile: ProjectProfile = {
      languages: [{ name: "Python", evidence: "requirements.txt", confidence: "high" }],
      frameworks: [{ name: "FastAPI", evidence: "requirements.txt → fastapi", confidence: "high" }],
      databases: [{ name: "PostgreSQL", evidence: "requirements.txt → psycopg2", confidence: "high" }],
      infrastructure: [{ name: "Docker", evidence: "Dockerfile", confidence: "high" }],
      entryPoints: ["src/main.py"],
      awsUsage: [{ name: "AWS SDK (boto3)", evidence: "src/main.py → boto3", confidence: "high" }],
      deploymentHints: [],
      summary: "Repository: user/my-app\nDETECTED TECHNOLOGIES:\n- FastAPI\n- PostgreSQL",
    };

    const signals: RepoSignals = {
      owner: "user",
      repo: "my-app",
      repoName: "user/my-app",
      tree: [
        { path: "src/main.py", type: "blob" },
        { path: "requirements.txt", type: "blob" },
      ],
      keyFiles: [
        {
          path: "src/main.py",
          content: `${rawFileSecret}\nimport boto3\ns3 = boto3.client('s3')\ns3.upload_file(...)`,
          truncated: false,
        },
        {
          path: "requirements.txt",
          content: "fastapi==0.100.0\npsycopg2-binary==2.9.9\nboto3==1.34.0",
          truncated: false,
        },
      ],
      sdkEvidence: [
        {
          filePath: "src/main.py",
          line: 2,
          matchSnippet: "boto3.client('s3')",
          serviceHint: "S3",
        },
      ],
      truncated: false,
    };

    const prompt = buildStructuredPrompt(
      profile,
      signals,
      "Please optimize this architecture for low cost",
      "repo"
    );

    // 1. Must include structured summary
    assert.ok(prompt.includes(profile.summary), "Must include structured profile summary");

    // 2. Must include sdkEvidence
    assert.ok(prompt.includes("boto3.client('s3')"), "Must include extracted sdkEvidence match");
    assert.ok(prompt.includes("[S3] src/main.py:2"), "Must include sdkEvidence location metadata");

    // 3. Must include user description
    assert.ok(prompt.includes("Please optimize this architecture for low cost"), "Must include user description");

    // 4. Must NOT leak raw file content dump
    assert.ok(!prompt.includes(rawFileSecret), "Must NOT leak raw file contents into prompt");
    assert.ok(!prompt.includes("=== src/main.py ==="), "Must NOT contain raw file section dividers");
    assert.ok(!prompt.includes("=== requirements.txt ==="), "Must NOT dump raw requirements.txt");
  });

  it("handles description-only path cleanly without file placeholders", () => {
    const prompt = buildStructuredPrompt(
      null,
      null,
      "Real-time event streaming pipeline using Kafka and Spark",
      "description"
    );

    assert.ok(prompt.includes("Project description: Real-time event streaming pipeline using Kafka and Spark"));
    assert.ok(!prompt.includes("=== "), "Must not contain file dividers on description path");
  });
});
