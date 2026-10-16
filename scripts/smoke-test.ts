/**
 * Run after `npm run deploy`, with the same AWS credentials. Acts as a client of the
 * deployed function URL and checks what only a real deploy can prove.
 *
 *   AWS_REGION=us-east-1 npm run smoke
 */
import { Sha256 } from '@aws-crypto/sha256-js';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';

const STACK = process.env.STACK_NAME ?? 'FreeTierBookmarks';
const region = process.env.AWS_REGION ?? 'us-east-1';

async function outputs(): Promise<Record<string, string>> {
  const res = await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: STACK }));
  return Object.fromEntries((res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
}

function check(ok: boolean, message: string): void {
  if (!ok) throw new Error(`FAIL: ${message}`);
  console.log(`ok - ${message}`);
}

const signer = new SignatureV4({ service: 'lambda', region, credentials: defaultProvider(), sha256: Sha256 });

/** Sends a SigV4-signed request to the function URL. */
async function signed(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const url = new URL(path, base);
  const text = body === undefined ? undefined : JSON.stringify(body);
  const request = await signer.sign({
    method,
    protocol: 'https:',
    hostname: url.hostname,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: { host: url.hostname, ...(text ? { 'content-type': 'application/json' } : {}), ...headers },
    body: text,
  });
  return fetch(url, { method, headers: request.headers, body: text });
}

async function main(): Promise<void> {
  const base = (await outputs()).Url!;

  // 1. Lambda refuses unsigned requests before the function runs.
  const unsigned = await fetch(new URL('/bookmarks', base));
  check(unsigned.status === 403, `an unsigned request is refused (got ${unsigned.status})`);

  // 2. The API works for a signed caller.
  const created = await signed(base, 'POST', '/bookmarks', { url: 'https://aws.amazon.com/lambda/', tags: ['smoke'] });
  check(created.status === 201, `POST /bookmarks creates a bookmark (got ${created.status})`);
  const { id } = (await created.json()) as { id: string };
  check((await signed(base, 'GET', `/bookmarks/${id}`)).status === 200, 'GET reads it back');
  check((await signed(base, 'PUT', `/bookmarks/${id}`, { url: 'https://aws.amazon.com/dynamodb/' }, { 'if-match': '"1"' })).status === 200, 'PUT with the right If-Match updates it');
  check((await signed(base, 'PUT', `/bookmarks/${id}`, { url: 'https://example.com/' }, { 'if-match': '"1"' })).status === 412, 'PUT with a stale If-Match is 412');
  check((await signed(base, 'DELETE', `/bookmarks/${id}`)).status === 204, 'DELETE removes it');

  // 3. The cost ceiling: more parallel calls than reserved concurrency allows get 429.
  const burst = await Promise.all(Array.from({ length: 60 }, () => signed(base, 'GET', '/bookmarks?limit=1')));
  const counts = burst.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(`   burst of 60: ${JSON.stringify(counts)}`);
  check((counts[429] ?? 0) > 0, 'a burst above the reserved concurrency gets some 429 responses');
  check(Object.keys(counts).every((s) => s === '200' || s === '429'), 'every burst response is 200 or 429');

  console.log('\nsmoke test passed');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
