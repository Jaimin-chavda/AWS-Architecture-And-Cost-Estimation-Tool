/**
 * prices.ts — Stage 5: PriceService
 *
 * Fetches and caches AWS unit prices from the AWS Bulk Pricing JSON endpoint.
 * The cache is in-memory, keyed by "region:serviceCode:usageType", with a
 * 24-hour TTL.
 *
 * This module is SERVER-SIDE ONLY (uses Node.js fetch + env vars).
 *
 * Decision:
 * - We use the AWS Bulk Pricing JSON files (publicly available, no auth
 *   needed) rather than the AWS Pricing API (which requires SigV4 signing).
 * - Bulk files are large; we only load the index first, then fetch per-
 *   service region-specific files on demand.
 * - Fallback static prices are provided for every service so the UI always
 *   shows something meaningful even if the fetch fails.
 *
 * Bulk Pricing file pattern:
 *   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{serviceCode}/current/{region}/index.json
 */

// ---------------------------------------------------------------------------
// Region map — AWS Bulk Pricing region codes differ from API region names
// ---------------------------------------------------------------------------

/** Maps API region names → AWS Bulk Pricing region path segment. */
const REGION_PATH: Record<string, string> = {
  "us-east-1": "us-east-1",
  "us-east-2": "us-east-2",
  "us-west-1": "us-west-1",
  "us-west-2": "us-west-2",
  "eu-west-1": "eu-west-1",
  "eu-west-2": "eu-west-2",
  "eu-central-1": "eu-central-1",
  "ap-southeast-1": "ap-southeast-1",
  "ap-southeast-2": "ap-southeast-2",
  "ap-northeast-1": "ap-northeast-1",
  "ap-south-1": "ap-south-1",
  "sa-east-1": "sa-east-1",
  "ca-central-1": "ca-central-1",
};

// ---------------------------------------------------------------------------
// Fallback static prices (USD/unit) — used when bulk file fetch fails.
// Based on us-east-1 public pricing as of 2024-12.
// ---------------------------------------------------------------------------

export const FALLBACK_PRICES: Record<string, number> = {
  EC2: 0.023,           // t3.small on-demand $/hr
  Lambda: 0.0000166667, // $/GB-second
  ECS: 0.04048,         // Fargate $/vCPU-hr
  EKS: 0.10,            // $/cluster-hr
  Fargate: 0.04048,     // $/vCPU-hr
  Lightsail: 10.0,      // flat $10/mo (already monthly)
  Batch: 0.04048,       // estimated Spot vCPU-hr
  S3: 0.023,            // $/GB-month Standard
  EBS: 0.08,            // gp3 $/GB-month
  EFS: 0.30,            // Standard $/GB-month
  Glacier: 0.004,       // Instant Retrieval $/GB-month
  RDS: 0.017,           // db.t3.micro MySQL $/hr
  DynamoDB: 0.00000025, // On-Demand $/RCU
  ElastiCache: 0.017,   // cache.t3.micro $/hr
  Aurora: 0.12,         // Serverless v2 $/ACU-hr
  Redshift: 0.25,       // dc2.large $/hr
  DocumentDB: 0.033,    // db.t3.medium $/hr
  CloudFront: 0.0085,   // $/GB egress (US)
  APIGateway: 3.50,     // $/million REST calls
  ALB: 0.008,           // $/LCU-hr
  Route53: 0.50,        // $/hosted zone/mo (already monthly)
  VPC: 0.01,            // $/endpoint-hr
  NATGateway: 0.045,    // $/hr
  SQS: 0.40,            // $/million requests (Standard)
  SNS: 0.50,            // $/million publishes
  EventBridge: 1.00,    // $/million events
  Kinesis: 0.015,       // $/shard-hr
  Cognito: 0.0055,      // $/MAU (after 50k free tier)
  CloudWatch: 0.30,     // $/metric/month
  CodePipeline: 1.00,   // $/active pipeline/mo (already monthly)
  ECR: 0.10,            // $/GB-month
  SageMaker: 0.046,     // ml.t3.medium $/hr
  Rekognition: 0.001,   // $/image
  Comprehend: 0.0001,   // $/unit (100 chars)
  SES: 0.0001,          // $/email
  Amplify: 0.01,        // $/build-minute
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  price: number;
  expiresAt: number; // epoch ms
}

