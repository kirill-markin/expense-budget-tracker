# Agent Telemetry

How to answer "how many agent tool calls failed, where and why" for the three agent surfaces from the records production already writes. Langfuse owns the chat trace shape and is documented separately in [langfuse-operations.md](langfuse-operations.md).

Each surface writes to more than one place, and each place counts a different unit, so always say which one a number came from:

| Surface | Unit of one tool call | Records | Log group |
| --- | --- | --- | --- |
| Hosted MCP server | one `mcp_tool_call` record | `mcp_tool_call`, `sql_policy_rejected`, `mcp_unexpected_error` | `/aws/lambda/ExpenseBudgetTracker-McpHandler03E6F2E1-3CSCraZ4ica1` |
| MCP transport | one HTTP request, which can carry several tool calls | API Gateway access log | `ExpenseBudgetTracker-McpApiAccessLogGroup5B86EB4E-O26C60B6XtE9` |
| Web chat | one `chat` / `tool_call` record | `tool_call`, `sql_policy_rejected` | `/expense-tracker/web` |
| `/v1` machine API | one HTTP request to one resource path | API Gateway access log | `ExpenseBudgetTracker-SqlApiAccessLogGroup0B9BA1DB-6ijpABrzSkZ0` |
| `/v1` handler | the reason behind a `/v1` failure status | `sql_policy_rejected`, `agent_request_unavailable` | `/aws/lambda/ExpenseBudgetTracker-SqlApiHandler03D84818-KW4HJkTouQLY` |

The access log groups and `/expense-tracker/web` keep 30 days; the Lambda groups have no retention policy, so their window is open-ended. `/expense-tracker/web` is pinned in `infra/aws/lib/compute.ts`, but every other name above carries a CDK hash suffix that changes when the stack replaces the group, so re-discover the current names with a substring match rather than a prefix, which would miss the two `/aws/lambda/` groups:

```bash
aws logs describe-log-groups --profile expense-tracker --region eu-central-1 \
  --log-group-name-pattern ExpenseBudgetTracker \
  --query 'logGroups[].logGroupName' --output text
```

The pattern form returns no `retentionInDays` for any group, so read retention with `--log-group-name-prefix /aws/lambda/ExpenseBudgetTracker` for the two handler groups and `--log-group-name-prefix ExpenseBudgetTracker` for the two access log groups.

## Field meanings the names do not give

- `outcome` (MCP, `success` or `error`) and `status` (web chat, `completed` or `error`) say whether the model received a result or an error.
- `errorCode` is the exact code the client-visible error envelope carried, so the same failure is countable by the same code on every surface. A web chat call that threw before producing any model-facing payload is recorded as the synthesized `internal_error`.
- `caller` (MCP) is the client `User-Agent` reduced to a safe character set and cut to 120 characters, so punctuation such as a comma or underscore appears as `.` and `claude-code/2.1.282 (sdk-ts, agent-sdk/0.3.276)` is recorded as `claude-code/2.1.282 (sdk-ts. agent-sdk/0.3.276)`. A client that sends no header records `null`; one that sends an empty header records `""`. It identifies a client family, never an identity.
- `workspaceId` on an MCP record is `null` for `list_workspaces` and `get_guide`, which resolve no workspace, and for any failure that happened before the workspace resolved. On a web chat record it is the chat session's workspace, which is not necessarily the workspace a successful cross-workspace statement acted on.
- `tool` is the name that was called, not the name the surface advertises: a web chat session whose stored transcript still carries the deprecated `query_database` alias is counted under that name rather than under `sql_query`.
- `domain` is spelled `sql_api` by the MCP server and the `/v1` handler and `sql-api` by the web app, so it is safe to group across groups only by `action`.
- `ip` in both access logs is the Cloudflare edge address, never the client's, so per-client questions must use `userAgent` plus the API key or MCP identity.

## Running a query

Every query below is a CloudWatch Logs Insights query, runnable in the console or from the CLI:

```bash
aws logs start-query --profile expense-tracker --region eu-central-1 \
  --log-group-name '<log group>' \
  --start-time "$(date -v-7d +%s)" --end-time "$(date +%s)" \
  --query-string '<query>'

aws logs get-query-results --profile expense-tracker --region eu-central-1 \
  --query-id '<queryId from start-query>'
```

In the Lambda groups each structured line is prefixed by timestamp, request id and `INFO`, so the raw line is not valid JSON. Logs Insights still discovers the embedded JSON fields, which is why the queries below filter on `action` directly. `aws logs filter-log-events` is a usable fallback when a single-group grep is enough: both `--filter-pattern '{ $.action = "mcp_tool_call" }'` and `--filter-pattern '"mcp_tool_call"'` match these lines. A record takes up to about a minute to reach the group at all, so a call made seconds ago is missing from every read, filtered or not.

## Hosted MCP server

Tool-call volume and failure rate by tool, then the same split by failure code and by client:

```
filter action = "mcp_tool_call"
| stats count(*) as calls, sum(outcome = "error") as failures by tool
| sort calls desc
```

```
filter action = "mcp_tool_call"
| stats count(*) as calls, sum(outcome = "error") as failures by errorCode, tool
| sort failures desc, calls desc
```

```
filter action = "mcp_tool_call"
| stats count(*) as calls, sum(outcome = "error") as failures by caller
| sort failures desc, calls desc
```

