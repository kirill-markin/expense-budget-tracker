# Admin reader

The owner, or his LLM agent, reads any user's chat sessions, chat items and
LLM telemetry spans from production with `scripts/admin-read.sh`. The script
invokes a private Lambda that has no function URL, no API Gateway route and no
resource policy, so only an IAM principal allowed `lambda:InvokeFunction` on it
can call it. The Lambda connects as the `admin_reader` database role: `SELECT`
on users, workspaces, memberships, chat sessions, chat items, chat files and
`llm_telemetry_spans`, in read-only transactions. It is the one deliberate
exception to the rule against standing database access.

It reads no financial data, runs no free-form SQL and writes nothing.

## Run it

Use the production account's `--profile` and `--region` (region from
`infra/aws/cdk.context.local.json`, the matching profile from `~/.aws/config`).
The script has no defaults for either and fails without them.

```bash
scripts/admin-read.sh --profile <profile> --region <region> '<json event>'
```

It prints the JSON response to stdout. A failed call exits non-zero and prints
the Lambda's error, which says what to change.

## Events

Find a user by email (case-insensitive) with their workspaces:

```json
{"action":"find_user","email":"user@example.com"}
```

List sessions, newest activity first, with item and span counts and token
totals. `userId`, `workspaceId` or both are required; `since` (ISO 8601) and
`limit` (1–100, required) bound the list:

```json
{"action":"list_sessions","userId":"<user id>","since":"2026-11-01T00:00:00Z","limit":20}
```

Read one session: the session row, a page of its items in order and a page of
its spans by start time. `itemLimit` is 1–200 and `spanLimit` is 1–500;
`item_count` and `span_count` in the response say how far to page with
`itemOffset` and `spanOffset`. Each `encrypted_content` string in an item
payload is replaced by `{"omitted": true, "chars": <length>}`:

```json
{"action":"get_session","sessionId":"<session id>","itemOffset":0,"itemLimit":50,"spanOffset":0,"spanLimit":200}
```

Read every span of one trace:

```json
{"action":"get_trace","traceId":"<32 hex characters>"}
```

A response over 5 MB fails and names what to change: a smaller `limit`, or for
`get_session` whether the items or the spans are too big, or which single item
or span can never fit. For that row it names the limit that first reads the
unread rows before it, then the offset that skips it.

## Audit trail

Every call writes one `"action":"admin_reader_call"` line to the function's
CloudWatch log group (`/aws/lambda/<AdminReaderFunctionName>`): the request's
ids and limits, row counts, duration and outcome. Response content is never
logged.
