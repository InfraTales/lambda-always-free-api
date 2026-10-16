/**
 * Measures the real bundle against DynamoDB Local and writes measurements.json, which
 * `npm run free-tier-model` reads.
 *
 *   docker run -d --rm -p 8012:8000 amazon/dynamodb-local:3.3.2
 *   npm run measure            # 1,000 rounds of create, get, list, update, delete
 *   MEASURE_NODE=/path/to/node24 npm run measure   # run the handler on Node.js 24
 *
 * These are laptop numbers. Real Lambda adds network time to DynamoDB, runs on a
 * Graviton CPU slice sized by memory, and reports billed duration in its REPORT log
 * line. Re-run the model with numbers from CloudWatch after you deploy.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { createTable, dropTable, localClient, localEnv } from './local-dynamodb';

const root = path.join(__dirname, '..');
const rounds = Number(process.argv[2] ?? 1000);

interface WorkerResult {
  initMs: number;
  firstInvokeMs: number;
  timings: Record<string, number[]>;
  responseBytes: Record<string, number[]>;
  peakRssBytes: number;
  logBytes: number;
  calls: number;
  nodeVersion: string;
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  // Lambda rounds each request up to the next millisecond, then adds them up.
  const meanBilled = values.reduce((a, b) => a + Math.max(1, Math.ceil(b)), 0) / values.length;
  return { count: values.length, mean: round2(mean), meanBilled: round2(meanBilled), p50: round2(percentile(sorted, 50)), p95: round2(percentile(sorted, 95)), p99: round2(percentile(sorted, 99)) };
}

function runWorker(table: string): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    // MEASURE_NODE lets you run the worker on the same Node.js major as Lambda (24).
    const node = process.env.MEASURE_NODE ?? process.execPath;
    const child = spawn(node, [path.join(__dirname, 'measure-worker.cjs'), path.join(root, 'build', 'lambda', 'index.js'), String(rounds)], {
      env: { PATH: process.env.PATH, ...localEnv, BOOKMARKS_TABLE: table },
      stdio: ['ignore', 'inherit', 'inherit', 'pipe'],
    });
    let out = '';
    child.stdio[3]!.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000);
    child.on('exit', (code) => {
      clearTimeout(deadline);
      if (code === 0) resolve(JSON.parse(out) as WorkerResult);
      else reject(new Error(`measure worker exited with ${code}`));
    });
  });
}

/** DynamoDB Local reports consumed capacity, so we ask it what one typical write costs. */
async function writeUnitsForTypicalItem(table: string): Promise<number> {
  const client = localClient();
  const res = await client.send(
    new PutItemCommand({
      TableName: table,
      ReturnConsumedCapacity: 'TOTAL',
      Item: {
        pk: { S: 'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Developer_0123456789abcdef/alice@example.com' },
        sk: { S: '0mgr2x9k1a1b2c3d4e5f6a7b8' },
        id: { S: '0mgr2x9k1a1b2c3d4e5f6a7b8' },
        url: { S: 'https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html?item=999' },
        title: { S: 'Configuring reserved concurrency for a function' },
        tags: { L: [{ S: 'lambda' }, { S: 'cost' }] },
        version: { N: '1' },
        createdAt: { S: '2026-10-15T12:00:00.000Z' },
        updatedAt: { S: '2026-10-15T12:00:00.000Z' },
      },
    }),
  );
  return res.ConsumedCapacity?.CapacityUnits ?? Number.NaN;
}

async function main(): Promise<void> {
  const client = localClient();
  const table = `measure-${Date.now()}`;
  await createTable(client, table);
  try {
    const r = await runWorker(table);
    const all = Object.values(r.timings).flat();
    const routes = Object.fromEntries(Object.entries(r.timings).map(([k, v]) => [k, summarize(v)]));
    const responses = Object.fromEntries(Object.entries(r.responseBytes).map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length)]));
    const result = {
      measuredAt: new Date().toISOString().slice(0, 10),
      machine: `${os.cpus()[0]?.model ?? 'unknown CPU'}, ${os.platform()} ${os.arch()}, Node.js ${r.nodeVersion}`,
      note: 'Laptop against DynamoDB Local. Real Lambda adds network time to DynamoDB and runs on a smaller CPU share. Treat these as a floor.',
      rounds,
      bundleLoadMs: round2(r.initMs),
      firstInvokeMs: round2(r.firstInvokeMs),
      warm: summarize(all),
      routes,
      peakRssMb: round2(r.peakRssBytes / 1024 / 1024),
      logBytesPerRequest: round2(r.logBytes / r.calls),
      responseBytes: responses,
      writeUnitsPerWrite: await writeUnitsForTypicalItem(table),
    };
    writeFileSync(path.join(root, 'measurements.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await dropTable(client, table);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
