const d = await import("../src/lib/diagram.ts");
const L = d.computeLayout(
  [{ componentId: "c", serviceId: "CloudFront", confidence: "high", evidence: "t", fromPattern: false }],
  { azCount: 1, users: true }
);
console.log("keys:", Object.keys(L.nodes));
console.log("edge-kids:", Object.entries(L.nodes).filter(([, v]) => v.parent === "container-edge").map(([k]) => k));
