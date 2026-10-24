# Lambda image candidates

Seven additional Lambda functions use the architecture-specific AWS Node 24
digests pinned in [bases.json](../infra/aws/lambda-images/bases.json). The six
x86 functions and ARM sandbox keep the corresponding ZIP functions' execution
budgets, network placement and secret permissions. Each candidate has its own
execution role. The sender shares the retained Cognito encryption key with
decrypt permission only. Candidates have no routes, schedules, Cognito triggers
or web invoke grants. The ZIP functions continue serving production.

CI builds all seven images on native architecture runners and invokes them
through the AWS runtime interface emulator with a read-only root and an
unprivileged user. The checks initialize every real handler, exercise safe
discovery/auth requests, and process PDF, DOCX and XLSX fixtures plus CSV through
the sandbox's real Python worker and SQLite command. Dependency installation
uses the root lockfile and overrides; runtime sandbox dependencies retain the
just-bash worker/WASM/CPython layout and omit optional native codecs.

## Verify candidates in AWS

Deployment exports `LambdaImageCandidate<name>Arn` for `fx`, `authorizer`, `api`,
`mcp`, `sandbox`, `signup` and `email`. Verification uses an operator identity
with access to these functions; the application and deployment role receive
no additional invoke or update permissions.

For each candidate, save `ImageConfigResponse.ImageConfig.Command` from
`aws lambda get-function-configuration`. Set the command with
`aws lambda update-function-configuration --function-name <candidate-arn>
--image-config '{"Command":["probe.handler"]}'` and wait with
`aws lambda wait function-updated-v2`. Invoke with
`aws lambda invoke --function-name <candidate-arn> --payload '{}'
--cli-binary-format raw-in-base64-out <response-file>` and require both a
successful invocation without `FunctionError` and `packagedHandler: "ok"` in
the response. Always restore the saved image command and wait for the update,
including after a failed probe. Use the matching account's `--profile` and
`--region` on every command. These configuration changes are safe only while
the candidates have no production callers.

The probe is selected solely by the Lambda image command; application events
cannot enable it. It returns the actual supervisor and child Node versions and
architecture. For the sandbox also inspect its CloudWatch log group for
`domain: "lambda_image"`, `action: "runtime_verified"` and
`process: "sandbox_session_child"`; this is emitted by the real session child,
which forks the packaged handler with the image's interpreter. Require Node
24.22.1 or later in the 24.x line for both processes. The cold-start assertion
also refuses the noncanonical IP/TLS SAN match. Probes use synthetic fixtures
and make no database writes, FX fetches or email sends.

## Maintain the base images

Verify the actual Node version and architecture of new AWS base digests, update
both pins together, and require the cloud image jobs to pass before deploying.
All artifact builds run in CI. Switching callers to candidates and retiring the
ZIP functions are separate rollout steps after independent AWS verification.
