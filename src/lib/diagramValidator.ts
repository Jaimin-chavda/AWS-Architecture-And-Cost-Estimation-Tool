/**
 * diagramValidator.ts — invariant validator over the diagram model.
 *
 * Rules hold for any plan (never a single repo):
 * - global-edge and regional services are never inside the VPC
 * - LB and NAT are inside the VPC, in a public subnet
 * - AZ containers == plan.availabilityZones, with one compute node per AZ
 * - compute never connects to the CDN directly when an LB exists
 * - no edge crosses a non-endpoint node; every node has an icon or a
 *   labelled box; all rects inside the viewBox
 * - every policy-added service has a policy evidence record
 */

import type { ServiceId, ServicePlan } from "./schema.ts";
import {
  buildDiagramElements,
  nodeStyle,
  CELL_W,
  CELL_H,
  ICON_SIZE,
  containerParent,
  edgeLabelBox,
  nodeLabelBox,
  SERVICE_SCOPE,
  scopeOf,
  type DiagramElements,
  type ServiceScope,
} from "./diagram.ts";
import { POLICY_OWNED_SERVICES } from "./infraPolicy.ts";

export { SERVICE_SCOPE, scopeOf };
export type { ServiceScope };


export interface DiagramCheck {
  pass: boolean;
  failures: string[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const COMPUTE_SERVICES: ReadonlySet<string> = new Set([
  "ECS",
  "Fargate",
  "EC2",
  "Lambda",
  "EKS",
  "Batch",
  "Lightsail",
  "AppRunner",
  "SageMaker",
]);

const LB_SERVICES: ReadonlySet<string> = new Set(["ALB", "NLB", "GLB"]);

function center(r: Rect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function insideRect(p: { x: number; y: number }, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function segmentsIntersect(
  a1: { x: number; y: number },
  a2: { x: number; y: number },
  b1: { x: number; y: number },
  b2: { x: number; y: number }
): boolean {
  const d = (p: { x: number; y: number }, q: { x: number; y: number }, r: { x: number; y: number }) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segmentHitsRect(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  r: Rect
): boolean {
  if (insideRect(p1, r) || insideRect(p2, r)) return true;
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
  for (let i = 0; i < 4; i++) {
    if (segmentsIntersect(p1, p2, corners[i], corners[(i + 1) % 4])) return true;
  }
  return false;
}

/**
 * Validates a built diagram against the placement/edge/icon/viewBox
 * invariants. Pure function, no network. Fails (pass=false) when any hold:
 * global-edge/regional node inside the VPC; vpc-public node outside the VPC
 * or not in a public subnet; AZ count below availabilityZones (when compute
 * exists); CDN→compute edge while a load balancer exists; edge segment
 * through a non-endpoint node; node without icon or label; node or edge
 * outside the viewBox; policy-added service without a policy evidence record.
 */
export function validateDiagram(plan: ServicePlan, elements: DiagramElements): DiagramCheck {
  const failures: string[] = [];
  const { layout, nodes, routedEdges } = elements;

  const vpc = layout.containers["container-vpc"] ?? null;
  // Icon geometry: the router ports edges at the 56px icon centred in each
  // cell, so crossing checks use the same icon rects the router avoided.
  const iconOffsetX = Math.round((CELL_W - ICON_SIZE) / 2);
  const nodeIdRect = new Map<string, Rect>();
  for (const n of nodes) {
    const placed = Object.values(layout.nodes).find(
      (e) => e.componentId === n.componentId && e.parent === n.parent
    );
    if (placed) {
      nodeIdRect.set(n.id, {
        x: placed.x + iconOffsetX,
        y: placed.y + 4,
        w: ICON_SIZE,
        h: ICON_SIZE,
      });
    }
  }

  const isAwsNode = (n: { componentId: string }): boolean =>
    !n.componentId.startsWith("ext-");

  // 1. Global-edge and regional services are never inside the VPC.
  if (vpc) {
    for (const n of nodes.filter(isAwsNode)) {
      let scope: string | null = null;
      try {
        scope = scopeOf(n.serviceId as ServiceId);
      } catch {
        scope = null;
      }
      if (scope === "global-edge" || scope === "regional") {
        const r = nodeIdRect.get(n.id);
        if (r && insideRect(center(r), vpc)) {
          failures.push(`${n.serviceId} node "${n.componentId}" is inside the VPC container (scope: ${scope})`);
        }
      }
    }
  }

  // 2. VPC-public services (LB, NAT) belong inside the VPC in a public subnet.
  for (const n of nodes.filter(isAwsNode)) {
    let scope: string | null = null;
    try {
      scope = scopeOf(n.serviceId as ServiceId);
    } catch {
      scope = null;
    }
    if (scope === "vpc-public") {
      const r = nodeIdRect.get(n.id);
      if (vpc && r && !insideRect(center(r), vpc)) {
        failures.push(`${n.serviceId} node "${n.componentId}" is outside the VPC container`);
      }
      if (!n.parent.startsWith("container-public-")) {
        failures.push(`${n.serviceId} node "${n.componentId}" is in "${n.parent}", not a public subnet`);
      }
    }
  }

  // 3. AZ / compute fan-out must honour availabilityZones.
  const expectedAz = Math.max(1, ...plan.deploymentModel.map((d) => d.availabilityZones ?? 1));
  const renderedAzs = Object.keys(layout.containers).filter(
    (id) => layout.containers[id] !== null && /^container-az-\d+$/.test(id)
  ).length;
  const planCompute = plan.awsMappings.filter((m) =>
    COMPUTE_SERVICES.has(m.serviceId)
  ).length;
  if (planCompute > 0) {
    if (renderedAzs !== expectedAz) {
      failures.push(`availabilityZones is ${expectedAz} but ${renderedAzs} AZ container(s) render`);
    }
    for (let i = 1; i <= expectedAz; i++) {
      const inAz = nodes.filter(
        (n) => n.parent === `container-private-${i}` && COMPUTE_SERVICES.has(n.serviceId)
      ).length;
      if (inAz < 1) {
        failures.push(`AZ ${i} renders no compute node`);
      }
    }
  } else if (renderedAzs > expectedAz) {
    failures.push(`availabilityZones is ${expectedAz} but ${renderedAzs} AZ container(s) render`);
  }

  // 4. The CDN never connects to compute directly when an LB exists.
  const hasLb =
    plan.deploymentModel.some((d) => d.hasLoadBalancer) ||
    nodes.some((n) => LB_SERVICES.has(n.serviceId));
  if (hasLb) {
    const svcByNode = new Map(nodes.map((n) => [n.id, n.serviceId] as const));
    for (const e of routedEdges) {
      if (
        svcByNode.get(e.sourceId) === "CloudFront" &&
        COMPUTE_SERVICES.has(svcByNode.get(e.targetId) ?? "")
      ) {
        failures.push(`CloudFront -> compute edge "${e.id}" exists while a load balancer is present`);
      }
      if (
        COMPUTE_SERVICES.has(svcByNode.get(e.sourceId) ?? "") &&
        svcByNode.get(e.targetId) === "CloudFront"
      ) {
        failures.push(`compute -> CloudFront edge "${e.id}" exists while a load balancer is present`);
      }
    }
  }

  // 5. No edge segment may cross a non-endpoint node box.
  for (const e of routedEdges) {
    const src = nodeIdRect.get(e.sourceId);
    const dst = nodeIdRect.get(e.targetId);
    if (!src || !dst) continue;
    const pts = [center(src), ...e.waypoints, center(dst)];
    for (let i = 0; i < pts.length - 1; i++) {
      for (const n of nodes) {
        if (n.id === e.sourceId || n.id === e.targetId) continue;
        const r = nodeIdRect.get(n.id);
        if (r && segmentHitsRect(pts[i], pts[i + 1], r)) {
          failures.push(`edge "${e.id}" segment ${i} intersects node "${n.componentId}" (${n.serviceId})`);
          break;
        }
      }
    }
  }

  // 5b. No segment may cross an isolation container unless an endpoint
  // node is inside it or shares its AZ. Cloud/edge/regional bands and the
  // VPC/AZ shells are transit by design and exempt; subnets, the spanning
  // data subnet and the external column are not. Subnets stacked in one AZ
  // are legitimate transit for that AZ's own endpoints.
  const azOfContainer = (cid: string): number | null => {
    const m = cid.match(/^container-(?:public|private|az)-(\d+)$/);
    return m ? Number(m[1]) : null;
  };
  const azOfNode = (nodeId: string): number | null => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    let id: string | undefined = node.parent;
    while (id && id !== "1" && id !== "container-aws_cloud") {
      const m = id.match(/^container-(?:public|private|az)-(\d+)$/);
      if (m) return Number(m[1]);
      id = containerParent(id);
    }
    return null;
  };
  const isTransitShell = (cid: string): boolean =>
    cid === "container-aws_cloud" ||
    cid === "container-edge" ||
    cid === "container-regional" ||
    cid === "container-vpc" ||
    /^container-az-\d+$/.test(cid);
  const nodeInside = (nodeId: string, containerId: string): boolean => {
    const r = nodeIdRect.get(nodeId);
    const c = layout.containers[containerId];
    return Boolean(r && c && insideRect(center(r), c));
  };
  for (const e of routedEdges) {
    const src = nodeIdRect.get(e.sourceId);
    const dst = nodeIdRect.get(e.targetId);
    if (!src || !dst) continue;
    const srcAz = azOfNode(e.sourceId);
    const dstAz = azOfNode(e.targetId);
    const pts = [center(src), ...e.waypoints, center(dst)];
    for (let i = 0; i < pts.length - 1; i++) {
      for (const [cid, c] of Object.entries(layout.containers)) {
        if (!c || isTransitShell(cid)) continue;
        if (nodeInside(e.sourceId, cid) || nodeInside(e.targetId, cid)) continue;
        const az = azOfContainer(cid);
        if (az !== null && (srcAz === az || dstAz === az)) continue;
        if (segmentHitsRect(pts[i], pts[i + 1], c)) {
          failures.push(
            `edge "${e.id}" segment ${i} crosses container "${cid}" with no endpoint inside`
          );
          break;
        }
      }
    }
  }

  // 5c. Edge labels sit on a horizontal segment, offset from the line, and
  // never overlap a node label box. Box geometry is shared with the layout
  // (edgeLabelBox/nodeLabelBox), so seating and checking agree exactly.
  const labelBoxOf = (nodeId: string): Rect | null => {
    const node = nodes.find((n) => n.id === nodeId);
    const r = nodeIdRect.get(nodeId);
    if (!node || !r) return null;
    return nodeLabelBox({ x: r.x, y: r.y }, node.label);
  };
  const boxesOverlap = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  for (const e of routedEdges) {
    if (!e.label || e.label.trim().length === 0) continue;
    const src = nodeIdRect.get(e.sourceId);
    const dst = nodeIdRect.get(e.targetId);
    if (!src || !dst) continue;
    const pts = [center(src), ...e.waypoints, center(dst)];
    // Label anchor: polyline midpoint plus the recorded offset.
    let total = 0;
    const segLens: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      segLens.push(len);
      total += len;
    }
    let acc = 0;
    let anchor = pts[pts.length - 1];
    for (let i = 0; i < pts.length - 1; i++) {
      if (acc + segLens[i] >= total / 2) {
        const t = segLens[i] === 0 ? 0 : (total / 2 - acc) / segLens[i];
        anchor = {
          x: pts[i].x + (pts[i + 1].x - pts[i].x) * t + e.labelOffsetX,
          y: pts[i].y + (pts[i + 1].y - pts[i].y) * t + e.labelOffsetY,
        };
        break;
      }
      acc += segLens[i];
    }
    // The anchor must sit near a horizontal segment (stagger offsets
    // deliberately push labels along/across it, so admit the offset).
    const nearHorizontal = pts.some(
      (_, i) =>
        i < pts.length - 1 &&
        Math.abs(pts[i + 1].y - pts[i].y) <= 4 &&
        Math.min(pts[i].y, pts[i + 1].y) - 20 <= anchor.y &&
        anchor.y <= Math.max(pts[i].y, pts[i + 1].y) + 20 &&
        Math.min(pts[i].x, pts[i + 1].x) - 8 - Math.abs(e.labelOffsetX) <= anchor.x &&
        anchor.x <= Math.max(pts[i].x, pts[i + 1].x) + 8 + Math.abs(e.labelOffsetX)
    );
    if (!nearHorizontal) {
      failures.push(`edge "${e.id}" label is not on a horizontal segment`);
    }
    const labelBox: Rect = edgeLabelBox(anchor, e.label);
    for (const n of nodes) {
      if (n.id === e.sourceId || n.id === e.targetId) continue;
      const lb = labelBoxOf(n.id);
      if (lb && boxesOverlap(labelBox, lb)) {
        failures.push(
          `edge "${e.id}" label overlaps node "${n.componentId}" (${n.serviceId}) label`
        );
        break;
      }
    }
  }

  // 6. Every node needs an icon or, failing that, a labelled box — never
  // a blank box.
  for (const n of nodes) {
    if (n.componentId.startsWith("ext-")) {
      if (!n.label || n.label.trim().length === 0) {
        failures.push(`external node "${n.componentId}" has no label`);
      }
      continue;
    }
    const style = nodeStyle(n.serviceId as ServiceId);
    if ((!style || style.trim().length === 0) && (!n.label || n.label.trim().length === 0)) {
      failures.push(`node "${n.componentId}" (${n.serviceId}) has neither icon nor label`);
    }
  }

  // 7. Everything must lie inside the viewBox.
  const inView = (p: { x: number; y: number }) =>
    p.x >= 0 && p.x <= layout.canvasW && p.y >= 0 && p.y <= layout.canvasH;
  for (const [key, r] of Object.entries(layout.containers)) {
    if (!r) continue;
    if (!inView({ x: r.x, y: r.y }) || !inView({ x: r.x + r.w, y: r.y + r.h })) {
      failures.push(`container "${key}" lies outside the viewBox`);
    }
  }
  for (const n of nodes) {
    const r = nodeIdRect.get(n.id);
    if (r && (!inView({ x: r.x, y: r.y }) || !inView({ x: r.x + r.w, y: r.y + r.h }))) {
      failures.push(`node "${n.componentId}" lies outside the viewBox`);
    }
  }
  for (const e of routedEdges) {
    for (const w of e.waypoints) {
      if (!inView(w)) {
        failures.push(`edge "${e.id}" waypoint lies outside the viewBox`);
        break;
      }
    }
  }

  // 8. Every policy-owned recommendation carries a policy evidence record.
  // (Detection suggestions for other services keep detection evidence.)
  for (const m of plan.awsMappings) {
    if (
      m.category === "recommendation" &&
      POLICY_OWNED_SERVICES.has(m.serviceId) &&
      !m.evidence.startsWith("policy:")
    ) {
      failures.push(
        `policy-added mapping "${m.componentId}" (${m.serviceId}) lacks a "policy:" evidence record`
      );
    }
  }

  return { pass: failures.length === 0, failures };
}

/** Convenience: build elements from a plan, then validate. */
export function validatePlanDiagram(plan: ServicePlan): DiagramCheck {
  return validateDiagram(plan, buildDiagramElements(plan));
}
