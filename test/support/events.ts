import type { LambdaFunctionURLEventWithIAMAuthorizer } from 'aws-lambda';

export const ALICE = 'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_Developer_0123456789abcdef/alice@example.com';
export const BOB = 'arn:aws:iam::123456789012:user/bob';

interface Options {
  caller?: string | null;
  body?: unknown;
  rawBody?: string;
  base64?: boolean;
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/** A function URL event in the shape Lambda sends with AWS_IAM auth (payload format 2.0). */
export function urlEvent(method: string, path: string, opts: Options = {}): LambdaFunctionURLEventWithIAMAuthorizer {
  const caller = opts.caller === undefined ? ALICE : opts.caller;
  let body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined && opts.base64) body = Buffer.from(body).toString('base64');
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers: { 'content-type': 'application/json', ...opts.headers },
    queryStringParameters: opts.query,
    isBase64Encoded: Boolean(opts.base64),
    body,
    requestContext: {
      accountId: '123456789012',
      apiId: 'urlid',
      domainName: 'urlid.lambda-url.us-east-1.on.aws',
      domainPrefix: 'urlid',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '192.0.2.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '15/Oct/2026:12:00:00 +0000',
      timeEpoch: 0,
      // With NONE auth, Lambda sets authorizer to null.
      authorizer: (caller === null
        ? null
        : { iam: { accessKey: 'AKIAIOSFODNN7EXAMPLE', accountId: '123456789012', callerId: 'AROAEXAMPLE:alice', principalOrgId: null, userArn: caller, userId: 'AROAEXAMPLE:alice', cognitoIdentity: null } }) as never,
    },
  };
}

export const parse = (body: string | undefined) => JSON.parse(body ?? 'null') as Record<string, any>;
