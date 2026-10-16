# Cost

These numbers are for us-east-1, checked on 2026-10-15. Prices come from the AWS Price List API offer files. Allowances come from the AWS pricing pages and docs listed at the end.

## The free allowances this stack uses

| Service | Always free each month | This stack uses |
|---|---|---|
| Lambda | 1M requests and 400,000 GB-seconds | One function. Every function in the account shares the allowance |
| DynamoDB | 25 read and 25 write capacity units (provisioned), 25 GB storage | 5 read and 5 write units |
| CloudWatch | 10 standard alarm metrics | 3 |
| Amazon SNS | 1M API requests, 1,000 email deliveries | A few alarm emails |
| Data transfer out | 100 GB to the internet, across services | About 1.4 KB per response |

The Lambda allowance is the same for x86 and Arm. AWS's Graviton launch post says Arm functions are "included in the AWS Free Tier up to the existing limits".

## Which Lambda limit runs out first

A request bills `duration rounded up to the next ms x memory in GB`. The free tier gives 400,000 GB-seconds and 1M requests. Compute and requests run out together when the mean billed duration is:

| Memory | Compute and requests run out together at |
|---|---|
| 128 MB | 3,200 ms |
| 256 MB | 1,600 ms |
| 512 MB | 800 ms |
| 1,024 MB | 400 ms |

Below those durations, the 1M requests run out first. This API's handler takes a few milliseconds, so the request count is the limit that matters. More memory costs nothing extra until you get near the durations above.

Rounding is per request, so use the mean of the billed durations, not the rounded mean. On our laptop the mean raw duration was 4.03 ms and the mean billed duration was 4.54 ms.

## What we measured

`npm run measure` ran the bundled handler on an Apple M4 laptop with Node.js 24.22.0 against DynamoDB Local, 1,000 rounds of create, get, list, update and delete. The laptop was busy with other work, and four runs gave a mean billed duration between 1.3 ms and 4.5 ms. Peak resident memory was 128 MB to 164 MB, and Node.js didn't need to collect garbage early, so treat that as an upper bound for this machine. A successful request logged 0 bytes.

Real Lambda adds a network round trip to DynamoDB and runs on a share of a Graviton CPU, so expect higher durations. Pass the real mean billed duration to the model after you deploy.

## Past the free tier

| Item | Price |
|---|---|
| Lambda requests (x86 and arm64) | $0.20 per million |
| Lambda compute, arm64 | $0.0000133334 per GB-second |
| Lambda compute, x86 | $0.0000166667 per GB-second |
| CloudWatch alarm | $0.10 per alarm metric each month past 10 |
| CloudWatch Logs, Lambda logs | $0.50 per GB for the first 10 TB |
| DynamoDB point-in-time recovery | $0.20 per GB-month, no free tier |

At a few milliseconds per request, 2M requests a month cost $0.20, all of it for the second million requests.

## The cost ceiling

Reserved concurrency of 2 means at most 2 copies of the function run at once. A function URL also limits requests per second to 10 times the reserved concurrency, so 20 a second here. Lambda answers anything beyond either limit with 429, and throttled requests don't count as invocations, which are what Lambda bills.

The worst month is when every request takes 100 ms. Below that, the 20-a-second limit holds the request count flat while compute grows. Above it, concurrency holds compute flat while the request count falls.

| Reserved concurrency | Memory | Max requests in 31 days | Max GB-seconds | Worst Lambda bill (arm64) |
|---|---|---|---|---|
| 1 | 128 MB | 26,784,000 | 334,800 | $5.16 |
| 2 | 256 MB | 53,568,000 | 1,339,200 | $23.04 |
| 5 | 256 MB | 133,920,000 | 3,348,000 | $65.89 |

With reserved concurrency 1 at 128 MB, compute can't leave the free tier at all, so only the request count can cost money.

The ceiling covers Lambda only. It assumes every call comes through the function URL. A principal with `lambda:InvokeFunction` on the function can still call it without the URL, within the same concurrency cap.

## What breaks the $0

| Change | What it costs |
|---|---|
| Logging every request | Lambda logs count as vended logs, billed at $0.50 per GB. We couldn't find an AWS page that says whether CloudWatch's 5 GB of free logs covers them, so the stack logs nothing on success |
| Provisioned concurrency | The Lambda pricing page says the free tier doesn't apply to functions that use it |
| On-demand DynamoDB | The always-free capacity is for provisioned tables |
| An eleventh alarm metric | $0.10 a month each. A metric math alarm doesn't count toward the free 10 |
| Point-in-time recovery | $0.20 per GB-month from the first GB |
| Other functions in the account | They share the same 1M requests. Set `monthlyRequestBudget` to this API's share |

## Sources

| Topic | Page |
|---|---|
| Lambda prices and free tier | https://aws.amazon.com/lambda/pricing/ |
| Function URL cost | https://docs.aws.amazon.com/lambda/latest/dg/furls-http-invoke-decision.html |
| Function URL throttling and the 10x rate limit | https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html |
| Billed duration and the Invocations metric | https://docs.aws.amazon.com/lambda/latest/dg/monitoring-metrics-types.html |
| CloudWatch free tier and alarm pricing | https://aws.amazon.com/cloudwatch/pricing/ |
| DynamoDB free tier | https://aws.amazon.com/dynamodb/pricing/provisioned/ |
| Data transfer out | https://aws.amazon.com/ec2/pricing/on-demand/ |
| Arm functions and the free tier | https://aws.amazon.com/blogs/aws/aws-lambda-functions-powered-by-aws-graviton2-processor-run-your-functions-on-arm-and-get-up-to-34-better-price-performance/ |
| Prices | Price List API, `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<Service>/current/us-east-1/index.json` |
