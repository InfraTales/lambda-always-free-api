# Runbook

The stack has three alarms. Each one emails the alert topic when it fires and again when it clears.

## RequestsPace

The function had more invocations in one day than 80% of 1/31 of its monthly request budget (25,806 by default). If every day looked like that, the month would use more than 80% of the free 1M requests.

1. Check the `Invocations` metric for the function by hour. Is it steady growth or a spike?
2. Find out which principal is calling. Add a temporary log line with `requestContext.authorizer.iam.userArn`, deploy, and remove it once you know.
3. If a client is stuck in a retry loop, fix the client or remove its permission.
4. If the traffic is real, either accept the cost ($0.20 per million requests past the first million) or lower the cap.

To stop the function at once, set its reserved concurrency to 0. Every request then gets 429, and throttled requests aren't billed:

```bash
aws lambda put-function-concurrency --function-name <FunctionName> --reserved-concurrent-executions 0
```

Run `npm run deploy` to put the normal cap back.

## ComputePace

A day's total duration passed 80% of 1/31 of the monthly GB-second budget. At 256 MB that's 41,288 seconds of run time in a day. For this API, that means requests got much slower, because at normal speed the request alarm fires long before this one.

1. Check the `Duration` metric (average and p99). Look for DynamoDB throttling first, since the SDK retries throttled calls and each retry adds billed time.
2. Check `ProvisionedThroughputExceededException` in the logs. Callers see those as 503.
3. The 5-second timeout bounds the worst single request.

## Throttled

Lambda refused at least one request in the last 5 minutes. Those callers got 429, because either both reserved slots were busy or more than 20 requests arrived within one second.

- A short burst is the cap doing its job. Clients should retry with backoff.
- Steady throttling means demand above the cap. Raise `reservedConcurrency`, and recheck the ceiling in [cost.md](cost.md).

## The deploy fails on reserved concurrency

Lambda keeps 100 units of account concurrency unreserved, and new accounts start with a lower concurrency quota. If your quota is too low to reserve 2 more units, CloudFormation rejects the function.

1. Open Service Quotas, AWS Lambda, "Concurrent executions", and check the applied value.
2. Request an increase there. The Lambda docs say AWS raises new-account quotas based on your usage.

Don't remove reserved concurrency to get past this. It's the cap on the bill.

## Measuring duration and memory on Lambda

Successful requests write no START or REPORT lines. To measure, deploy for a day with REPORT lines on:

```bash
npm run deploy -- -c reportLines=true
```

Then run this CloudWatch Logs Insights query on the function's log group:

```
filter type = "platform.report"
| stats avg(record.metrics.billedDurationMs) as meanBilledMs,
        max(record.metrics.maxMemoryUsedMB) as maxMemoryMB,
        count(*) as requests
```

Feed the results to the model, then deploy again without `reportLines`:

```bash
npm run free-tier-model -- --duration-ms <meanBilledMs> --memory-mb 256
```

Logs Insights queries scan log data, so run this one a few times, not on a schedule.
