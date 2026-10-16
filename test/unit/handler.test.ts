/**
 * The handler's HTTP behaviour, with the AWS SDK mocked. The conditional writes
 * themselves run against DynamoDB Local in test/int.
 */
import { ConditionalCheckFailedException, DynamoDBClient, ProvisionedThroughputExceededException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { createHandler, handler, requireEnv } from '../../src/handler';
import { BookmarkStore } from '../../src/store';
import { ALICE, parse, urlEvent } from '../support/events';

const ddb = mockClient(DynamoDBDocumentClient);
const ID = '0mgr2x9k1a1b2c3d4e5f6a7b8';
const api = createHandler(new BookmarkStore('Bookmarks', new DynamoDBClient({ region: 'us-east-1' }), () => ID));

beforeEach(() => ddb.reset());

test('refuses to run without an IAM caller, so a switch to NONE auth fails closed', async () => {
  const res = await api(urlEvent('GET', '/bookmarks', { caller: null }));
  expect(res.statusCode).toBe(403);
  expect(ddb.calls()).toHaveLength(0);
});

test('creates a bookmark owned by the caller, with version 1', async () => {
  ddb.on(PutCommand).resolves({});
  const res = await api(urlEvent('POST', '/bookmarks', { body: { url: 'https://aws.amazon.com/', tags: ['aws'] } }));
  expect(res.statusCode).toBe(201);
  expect(res.headers).toMatchObject({ etag: '"1"', location: `/bookmarks/${ID}` });
  const put = ddb.commandCalls(PutCommand)[0]!.args[0].input;
  expect(put.Item).toMatchObject({ pk: ALICE, sk: ID, version: 1 });
  expect(put.ConditionExpression).toBe('attribute_not_exists(sk)');
});

test('reads a base64 body, which Lambda sends for some content types', async () => {
  ddb.on(PutCommand).resolves({});
  const res = await api(urlEvent('POST', '/bookmarks', { body: { url: 'https://aws.amazon.com/' }, base64: true }));
  expect(res.statusCode).toBe(201);
});

test('an id clash is a 409, never an overwrite', async () => {
  ddb.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'exists', $metadata: {} }));
  expect((await api(urlEvent('POST', '/bookmarks', { body: { url: 'https://aws.amazon.com/' } }))).statusCode).toBe(409);
});

test('a body over 4 KB is refused before parsing', async () => {
  const res = await api(urlEvent('POST', '/bookmarks', { rawBody: JSON.stringify({ url: 'https://example.com', title: 'x'.repeat(5000) }) }));
  expect(res.statusCode).toBe(413);
  expect(ddb.calls()).toHaveLength(0);
});

test('bad JSON and bad fields are 400', async () => {
  expect((await api(urlEvent('POST', '/bookmarks', { rawBody: '{' }))).statusCode).toBe(400);
  expect((await api(urlEvent('POST', '/bookmarks', { body: { url: 'ftp://x' } }))).statusCode).toBe(400);
});

test('PUT without If-Match is 428, so a client can never blindly overwrite', async () => {
  const res = await api(urlEvent('PUT', `/bookmarks/${ID}`, { body: { url: 'https://example.com' } }));
  expect(res.statusCode).toBe(428);
  expect(ddb.calls()).toHaveLength(0);
});

test('a stale If-Match is 412 with the current version in the ETag', async () => {
  ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'stale', $metadata: {}, Item: { version: { N: '4' } } }));
  const res = await api(urlEvent('PUT', `/bookmarks/${ID}`, { body: { url: 'https://example.com' }, headers: { 'if-match': '"3"' } }));
  expect(res.statusCode).toBe(412);
  expect(res.headers).toMatchObject({ etag: '"4"' });
});

test('updating or deleting a missing bookmark is 404', async () => {
  ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'missing', $metadata: {} }));
  ddb.on(DeleteCommand).rejects(new ConditionalCheckFailedException({ message: 'missing', $metadata: {} }));
  expect((await api(urlEvent('PUT', `/bookmarks/${ID}`, { body: { url: 'https://example.com' }, headers: { 'if-match': '1' } }))).statusCode).toBe(404);
  expect((await api(urlEvent('DELETE', `/bookmarks/${ID}`))).statusCode).toBe(404);
});

test('get reads only the caller\'s partition', async () => {
  ddb.on(GetCommand).resolves({});
  expect((await api(urlEvent('GET', `/bookmarks/${ID}`))).statusCode).toBe(404);
  expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({ pk: ALICE, sk: ID });
});

test('list pages newest first, within the caller\'s partition', async () => {
  ddb.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { pk: ALICE, sk: ID } });
  const res = await api(urlEvent('GET', '/bookmarks', { query: { limit: '5', after: ID } }));
  expect(res.statusCode).toBe(200);
  expect(parse(res.body)).toEqual({ items: [], next: ID });
  const q = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
  expect(q).toMatchObject({ Limit: 5, ScanIndexForward: false, ExclusiveStartKey: { pk: ALICE, sk: ID }, ExpressionAttributeValues: { ':owner': ALICE } });
});

test.each([
  ['a limit of 0', { limit: '0' }],
  ['a limit of 51', { limit: '51' }],
  ['a cursor that is not an id', { after: 'arn:aws:iam::123456789012:user/bob' }],
])('list refuses %s', async (_name, query) => {
  expect((await api(urlEvent('GET', '/bookmarks', { query }))).statusCode).toBe(400);
  expect(ddb.calls()).toHaveLength(0);
});

test('unknown paths, bad ids and other methods', async () => {
  expect((await api(urlEvent('GET', '/'))).statusCode).toBe(404);
  expect((await api(urlEvent('GET', '/bookmarks/../admin'))).statusCode).toBe(404);
  expect((await api(urlEvent('GET', '/bookmarks/not-an-id'))).statusCode).toBe(404);
  expect((await api(urlEvent('PATCH', `/bookmarks/${ID}`))).statusCode).toBe(405);
});

test('a throttled table is a 503 with Retry-After', async () => {
  ddb.on(GetCommand).rejects(new ProvisionedThroughputExceededException({ message: 'slow down', $metadata: {} }));
  const res = await api(urlEvent('GET', `/bookmarks/${ID}`));
  expect(res.statusCode).toBe(503);
  expect(res.headers).toMatchObject({ 'retry-after': '1' });
});

test('an unexpected error is a 500 that logs the error name and nothing from the request', async () => {
  const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  ddb.on(GetCommand).rejects(new Error('boom'));
  const res = await api(urlEvent('GET', `/bookmarks/${ID}`));
  expect(res.statusCode).toBe(500);
  expect(log).toHaveBeenCalledTimes(1);
  expect(String(log.mock.calls[0]![0])).not.toContain(ALICE);
  log.mockRestore();
});

test('a successful request logs nothing', async () => {
  const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
  ddb.on(PutCommand).resolves({});
  await api(urlEvent('POST', '/bookmarks', { body: { url: 'https://aws.amazon.com/' } }));
  for (const s of spies) {
    expect(s).not.toHaveBeenCalled();
    s.mockRestore();
  }
});

test('the entry point needs BOOKMARKS_TABLE', async () => {
  delete process.env.BOOKMARKS_TABLE;
  expect(() => requireEnv('BOOKMARKS_TABLE')).toThrow(/BOOKMARKS_TABLE/);
  await expect(handler(urlEvent('GET', '/bookmarks'))).rejects.toThrow(/BOOKMARKS_TABLE/);
});
