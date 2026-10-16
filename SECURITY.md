# Security policy

## Reporting a problem

Please don't report security problems in public GitHub issues. Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").

It helps to include the file and line or the commit, the steps to reproduce, and what an attacker could do with it.

## How this stack protects itself

The short version is below. [docs/security.md](docs/security.md) has the details and the reasons.

- The function URL uses `AWS_IAM` auth. Lambda refuses unsigned requests before the function runs.
- If the URL is ever switched to auth type `NONE`, the handler refuses every request.
- Each caller's bookmarks live under their own IAM ARN, and the handler never takes an owner from the request.
- Reserved concurrency caps how much the function can run, so a flood of requests has a known maximum cost.
- The function's role can make five DynamoDB calls on one table, and write its own logs. Nothing else.
