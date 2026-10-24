# Production Lambda images

All seven application Lambdas use the architecture-specific AWS Node 24 digests
pinned in [bases.json](../infra/aws/lambda-images/bases.json): six x86 functions
and the ARM sandbox. Each function has its own execution role; the email sender
has decrypt-only access to the retained Cognito encryption key. Construct IDs
and stack output keys retain their `LambdaImageCandidate` names.

CI builds the images on native architecture runners and invokes every real
handler through the AWS runtime interface emulator with a read-only root and
an unprivileged user. The checks cover discovery/auth requests, PDF, DOCX,
XLSX and CSV processing, the real Python worker and SQLite. The sandbox keeps
the just-bash worker/WASM/CPython layout and root dependency overrides.

## Update the images

1. Verify the actual Node version and architecture of new AWS base digests,
   then update both pins together. Require Node 24.22.1 or later in the 24.x line.
2. Require the cloud image checks to pass. All artifact builds run in CI.
   Deploy through the normal CDK workflow so each function receives its new
   image digest; updating an ECR tag alone does not update a Lambda.
3. Verify the deployed configuration and normal application paths below.
   For an isolated AWS runtime probe, deploy a separate disposable function
   from the exact image digest with `probe.handler` as its command. Never
   change the command of a serving function.

The packaged probe initializes the real handler and checks the supervisor and
child interpreter. It uses synthetic fixtures without database writes, FX
fetches or email sends. Application events cannot enable it.

## Verify production without configuration changes

Use the matching account's `--profile` and `--region` on every AWS command.
Read `LambdaImageCandidate<name>Arn` from the stack outputs for `fx`,
`authorizer`, `api`, `mcp`, `sandbox`, `signup` and `email`.

- Use `aws lambda get-function` and `aws lambda get-function-configuration`
  to confirm `PackageType: Image`, the resolved image digest, architecture,
  execution settings and `ImageConfigResponse.ImageConfig.Command` of
  `["index.handler"]`.
- Read CloudWatch logs for `domain: "lambda_image"`,
  `action: "runtime_verified"`, the expected architecture and Node version.
  The sandbox also emits `process: "sandbox_session_child"` and
  `process: "sandbox_prepare_child"` from its real child processes. The
  cold-start guard rejects an old runtime or noncanonical IP/TLS SAN match.
- Read API discovery and MCP metadata/auth challenges. Confirm successful
  authenticated API access, Cognito login, scheduled FX execution and web chat
  document processing in existing request logs. Inspect the errors/throttling
  alarms without creating users, transactions or chat sessions.

Retired functions' CloudWatch log groups remain under their existing retention
policies for investigations.
