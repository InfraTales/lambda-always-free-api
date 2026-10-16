/**
 * How many requests a month this API can serve for $0, from measured numbers.
 *
 *   npm run free-tier-model                          # uses measurements.json
 *   npm run free-tier-model -- --duration-ms 38 --memory-mb 256
 *
 * After a deploy, take the mean "Billed Duration" and "Max Memory Used" from the REPORT
 * log lines (docs/runbook.md has the Logs Insights query) and pass them in.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import {
  FREE_TIER,
  PRICES,
  type Arch,
  averageUnitsPerSecond,
  meanOfBilled,
  breakEvenMs,
  absoluteCeiling,
  ceiling,
  freeRequests,
  gbSecondsPerRequest,
  lambdaBill,
  monthlyGb,
} from '../model/free-tier';

interface Measurements {
  measuredAt: string;
  machine: string;
  bundleLoadMs: number;
  warm: { meanBilled: number; p95: number; count: number };
  routes: Record<string, { count: number }>;
  peakRssMb: number;
  logBytesPerRequest: number;
  responseBytes: Record<string, number>;
  writeUnitsPerWrite: number;
}

const { values: args } = parseArgs({
  options: {
    'duration-ms': { type: 'string' },
    'memory-mb': { type: 'string', default: '256' },
    arch: { type: 'string', default: 'arm64' },
    'reserved-concurrency': { type: 'string', default: '2' },
    'log-bytes': { type: 'string' },
    'response-bytes': { type: 'string' },
    'write-share': { type: 'string' },
    'write-units': { type: 'string', default: '5' },
    measurements: { type: 'string', default: path.join(__dirname, '..', 'measurements.json') },
  },
});

const m: Measurements | undefined = existsSync(args.measurements) ? (JSON.parse(readFileSync(args.measurements, 'utf8')) as Measurements) : undefined;

function num(name: string, value: string | undefined, fallback: number | undefined): number {
  const n = value === undefined ? fallback : Number(value);
  if (n === undefined || !Number.isFinite(n) || n < 0) throw new Error(`--${name} is required (or run "npm run measure" first)`);
  return n;
}

const arch = args.arch as Arch;
if (!(arch in PRICES.perGbSecond)) throw new Error('--arch must be arm64 or x86_64');
const memoryMb = num('memory-mb', args['memory-mb'], undefined);
if (memoryMb < 128 || memoryMb > 10240) throw new Error('--memory-mb must be 128 to 10240');
// Already a mean of rounded-up durations. Rounding it up again would bill the rounding twice.
const meanBilled = meanOfBilled(num('duration-ms', args['duration-ms'], m?.warm.meanBilled));
const rc = num('reserved-concurrency', args['reserved-concurrency'], undefined);

// The request mix from the measurement run, unless you give your own write share.
const routeCount = (r: string) => m?.routes[r]?.count ?? 0;
const total = m ? Object.keys(m.routes).reduce((n, r) => n + routeCount(r), 0) : 0;
const measuredWriteShare = total ? (routeCount('create') + routeCount('update') + routeCount('delete')) / total : undefined;
const writeShare = num('write-share', args['write-share'], measuredWriteShare);
const measuredResponse = m && total ? Object.entries(m.responseBytes).reduce((n, [r, b]) => n + b * routeCount(r), 0) / total : undefined;
const responseBytes = num('response-bytes', args['response-bytes'], measuredResponse);
const logBytes = num('log-bytes', args['log-bytes'], m?.logBytesPerRequest);
const writeUnits = num('write-units', args['write-units'], undefined);

const n = (x: number, digits = 0) => x.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const usd = (x: number) => `$${x.toFixed(2)}`;

const free = freeRequests(meanBilled, memoryMb);
const lines: string[] = [];
const out = (s = '') => lines.push(s);

out(`Inputs`);
out(`  mean billed duration  ${meanBilled} ms per request${args['duration-ms'] ? '' : ` (measured ${m?.measuredAt}, ${m?.machine})`}`);
out(`  memory                ${memoryMb} MB, ${arch}`);
out(`  reserved concurrency  ${rc}`);
out(`  GB-seconds/request    ${gbSecondsPerRequest(meanBilled, memoryMb).toPrecision(3)}`);
out();
out(`Lambda, per month`);
out(`  free by request count ${n(free.byCount)}`);
out(`  free by compute       ${n(free.byCompute)}  (400,000 GB-s / GB-s per request)`);
out(`  => ${n(free.free)} requests a month cost $0. The ${free.binding === 'requests' ? '1M request allowance' : '400,000 GB-second allowance'} runs out first.`);
out(`  compute stays free until the mean billed duration passes ${n(breakEvenMs(memoryMb), 1)} ms at ${memoryMb} MB`);
out();
out(`Past the free tier (${arch})`);
for (const extra of [2_000_000, 5_000_000]) {
  const bill = lambdaBill(extra, meanBilled, memoryMb, arch);
  out(`  ${n(extra)} requests  ${usd(bill.total)}  (requests ${usd(bill.requestCost)}, compute ${usd(bill.computeCost)})`);
}
out();
const worst = ceiling(rc, meanBilled, memoryMb, arch);
const absolute = absoluteCeiling(rc, memoryMb, arch);
out(`Ceiling with reserved concurrency ${rc} (callers keep it full for 31 days)`);
out(`  at ${meanBilled} ms   ${n(worst.requests)} requests, ${n(worst.gbSeconds)} GB-s, ${usd(worst.total)}`);
out(`  worst case  ${n(absolute.requests)} requests, ${n(absolute.gbSeconds)} GB-s, ${usd(absolute.total)}  (every request takes 100 ms)`);
out(`  The function URL allows ${rc * 10} requests per second. Callers above that get 429, which isn't billed.`);
out();
out(`Around Lambda, at ${n(free.free)} requests`);
out(`  logs                   ${monthlyGb(free.free, logBytes).toFixed(3)} GB (${logBytes} bytes per successful request; the stack drops START and REPORT lines)`);
out(`  response bytes         ${monthlyGb(free.free, responseBytes).toFixed(2)} GB, against ${FREE_TIER.dataTransferOutGb} GB of free data transfer out (${n(responseBytes)} bytes per response on average)`);
const wcu = averageUnitsPerSecond(free.free, writeShare, m?.writeUnitsPerWrite ?? 1);
out(`  DynamoDB writes        ${wcu.toFixed(2)} units/s on average, against ${writeUnits} provisioned (${n(writeShare * 100)}% of requests write)`);
out();
out(`Memory sizes at this duration (requests free per month)`);
for (const mb of [128, 256, 512, 1024]) {
  const f = freeRequests(meanBilled, mb);
  out(`  ${String(mb).padStart(4)} MB  ${n(f.free).padStart(9)}  (${f.binding} run out first)`);
}

console.log(lines.join('\n'));