const PRICE_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function cacheKey(region: string, serviceId: string): string {
  return `${region}:${serviceId}`;
}

function cacheGet(key: string): number | null {
  const entry = PRICE_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    PRICE_CACHE.delete(key);
    return null;
  }
  return entry.price;
}

function cacheSet(key: string, price: number): void {
  PRICE_CACHE.set(key, { price, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// AWS Bulk Pricing fetch
// ---------------------------------------------------------------------------

const PRICING_BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws";

/**
 * Attempts to fetch the unit price for a given service from the AWS Bulk
 * Pricing files. Returns null on any error (network, parse, missing product).
 *
 * The bulk files are large (MB+); we cap the response to 2 MB to avoid
 * excessive memory usage and use a 5-second timeout.
 */
async function fetchBulkPrice(
  serviceCode: string,
  usageTypePrefix: string,
  region: string
): Promise<number | null> {
  const regionPath = REGION_PATH[region] ?? "us-east-1";
  const url = `${PRICING_BASE}/${serviceCode}/current/${regionPath}/index.json`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    // Read body as text, capped at 2 MB
    const reader = res.body?.getReader();
    if (!reader) return null;

    let raw = "";
    let bytesRead = 0;
    const MAX_BYTES = 2 * 1024 * 1024;

    while (bytesRead < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += new TextDecoder().decode(value);
      bytesRead += value.byteLength;
    }
    reader.cancel();

    // Parse JSON and extract first matching on-demand price
    // Bulk pricing JSON structure:
    //   { products: { sku: { attributes: { usagetype, ... } } },
    //     terms: { OnDemand: { sku: { offerTermCode: { priceDimensions: { ... } } } } } }
    const data = JSON.parse(raw) as {
      products: Record<string, { sku: string; attributes: Record<string, string> }>;
      terms: {
        OnDemand: Record<
          string,
          Record<string, { priceDimensions: Record<string, { pricePerUnit: { USD: string } }> }>
        >;
      };
    };

    // Find first product whose usagetype contains the prefix
    for (const [sku, product] of Object.entries(data.products)) {
      const usageType = product.attributes?.usagetype ?? "";
      if (usageType.includes(usageTypePrefix)) {
        // Get on-demand price
        const onDemandTerms = data.terms.OnDemand[sku];
        if (onDemandTerms) {
          for (const term of Object.values(onDemandTerms)) {
            for (const dim of Object.values(term.priceDimensions)) {
              const usd = parseFloat(dim.pricePerUnit?.USD ?? "0");
              if (usd > 0) return usd;
            }
          }
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PriceLookupResult {
  price: number;
  source: "live" | "fallback";
}

/**
 * Gets the unit price for a service in a given region.
 * Returns a live price from the AWS Bulk Pricing API if available,
 * or the fallback static price otherwise.
 *
 * Results are cached in-memory for 24 hours.
 */
export async function getUnitPrice(
  serviceId: string,
  serviceCode: string | null,
  usageTypePrefix: string | null,
  region: string
): Promise<PriceLookupResult> {
  const key = cacheKey(region, serviceId);

  // Check cache
  const cached = cacheGet(key);
  if (cached !== null) {
    return { price: cached, source: "live" };
  }

  // Try live fetch
  if (serviceCode && usageTypePrefix) {
    const livePrice = await fetchBulkPrice(serviceCode, usageTypePrefix, region);
    if (livePrice !== null && livePrice > 0) {
      cacheSet(key, livePrice);
      return { price: livePrice, source: "live" };
    }
  }

  // Fallback
  const fallback = FALLBACK_PRICES[serviceId] ?? 0;
  cacheSet(key, fallback); // cache fallback too (shorter would be ideal, but 24h is fine)
  return { price: fallback, source: "fallback" };
}

/** Clears the entire price cache (used in tests). */
export function clearPriceCache(): void {
  PRICE_CACHE.clear();
}

/** Returns the number of entries currently in the cache. */
export function getPriceCacheSize(): number {
  return PRICE_CACHE.size;
}
