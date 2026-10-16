/**
 * How many requests a month stay inside Lambda's always-free tier, and what happens
 * past it. Pure functions, so the tests can pin every number the docs quote.
 *
 * Allowances and prices: us-east-1, checked 2026-10-15. Sources are in docs/cost.md.
 */

export const FREE_TIER = {
  /** Lambda, per month, shared by every function in the account, x86 and Arm together. */
  lambdaRequests: 1_000_000,
  lambdaGbSeconds: 400_000,
  /** CloudWatch Logs data per month (ingestion, archive storage and Logs Insights scans together). */
  logsGb: 5,
  /** CloudWatch alarm metrics per month. */
  alarmMetrics: 10,
  /** DynamoDB provisioned read and write capacity units, per Region, shared by all tables. */
  dynamoDbCapacityUnits: 25,
  /** Data transfer out to the internet per month, shared by most services. */
  dataTransferOutGb: 100,
} as const;

/** AWS Price List API, AWSLambda us-east-1. Prices for usage past the free tier. */
export const PRICES = {
  perRequest: 0.0000002,
  perGbSecond: { arm64: 0.0000133334, x86_64: 0.0000166667 },
} as const;

export type Arch = keyof typeof PRICES.perGbSecond;

/** 31 days. The worst case for a month. */
export const SECONDS_IN_LONGEST_MONTH = 31 * 24 * 60 * 60;

/** Lambda bills duration rounded up to the next millisecond. */
export function billedMs(durationMs: number): number {
  if (!(durationMs >= 0)) throw new Error('duration must be zero or more');
  return Math.max(1, Math.ceil(durationMs));
}

/**
 * Checks a mean of billed durations (each already rounded up). Every request bills at
 * least 1 ms, so the mean can't be lower than that. Don't round it again.
 */
export function meanOfBilled(meanBilledMs: number): number {
  if (!(meanBilledMs >= 1)) throw new Error('a mean of billed durations is at least 1 ms');
  return meanBilledMs;
}

export function gbSecondsPerRequest(billed: number, memoryMb: number): number {
  return (billed / 1000) * (memoryMb / 1024);
}

export interface FreeRequests {
  /** Requests whose compute fits in 400,000 GB-seconds. */
  byCompute: number;
  /** The free request count. */
  byCount: number;
  /** The smaller of the two. */
  free: number;
  binding: 'requests' | 'compute';
}

/** `meanBilledMs` must be the mean of each request's rounded-up duration. */
export function freeRequests(meanBilledMs: number, memoryMb: number): FreeRequests {
  const byCompute = Math.floor(FREE_TIER.lambdaGbSeconds / gbSecondsPerRequest(meanBilledMs, memoryMb));
  const byCount = FREE_TIER.lambdaRequests;
  return byCompute < byCount ? { byCompute, byCount, free: byCompute, binding: 'compute' } : { byCompute, byCount, free: byCount, binding: 'requests' };
}

/** The mean duration at which compute and request count run out together. */
export function breakEvenMs(memoryMb: number): number {
  return (FREE_TIER.lambdaGbSeconds / FREE_TIER.lambdaRequests / (memoryMb / 1024)) * 1000;
}

export interface MonthlyBill {
  requests: number;
  gbSeconds: number;
  requestCost: number;
  computeCost: number;
  total: number;
}

/** The Lambda bill for a month, if this function is the only one using the free tier. */
export function lambdaBill(requests: number, meanBilledMs: number, memoryMb: number, arch: Arch): MonthlyBill {
  const gbSeconds = requests * gbSecondsPerRequest(meanBilledMs, memoryMb);
  const requestCost = Math.max(0, requests - FREE_TIER.lambdaRequests) * PRICES.perRequest;
  const computeCost = Math.max(0, gbSeconds - FREE_TIER.lambdaGbSeconds) * PRICES.perGbSecond[arch];
  return { requests, gbSeconds, requestCost, computeCost, total: requestCost + computeCost };
}

/** A function URL accepts at most 10 requests per second per unit of reserved concurrency. */
export const URL_RPS_PER_RESERVED_UNIT = 10;

/**
 * The most this function can bill in a month if callers keep every reserved slot busy
 * for 31 days and each request bills `meanBilledMs`. Two limits apply at once: reserved
 * concurrency caps how many requests run together, and the function URL caps requests
 * per second at 10 x reserved concurrency. Throttled requests (429) aren't billed.
 */
export function ceiling(reservedConcurrency: number, meanBilledMs: number, memoryMb: number, arch: Arch): MonthlyBill {
  const perSecond = Math.min((reservedConcurrency * 1000) / meanBilledMs, URL_RPS_PER_RESERVED_UNIT * reservedConcurrency);
  const requests = Math.floor(perSecond * SECONDS_IN_LONGEST_MONTH);
  return lambdaBill(requests, meanBilledMs, memoryMb, arch);
}

/**
 * The ceiling over every possible duration. Below 100 ms the request rate cap binds and
 * compute grows with duration; above 100 ms concurrency binds and compute stays flat
 * while requests fall. So the worst month is the one where every request takes 100 ms.
 */
export function absoluteCeiling(reservedConcurrency: number, memoryMb: number, arch: Arch): MonthlyBill {
  return ceiling(reservedConcurrency, 1000 / URL_RPS_PER_RESERVED_UNIT, memoryMb, arch);
}

/** Gigabytes (10^9 bytes, the larger count) for a month of traffic. */
export function monthlyGb(requests: number, bytesPerRequest: number): number {
  return (requests * bytesPerRequest) / 1e9;
}

/** Average write or read units per second if the requests were spread evenly over 31 days. */
export function averageUnitsPerSecond(requests: number, share: number, unitsPerCall: number): number {
  return (requests * share * unitsPerCall) / SECONDS_IN_LONGEST_MONTH;
}
