/**
 * Runs the real bundle the way one Lambda environment does: load it once, then call the
 * handler one request at a time. Started by scripts/measure.ts in a fresh Node process,
 * so its memory numbers are this handler's and not the test runner's.
 *
 * Writes one JSON line to fd 3 when done.
 */
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const [bundle, iterationsArg] = process.argv.slice(2);
const iterations = Number(iterationsArg);

// Count every byte the handler logs, the way CloudWatch Logs would ingest it.
let logBytes = 0;
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    logBytes += Buffer.byteLength(chunk);
    return write(chunk, ...rest);
  };
}

const owner = 'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Developer_0123456789abcdef/alice@example.com';
function event(method, path, body, headers = {}, query) {
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...headers },
    queryStringParameters: query,
    isBase64Encoded: false,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: {
      http: { method, path },
      authorizer: { iam: { userArn: owner, accountId: '123456789012', callerId: 'AROAEXAMPLE:alice@example.com', userId: 'AROAEXAMPLE:alice@example.com', accessKey: 'AKIAIOSFODNN7EXAMPLE' } },
    },
  };
}

const sample = (i) => ({
  url: `https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html?item=${i}`,
  title: 'Configuring reserved concurrency for a function',
  tags: ['lambda', 'cost'],
});

async function main() {
  const t0 = performance.now();
  const { handler } = require(bundle);
  const initMs = performance.now() - t0;

  const timings = { create: [], get: [], list: [], update: [], delete: [] };
  const responseBytes = { create: [], get: [], list: [], update: [], delete: [] };
  let peakRss = process.memoryUsage().rss;
  let firstInvokeMs;

  async function call(route, ev, expected) {
    const start = performance.now();
    const res = await handler(ev);
    const ms = performance.now() - start;
    if (res.statusCode !== expected) throw new Error(`${route}: expected ${expected}, got ${res.statusCode} ${res.body}`);
    if (firstInvokeMs === undefined) firstInvokeMs = ms;
    else timings[route].push(ms);
    responseBytes[route].push(Buffer.byteLength(res.body ?? ''));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    return res;
  }

  for (let i = 0; i < iterations; i++) {
    const created = JSON.parse((await call('create', event('POST', '/bookmarks', sample(i)), 201)).body);
    await call('get', event('GET', `/bookmarks/${created.id}`), 200);
    await call('list', event('GET', '/bookmarks', undefined, {}, { limit: '20' }), 200);
    await call('update', event('PUT', `/bookmarks/${created.id}`, { ...sample(i), title: 'Reserved concurrency' }, { 'if-match': '"1"' }), 200);
    if (i % 2 === 0) await call('delete', event('DELETE', `/bookmarks/${created.id}`, undefined, { 'if-match': '"2"' }), 204);
  }

  const calls = Object.values(timings).reduce((n, t) => n + t.length, 0) + 1;
  fs.writeSync(3, JSON.stringify({ initMs, firstInvokeMs, timings, responseBytes, peakRssBytes: peakRss, logBytes, calls, nodeVersion: process.version }) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
