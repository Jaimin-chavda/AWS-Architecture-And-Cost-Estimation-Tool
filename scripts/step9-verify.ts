/**
 * step9-verify.ts — STEP 9: verify on unseen input.
 *
 * Runs the full rules pipeline on every repo in tesing-repo.md plus 3 new
 * repos of our choice, printing per repo:
 *   - detected services + terminal state
 *   - invariant validator report (validatePlanDiagram)
 *   - dependencies that fell into the Step 2 unknown-service fallback
 *
 * Report-only: failures must be fixed via registry rows or generic rules,
 * never repo special cases.
 *
 * Run: npx tsx scripts/step9-verify.ts
 */
import "./../src/lib/__tests__/loadEnv.ts";
import { fetchRepoSignals, signalsToRuleInput } from "../src/lib/repoFetcher.ts";
import { analyzeProject } from "../src/lib/repoAnalyzer.ts";
import { runRuleEngine } from "../src/lib/ruleEngine.ts";
import { validatePlanDiagram } from "../src/lib/diagramValidator.ts";
import { detectExternalFallback } from "../src/lib/integrationRegistry.ts";
import { deriveGrounding } from "../src/lib/inference.ts";

const FIXTURE_REPOS = [
  "https://github.com/dockersamples/example-voting-app",
  "https://github.com/GoogleCloudPlatform/microservices-demo",
  "https://github.com/spring-projects/spring-petclinic",
  "https://github.com/gothinkster/node-express-realworld-example-app",
  "https://github.com/gothinkster/django-realworld-example-app",
  "https://github.com/gothinkster/golang-gin-realworld-example-app",
  "https://github.com/hashicorp/learn-terraform-provision-eks-cluster",
  "https://github.com/aws-samples/aws-serverless-workshops",
  "https://github.com/supabase/supabase",
  "https://github.com/oakserver/oak",
  "https://github.com/go-kit/examples",
  "https://github.com/Jaimin-chavda/Decentralized-Voting-System",
];

// 3 new repos of our choice: a JS runtime monorepo, a PHP skeleton, a pure
// JS library — none used anywhere in fixtures or unit tests.
const NEW_REPOS = [
  "https://github.com/oven-sh/bun",
  "https://github.com/laravel/laravel",
  "https://github.com/axios/axios",
];

async function verify(url: string): Promise<boolean> {
  const name = url.replace("https://github.com/", "");
  console.log(`=== ${name} ===`);
  try {
    const signals = await fetchRepoSignals(url, process.env.GITHUB_TOKEN);
    const grounding = deriveGrounding({ description: "", fetchedFiles: signals.keyFiles });
    const profile = analyzeProject(signals);
    const ruleInput = signalsToRuleInput(signals, "github_url", grounding);
    const plan = runRuleEngine({ ...ruleInput, profile });
    const services = plan.awsMappings.map((m) => m.serviceId).sort().join(", ") || "(none)";
    console.log(`  services : [${services}] terminal=${plan.terminalState ?? "OK"}`);

    const check = validatePlanDiagram(plan);
    console.log(`  validator: ${check.pass ? "PASS" : "FAIL"}`);
    for (const f of check.failures.slice(0, 8)) console.log(`    - ${f}`);

    const fallbacks = detectExternalFallback(signals.keyFiles);
    console.log(
      `  fallback : ${fallbacks.length === 0 ? "(none)" : fallbacks.map((fb) => `${fb.name} @ ${fb.evidence.slice(0, 90)}`).join(" | ")}`
    );
    console.log();
    return check.pass;
  } catch (err) {
    console.log(`  ERROR: ${(err as Error).message}\n`);
    return false;
  }
}

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;
  for (const url of [...FIXTURE_REPOS, ...NEW_REPOS]) {
    if (await verify(url)) pass++;
    else fail++;
  }
  console.log("=".repeat(72));
  console.log(`validator clean on ${pass}/${FIXTURE_REPOS.length + NEW_REPOS.length} repos (${fail} failing)`);
  console.log("=".repeat(72));
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("step9 fatal:", err);
  process.exit(2);
});
