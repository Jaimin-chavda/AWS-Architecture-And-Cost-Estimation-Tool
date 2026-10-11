const d = await import("../src/lib/diagram.ts");
const p = await import("../src/lib/infraPolicy.ts");
const v = await import("../src/lib/diagramValidator.ts");
function synth(model, db, frontend, integ, secrets) {
  const services = [];
  if (model === "container") services.push("ECS");
  if (model === "vm") services.push("EC2");
  if (model === "serverless") services.push("Lambda");
  if (db === "relational") services.push("RDS");
  if (db === "document") services.push("DocumentDB");
  if (db === "kv") services.push("ElastiCache");
  if (frontend === "static") services.push("S3", "CloudFront");
  if (frontend === "client-only") services.push("CloudFront");
  const third = [
    { name: "Synthetic Pay", purpose: "t", protocol: "HTTPS", category: "payment" },
    { name: "Synthetic Mail", purpose: "t", protocol: "SMTP", category: "email" },
    { name: "Synthetic Stats", purpose: "t", protocol: "HTTPS", category: "analytics" },
  ].slice(0, integ);
  const plan = {
    inputKind: "description",
    components: services.map((s) => ({ id: `svc-${s.toLowerCase()}`, type: "backend", technology: s, evidence: ["s"], confidence: "high", status: "detected" })),
    relationships: [],
    deploymentModel: services.map((s) => ({ componentId: `svc-${s.toLowerCase()}`, public: false, needsVpc: true, needsMultiAz: false, needsAutoscaling: false, source: "recommended", availabilityZones: 1, hasLoadBalancer: false, secretsManager: false, natGateway: false, thirdPartyIntegrations: third })),
    awsMappings: services.map((s) => ({ componentId: `svc-${s.toLowerCase()}`, serviceId: s, confidence: "high", evidence: "s", fromPattern: false, category: "repository-evidence" })),
    detectedPattern: "generic", terminalState: "OK",
    metadata: { grounding: "description", truncated: false, parseErrors: [] }, warnings: [],
  };
  const traits = { servesRequests: model !== "none" && frontend !== "static", batchOnly: false, staticOnly: frontend === "static", computeModel: model, hasRelationalDb: db === "relational", hasDocumentDb: db === "document", hasKvStore: db === "kv", hasSecrets: secrets, egressTargets: third.map((t) => t.name), evidence: {} };
  return p.applyInfraPolicy(plan, traits);
}
const g = synth("container", "none", "client-only", 0, true);
console.log("MAPS:", g.awsMappings.map((m) => m.serviceId).join(","));
const el = d.buildDiagramElements(g);
for (const [id, r] of Object.entries(el.layout.containers)) if (r) console.log("C", id, r.x, r.y, r.w, r.h);
for (const n of el.nodes) {
  const e = Object.entries(el.layout.nodes).find(([, q]) => q.componentId === n.componentId && q.parent === n.parent);
  console.log("N", n.id, n.serviceId, n.parent, e ? `${e[1].x + 30},${e[1].y + 4}` : "?");
}
for (const e of el.routedEdges) console.log("E", e.id, e.sourceId, e.targetId, "[" + e.label + "]", JSON.stringify(e.waypoints));
const c = v.validateDiagram(g, el);
console.log("valid", c.pass);
c.failures.forEach((f) => console.log(" -", f));
