/**
 * One Lambda function behind a function URL with AWS_IAM auth. Lambda checks the
 * caller's signature before this code runs, and passes the caller's IAM identity in
 * requestContext.authorizer.iam. Each caller sees only their own bookmarks.
 *
 *   GET    /bookmarks?limit=20&after=<id>   newest first
 *   POST   /bookmarks                       { url, title?, tags? }
 *   GET    /bookmarks/<id>
 *   PUT    /bookmarks/<id>   If-Match: "<version>"   replace, only if unchanged
 *   DELETE /bookmarks/<id>   If-Match optional
 */
import type { LambdaFunctionURLEventWithIAMAuthorizer, LambdaFunctionURLResult } from 'aws-lambda';
import { BookmarkStore, IdCollision, NotFound, VersionConflict, type Bookmark } from './store';
import { ID_PATTERN, LIMITS, ValidationError, parseBookmark, parseVersion } from './validate';

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

type Result = Exclude<LambdaFunctionURLResult, string>;

const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}): Result => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const problem = (statusCode: number, message: string, headers?: Record<string, string>) => json(statusCode, { message }, headers);
const etag = (b: Bookmark) => ({ etag: `"${b.version}"` });

/** Lambda lower-cases header names in function URL events. */
function header(event: LambdaFunctionURLEventWithIAMAuthorizer, name: string): string | undefined {
  return event.headers?.[name];
}

function readJson(event: LambdaFunctionURLEventWithIAMAuthorizer): unknown {
  const raw = event.body ?? '';
  const text = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(text, 'utf8') > LIMITS.body) throw new TooLarge();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError('body is not valid JSON');
  }
}
class TooLarge extends Error {}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 50) throw new ValidationError('limit must be a whole number from 1 to 50');
  return n;
}

export function createHandler(store: BookmarkStore) {
  return async (event: LambdaFunctionURLEventWithIAMAuthorizer): Promise<Result> => {
    // With AWS_IAM auth this is always set. If it isn't, the URL was switched to NONE
    // and we refuse to guess who the caller is.
    const owner = event.requestContext?.authorizer?.iam?.userArn;
    if (!owner) return problem(403, 'this API needs AWS_IAM auth on the function URL');

    const method = event.requestContext.http.method;
    const parts = event.rawPath.split('/').filter(Boolean);
    if (parts[0] !== 'bookmarks' || parts.length > 2) return problem(404, 'not found');
    const id = parts[1];
    if (id !== undefined && !ID_PATTERN.test(id)) return problem(404, 'not found');

    try {
      if (id === undefined && method === 'GET') {
        const q = event.queryStringParameters ?? {};
        if (q.after !== undefined && !ID_PATTERN.test(q.after)) throw new ValidationError('after must be a bookmark id');
        const page = await store.list(owner, parseLimit(q.limit), q.after);
        return json(200, { items: page.items, next: page.lastId ?? null });
      }
      if (id === undefined && method === 'POST') {
        const created = await store.create(owner, parseBookmark(readJson(event)));
        return json(201, created, { ...etag(created), location: `/bookmarks/${created.id}` });
      }
      if (id !== undefined && method === 'GET') {
        const found = await store.get(owner, id);
        return json(200, found, etag(found));
      }
      if (id !== undefined && method === 'PUT') {
        const expected = parseVersion(header(event, 'if-match'));
        if (expected === undefined) return problem(428, 'send If-Match with the ETag you last read');
        const updated = await store.update(owner, id, expected, parseBookmark(readJson(event)));
        return json(200, updated, etag(updated));
      }
      if (id !== undefined && method === 'DELETE') {
        await store.delete(owner, id, parseVersion(header(event, 'if-match')));
        return { statusCode: 204 };
      }
      return problem(405, 'method not allowed');
    } catch (err) {
      if (err instanceof ValidationError) return problem(400, err.message);
      if (err instanceof TooLarge) return problem(413, `body is larger than ${LIMITS.body} bytes`);
      if (err instanceof NotFound) return problem(404, 'not found');
      if (err instanceof VersionConflict) return problem(412, 'the bookmark changed since you read it', { etag: `"${err.current}"` });
      if (err instanceof IdCollision) return problem(409, 'id clash, please retry');
      if (err instanceof Error && err.name === 'ProvisionedThroughputExceededException') {
        // The table is provisioned small on purpose. Tell the client to back off.
        return problem(503, 'busy, retry shortly', { 'retry-after': '1' });
      }
      console.error(JSON.stringify({ message: 'unhandled error', error: err instanceof Error ? err.name : String(err) }));
      return problem(500, 'internal error');
    }
  };
}

let cached: ReturnType<typeof createHandler> | undefined;

/** The Lambda entry point. The client and table name are read once per environment. */
export const handler = async (event: LambdaFunctionURLEventWithIAMAuthorizer): Promise<Result> => {
  cached ??= createHandler(new BookmarkStore(requireEnv('BOOKMARKS_TABLE')));
  return cached(event);
};
