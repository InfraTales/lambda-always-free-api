# Contributing

Thanks for helping. This repo shows how to run a real API inside Lambda's always-free tier, so every change has to keep two things true: the tests prove the behaviour against a real engine, and the cost numbers stay sourced.

## Setup

You need Node.js 24 and npm. Docker is only needed for the integration tests and `npm run measure`.

```bash
npm ci
npm run check        # type check, lint, bundle, unit + infra tests, synth with cdk-nag
```

To run the integration tests:

```bash
docker run -d --rm -p 8012:8000 amazon/dynamodb-local:3.3.2
AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8012 npm run test:int
```

## Layout

| Path | What's there |
|---|---|
| `src/handler.ts` | The function URL handler and its routes |
| `src/store.ts` | DynamoDB access. Every write is conditional |
| `src/validate.ts` | Input rules and size limits |
| `model/free-tier.ts` | Free-tier allowances, prices and the cost math |
| `infra/lib/free-api-stack.ts` | The CDK stack |
| `scripts/` | Bundling, measuring, the model, the smoke test |
| `test/unit`, `test/infra` | Tests that run with `npm test` |
| `test/int` | The real bundle against DynamoDB Local |

## What a change needs

- **A test that fails without it.** For a bug, write the failing test first. For a safeguard, break it once and check that a test fails.
- **Real-engine tests for DynamoDB conditions.** Asserting the expression string isn't enough. Add the case to `test/int`.
- **A source for every price or allowance.** Update `docs/cost.md` with the page or Price List API offer file you used and the date.
- **No new alarm without counting.** The stack uses 3 of the 10 free alarm metrics. A metric math alarm doesn't count toward the free ones.
- **A written reason for any cdk-nag acknowledgement**, scoped to the construct it's about.
- **Docs updated** when behaviour changes.

## Pull requests

Branch from `main`, keep each pull request to one change, and explain why in the description. CI must pass before merge.

Found a security problem? Don't open a public issue. [SECURITY.md](SECURITY.md) says where to send it.

---

Created by Rahul Ladumor / InfraTales
