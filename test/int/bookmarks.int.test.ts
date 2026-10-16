/**
 * The real bundle (build/lambda/index.js, the file Lambda runs) against DynamoDB Local.
 * Every condition expression runs on the real engine, including races.
 *
 *   docker run -d --rm -p 8012:8000 amazon/dynamodb-local:3.3.2
 *   npm run test:int
 */
import * as path from 'node:path';
import type { LambdaFunctionURLEventWithIAMAuthorizer } from 'aws-lambda';
import { BookmarkStore, IdCollision } from '../../src/store';
import { createTable, dropTable, localClient, localEnv } from '../../scripts/local-dynamodb';
import { ALICE, BOB, parse, urlEvent } from '../support/events';

const TABLE = `int-${Date.now()}`;
const client = localClient();
type Res = { statusCode: number; headers?: Record<string, string>; body?: string };
let call: (e: LambdaFunctionURLEventWithIAMAuthorizer) => Promise<Res>;

beforeAll(async () => {
  Object.assign(process.env, localEnv, { BOOKMARKS_TABLE: TABLE });
  await createTable(client, TABLE);
   
  const bundle = require(path.join(__dirname, '..', '..', 'build', 'lambda', 'index.js')) as { handler: typeof call };
  call = bundle.handler;
});
afterAll(() => dropTable(client, TABLE));

async function create(owner = ALICE, url = 'https://aws.amazon.com/lambda/'): Promise<Record<string, any>> {
  const res = await call(urlEvent('POST', '/bookmarks', { caller: owner, body: { url, title: 'Lambda', tags: ['aws'] } }));
  expect(res.statusCode).toBe(201);
  return parse(res.body);
}
const put = (id: string, version: string | undefined, owner = ALICE) =>
  call(urlEvent('PUT', `/bookmarks/${id}`, { caller: owner, body: { url: 'https://aws.amazon.com/dynamodb/', title: 'DynamoDB' }, headers: version ? { 'if-match': version } : {} }));
const del = (id: string, version?: string, owner = ALICE) => call(urlEvent('DELETE', `/bookmarks/${id}`, { caller: owner, headers: version ? { 'if-match': version } : {} }));
const get = (id: string, owner = ALICE) => call(urlEvent('GET', `/bookmarks/${id}`, { caller: owner }));

test('create, read, update with If-Match, then delete', async () => {
  const b = await create();
  expect(b).toMatchObject({ url: 'https://aws.amazon.com/lambda/', title: 'Lambda', tags: ['aws'], version: 1 });

  const read = await get(b.id);
  expect(read.statusCode).toBe(200);
  expect(read.headers?.etag).toBe('"1"');

  const updated = await put(b.id, '"1"');
  expect(updated.statusCode).toBe(200);
  expect(parse(updated.body)).toMatchObject({ url: 'https://aws.amazon.com/dynamodb/', version: 2, createdAt: b.createdAt });

  const stale = await put(b.id, '"1"');
  expect(stale.statusCode).toBe(412);
  expect(stale.headers?.etag).toBe('"2"');

  expect((await del(b.id, '"1"')).statusCode).toBe(412);
  expect((await del(b.id, '"2"')).statusCode).toBe(204);
  expect((await get(b.id)).statusCode).toBe(404);
});

test('20 clients update the same version at once: exactly one wins', async () => {
  const b = await create();
  const results = await Promise.all(Array.from({ length: 20 }, () => put(b.id, '"1"')));
  const codes = results.map((r) => r.statusCode).sort();
  expect(codes.filter((c) => c === 200)).toHaveLength(1);
  expect(codes.filter((c) => c === 412)).toHaveLength(19);
  expect(parse((await get(b.id)).body).version).toBe(2);
});

test('10 clients delete the same bookmark at once: one 204, the rest 404', async () => {
  const b = await create();
  const codes = (await Promise.all(Array.from({ length: 10 }, () => del(b.id)))).map((r) => r.statusCode);
  expect(codes.filter((c) => c === 204)).toHaveLength(1);
  expect(codes.filter((c) => c === 404)).toHaveLength(9);
});

test('an update never brings a deleted bookmark back', async () => {
  const b = await create();
  expect((await del(b.id)).statusCode).toBe(204);
  expect((await put(b.id, '"1"')).statusCode).toBe(404);
  expect((await get(b.id)).statusCode).toBe(404);
});

test('a create with a clashing id fails and leaves the first bookmark alone', async () => {
  const id = '0mgr2x9k1a1b2c3d4e5f6a7b8';
  const store = new BookmarkStore(TABLE, client, () => id);
  await store.create(ALICE, { url: 'https://first.example.com/', title: 'first', tags: [] });
  await expect(store.create(ALICE, { url: 'https://second.example.com/', title: 'second', tags: [] })).rejects.toBeInstanceOf(IdCollision);
  expect((await store.get(ALICE, id)).url).toBe('https://first.example.com/');
});

test("one caller can't read, change or delete another caller's bookmark", async () => {
  const b = await create(ALICE);
  expect((await get(b.id, BOB)).statusCode).toBe(404);
  expect((await put(b.id, '"1"', BOB)).statusCode).toBe(404);
  expect((await del(b.id, undefined, BOB)).statusCode).toBe(404);
  expect((await get(b.id, ALICE)).statusCode).toBe(200);
  // Bob's update didn't create a copy in his own partition either.
  const bobs = parse((await call(urlEvent('GET', '/bookmarks', { caller: BOB }))).body);
  expect(bobs.items).toEqual([]);
});

test('list pages through one caller, newest first', async () => {
  const carol = 'arn:aws:iam::123456789012:user/carol';
  const made: string[] = [];
  for (let i = 0; i < 7; i++) {
    made.push((await create(carol, `https://example.com/${i}`)).id);
    await new Promise((r) => setTimeout(r, 2)); // ids sort by millisecond
  }
  const seen: string[] = [];
  let after: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await call(urlEvent('GET', '/bookmarks', { caller: carol, query: { limit: '3', ...(after ? { after } : {}) } }));
    const body = parse(res.body);
    seen.push(...body.items.map((b: { id: string }) => b.id));
    if (!body.next) break;
    after = body.next;
  }
  expect(seen).toEqual([...made].reverse());
});
