# Security

## Who can call the API

The function URL uses `AWS_IAM` auth. Lambda checks the SigV4 signature, the caller's identity policy and the function's resource-based policy before the function runs. An unsigned request gets 403 and never reaches the handler.

By default, only principals in this account whose identity policy allows `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` can call it. The AdministratorAccess managed policy allows both. To add a role, deploy with `-c invokerArn=<role ARN>`. CDK then adds two resource-based policy statements:

- `lambda:InvokeFunctionUrl` with the condition `lambda:FunctionUrlAuthType = AWS_IAM`
- `lambda:InvokeFunction` with the condition `lambda:InvokedViaFunctionUrl = true`

Since October 2025, new function URLs need both permissions. A caller missing either one gets 403.

## Why not auth type NONE

With `NONE`, Lambda runs your function for anyone on the internet who has the URL. Every one of those calls is a billed request. Reserved concurrency still caps the bill (see [cost.md](cost.md)), but your free requests become anyone's to spend.

The handler fails closed if someone switches the URL to `NONE`. Lambda then sends no caller identity, and the handler answers 403 for every request without touching the table. A unit test sends an event with no identity and expects 403.

If you need a public API, put real auth in front of it, such as Amazon Cognito tokens checked in the handler.

## Isolation between callers

The table's partition key is the caller's IAM ARN from `requestContext.authorizer.iam.userArn`. The handler never takes an owner from the request. Every read, update, delete and list uses the caller's own partition, so one caller can't see or change another's bookmarks. An integration test checks this against DynamoDB Local.

For an assumed role, the ARN includes the session name. A client that picks a new session name each time gets a new, empty set of bookmarks each time, so give each client a fixed session name.

## Input limits

- The handler refuses bodies over 4 KB with 413 before parsing.
- URLs must be `http` or `https`, up to 2,048 characters. The handler rejects `javascript:` and `file:` URLs.
- Titles up to 200 characters, up to 5 tags of lowercase letters, digits and dashes.
- The handler rejects unknown fields, so a client can't set `owner`, `version` or `pk`.

## Least privilege

The function's role can call `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem` and `Query` on the bookmarks table, and write to its own log group. Nothing else. A CDK test pins the exact action list.

## What we left out, and why

| Left out | Why |
|---|---|
| AWS WAF | A web ACL costs $5.00 a month plus $1.00 per rule (Price List API, us-east-1), which breaks the $0 goal. `AWS_IAM` auth already blocks anonymous traffic |
| A customer managed KMS key | Each key costs $1.00 a month (Price List API, us-east-1). DynamoDB encrypts at rest with an AWS owned key by default |
| Point-in-time recovery | It bills from the first GB. The stack keeps the table on delete instead |

cdk-nag (AWS Solutions) runs on every synth. The one acknowledged finding, DynamoDB point-in-time recovery, has its reason written next to it in the stack.