Why the failures happened. A restricted SQL rejection carries the policy code and reason; an unexpected error carries the boundary that threw instead:

```
filter domain = "sql_api" and (action = "sql_policy_rejected" or action = "mcp_unexpected_error")
| stats count(*) as records by action, code, boundary, operation
| sort records desc
```

Individual calls, where `@requestId` is the Lambda invocation that served them:

```
filter action = "mcp_tool_call"
| fields @timestamp, @requestId, tool, outcome, errorCode, workspaceId, caller
| sort @timestamp desc
```

## MCP transport

Request-level status mix per client. A `401` on `GET /mcp` is the normal OAuth challenge step of a working client, so it is excluded; the `401` rows that remain are mostly third-party probe traffic, but a single client's `POST /mcp` `401` can still be its own challenge step rather than a failure, which is why the breakdown stays per `userAgent` rather than being summed:

```
filter not (routeKey = "GET /mcp" and status = 401)
| stats count(*) as requests by userAgent, routeKey, status
| sort requests desc
```

## Web chat

Volume and failure rate by tool and failure code:

```
filter domain = "chat" and action = "tool_call"
| stats count(*) as calls, sum(status = "error") as failures by tool, errorCode
| sort failures desc, calls desc
```

Individual calls, with everything needed to open the matching request, session, user and Langfuse trace. Add `and status = "error"` to the filter to list only the failures:

```
filter domain = "chat" and action = "tool_call"
| fields @timestamp, tool, status, errorCode, durationMs, requestId, sessionId, userId, workspaceId
| sort @timestamp desc
```

Why the SQL failures happened:

```
filter action = "sql_policy_rejected"
| stats count(*) as rejections by code
| sort rejections desc
```

## `/v1` machine API

Failure rate per resource path and client. A restricted SQL rejection is answered `400`, so it is inside the failure count. Keep `status` out of the grouping: as a grouping key it makes `failures` equal `requests` on every failing row and zero on every other one, which is a status mix rather than a rate.

```
fields status >= 400 as isFailure
| stats count(*) as requests, sum(isFailure) as failures by resourcePath, httpMethod, userAgent
| sort failures desc, requests desc
```

Why the failures happened, from the handler's own records in the Lambda group. One request leaves at most one of these three records, so `records` never double-counts, but it explains only part of the access log's `failures`: a `401`, a `400 sql_execution_failed`, a `404` and a `504` are each answered without any of the three, so the gap between the two queries is expected rather than a discrepancy to chase. `agent_account_disabled` carries no `code`, so its row leaves that column blank:

```
filter domain = "sql_api" and action in ["sql_policy_rejected", "agent_request_unavailable", "agent_account_disabled"]
| stats count(*) as records by action, code
| sort records desc
```

Two further actions are stage details that always accompany one of those three, so counting them too would count the same failure twice: `sql_result_over_budget` with `outcome = "read_rejected"` is always answered as `sql_policy_rejected` with `code = "sql_result_too_large"`, and its other outcomes are degraded successes rather than failures; `agent_auth_unavailable` is always answered as `agent_request_unavailable` with `code = "agent_auth_unavailable"`.

## Traffic to separate out

- The post-deploy smoke `scripts/live-agent-api-smoke.mjs`, run from GitHub Actions, appears in the `/v1` access log with `userAgent: node`. It deliberately triggers one `401` on `/v1/me` and submits no invalid SQL, so every `/v1` policy rejection is real client traffic. `node` is also the default User-Agent of any other Node client, so it does not identify the smoke on its own; confirm against `gh run list --workflow deploy.yml` timing.
- Unauthenticated MCP requests from registry crawlers, uptime probes and security scanners are a large and growing share of the MCP access log. A failure count that includes them is wrong.

## What these records cannot answer

- A tool call the MCP SDK rejects before the handler runs — an unknown tool name, or arguments that fail the tool's schema — emits no `mcp_tool_call` record, so the MCP failure count undercounts that class. The SDK delivers both as a JSON-RPC error inside a successful HTTP response, so the transport access log shows a plain `200` and the class is invisible there too. The only trace is `mcp_unexpected_error`, and only when the boundary itself throws.
- Parallel tool calls inside one MCP request are not correlated with each other. They share `@requestId` and nothing finer, so neither their order nor which of them produced a given rejection is recoverable.
- `sql_policy_rejected` carries only the policy code and reason on every surface: no tool, workspace, caller, request id or statement text. It joins to a tool call only through the matching `errorCode` within the same invocation or request.
- A `sql_policy_rejected` record in `/expense-tracker/web` can come from either the web chat tools or the web `api/agent/sql` route, and nothing in the record says which.
- Neither access log carries identity: no API key, connection id or user id. Attributing `/v1` or MCP HTTP traffic to a person needs the application records or the stored connection labels.
- A missing or unaccepted credential leaves no application record: the `/v1` authorizer and the MCP bearer challenge both answer without logging. A rejected credential exists only as an access log line — on MCP both a missing and an unaccepted token are answered `401` — so it can be counted but never explained: no reason, no identity, no key. The access log's `errorMessage` is what separates an authorizer denial from other refusals. The one authentication-stage refusal that does leave a record is `agent_account_disabled`, written with the user id behind a `403`.
- The `/v1` access log has no concept of a tool, and the web chat records have no concept of an HTTP status, so a single cross-surface "failure rate" is not derivable without first deciding which unit the question means.
