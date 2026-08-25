# Langfuse Operations

Use this guide after the chat runtime cutover to confirm that tracing is healthy and to troubleshoot missing or malformed telemetry.

## Production model

The web chat now runs with fully app-managed state:

- transcript state lives in Postgres
- the OpenAI loop runs in the web process
- Langfuse receives one trace per user turn
- trace name is `chat_turn`
- Langfuse `sessionId` matches the chat session id
- the active root `agent` observation stores the sanitized turn input and terminal assistant outcome
- OpenAI generations and local tool observations run inside that root observation

Audio transcription uses a separate active `chat_transcription` root. Its root stores the upload summary and transcription output. When the client supplies a chat session id of at most 200 characters, the root and observed OpenAI generation inherit that `sessionId`.

OpenAI Conversations, hosted code interpreter containers, and provider-managed recovery are not part of the runtime anymore.

## Required configuration

The web container needs all of these values together:

- `OPENAI_API_KEY`
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`
- `LANGFUSE_RELEASE`

If only part of the Langfuse config is present, or the release is not an explicit 64-character lowercase hexadecimal fingerprint, production startup validation fails. CDK sets the production release to the deterministic asset hash of the same web Docker image asset consumed by the ECS task definition, so it covers every file included in the staged image context, including included files ignored by Git.

## Export mode

Spans are exported in batches, not one by one:

- the span processor uses the `@langfuse/otel` default `batched` export mode
- the OpenTelemetry batch processor schedules a flush every 5 seconds by default, so a finished turn can take a few seconds to appear in Langfuse
- batching keeps OTLP serialization and the export request off the chat request path, so telemetry competes less with request handling for the event loop
- exporter retry behavior uses the SDK and OpenTelemetry defaults; the app does not add another retry layer
- spans still queued when a web task stops are lost, because nothing flushes the SDK on exit; this is an accepted trade-off, not a misconfiguration
- observation update and end failures are logged without changing the chat result; background exporter failures are not propagated into the chat request

Treat a trace that is missing for only a few seconds after a turn as normal batching latency.

## What a healthy trace looks like

For every user turn in the web chat, Langfuse should show:

- trace name `chat_turn`
- release equal to the deployed web Docker asset fingerprint
- `sessionId` equal to the chat session id
- `userId` equal to the authenticated app user id
- tags `surface:web-chat`, `runtime:local-loop`, and `vendor:openai`
- metadata including `requestId`, `workspaceId`, `model`, `attempt`, `turnIndex`, `hasAttachments`, `attachmentCount`, and `runState`

For a plain text turn, expect:

- one root `agent` observation for `chat_turn`
- one nested OpenAI generation observation
- sanitized `turnInput` on the root before the generation starts
- a terminal root output written after the application outcome is known

The chat root output uses these result values:

- `success` only after final assistant tool normalization and `completeChatRun` persistence; the client `done` event is emitted only after that write succeeds
- `cancelled` only after user-cancellation persistence
- `invalidated` when the run was discarded or lost its active-run transition
- `error` for a persisted stream terminal error or a thrown failure

For a turn that uses `query_database`, expect:

- one root `agent` observation for `chat_turn`
- at least one nested OpenAI generation observation
- one nested tool observation for `query_database`
- if the tool result causes a follow-up model call, another nested generation observation under the same trace

For an audio transcription with a chat session id, expect:

- one root `agent` observation for `chat_transcription`
- one nested OpenAI generation observation
- the same `sessionId` on both observations so session cost includes the generation
- the upload summary on the root input and transcription text on the root output

## How to filter traces

Use these filters first:

- `traceName = chat_turn`
- `sessionId = <chat session id>` when debugging one conversation
- `userId = <app user id>` when debugging one person across sessions
- metadata `workspaceId = <workspace id>` when debugging one workspace
- tag `runtime:local-loop` to isolate the new runtime

Useful metadata for narrowing a trace:

- `requestId` for one exact server request
- `model` for model-specific regressions
- root output `result` to separate completed, cancelled, invalidated, and failed turns
- `turnIndex` to understand where in the chat history the problem happened

## First production smoke check

After deploying or rotating secrets:

1. Open the web chat as a normal user.
2. Send a plain question that should not use tools.
3. Wait a few seconds for the batch export, then confirm a `chat_turn` trace appears in Langfuse with the expected tags and metadata.
4. Send a question that should trigger `query_database`.
5. Confirm the same shape appears after the same batch delay, now with a nested tool observation.

## What to check when telemetry is missing

If no traces appear at all:

- wait out the batch delay described in `## Export mode` before treating a missing trace as a configuration problem
- if the web task was replaced or restarted right after the turn, expect the queued spans for that turn to be gone for good
- confirm the ECS web task has all `LANGFUSE_*` environment values
- confirm `LANGFUSE_RELEASE` matches the deployed web Docker asset fingerprint
- confirm the web service was restarted after writing Secrets Manager values
- check web container logs for startup validation failures about partial Langfuse configuration
- check web container logs for `Langfuse telemetry failed:` errors

If traces appear but are missing grouping or metadata:

- confirm the trace is named `chat_turn`
- confirm `sessionId`, `userId`, and `workspaceId` are present on the root observation
- confirm the trace carries `surface:web-chat`, `runtime:local-loop`, and `vendor:openai`

If tool activity is missing from a trace:

- confirm the user turn actually triggered `query_database`
- check application logs for `tool_call` events
- confirm the tool execution completed inside the same request lifecycle

If a chat works but no Langfuse data is exported:

- verify `LANGFUSE_BASE_URL` points to the intended Langfuse deployment
- verify the Langfuse keys belong to the same project you are inspecting
- confirm there is outbound network access from the web task to Langfuse Cloud

## Data handling notes

- attachment `base64Data` is not sent to Langfuse
- telemetry is masked before export for emails, phones, API-key-like strings, and long number sequences
- telemetry failures are not part of the chat correctness path; the chat can succeed even when export fails

## Current non-goals

The repository uses the GA Langfuse JS/TS SDK v5 with OpenTelemetry ingestion. It has no direct Langfuse read API, raw ingestion request, generated client, evaluator job, dataset experiment, or export integration. The only code-derived observation-evaluator candidates are the `chat_turn` and `chat_transcription` roots described above; this does not establish that any evaluator exists in the Langfuse project.

`LANGFUSE_BASE_URL` can point to Langfuse Cloud or a self-hosted deployment. The application does not discover the server major; self-hosted operators must confirm the target is on Langfuse v4 before completing the project cutover.

Project-dependent migration checks remain blocked until access to the confirmed target project is configured. That includes project reads or writes, representative non-production ingestion, evaluator and export cutovers, and rollback verification. Check these project surfaces separately:

- [Migration status](https://cloud.langfuse.com/v4-migration)
- [Evaluators](https://cloud.langfuse.com/project/~/evals), including active Legacy rows
- [Integrations](https://cloud.langfuse.com/project/~/settings/integrations), including export sources and downstream cutover state

Do not enable or cut over evaluators or exports until a representative non-production trace has been inspected. Keep disabled legacy evaluators for rollback. Repository behavior follows the official [v4 overview](https://langfuse.com/docs/v4), [compatibility matrix](https://langfuse.com/docs/compatibility), [JS/TS upgrade path](https://langfuse.com/docs/observability/sdk/upgrade-path/js-v4-to-v5), [OpenAI integration](https://langfuse.com/integrations/model-providers/openai-js), and [batching lifecycle](https://langfuse.com/docs/observability/features/queuing-batching).
