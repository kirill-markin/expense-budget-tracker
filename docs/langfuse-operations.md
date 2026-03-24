# Langfuse Operations

Use this guide after the chat runtime cutover to confirm that tracing is healthy and to troubleshoot missing or malformed telemetry.

## Production model

The web chat now runs with fully app-managed state:

- transcript state lives in Postgres
- the OpenAI loop runs in the web process
- Langfuse receives one trace per user turn
- trace name is `chat_turn`
- Langfuse `sessionId` matches the chat session id

OpenAI Conversations, hosted code interpreter containers, and provider-managed recovery are not part of the runtime anymore.

## Required configuration

The web container needs all of these values together:

- `OPENAI_API_KEY`
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`

If only part of the Langfuse config is present, production startup validation fails.

## What a healthy trace looks like

For every user turn in the web chat, Langfuse should show:

- trace name `chat_turn`
- `sessionId` equal to the chat session id
- `userId` equal to the authenticated app user id
- tags `surface:web-chat`, `runtime:local-loop`, and `vendor:openai`
- metadata including `requestId`, `workspaceId`, `model`, `attempt`, `turnIndex`, `hasAttachments`, `attachmentCount`, and `runState`

For a plain text turn, expect:

- one root `agent` observation for `chat_turn`
- one nested OpenAI generation observation

For a turn that uses `query_database`, expect:

- one root `agent` observation for `chat_turn`
- at least one nested OpenAI generation observation
- one nested tool observation for `query_database`
- if the tool result causes a follow-up model call, another nested generation observation under the same trace

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
- `runState` to separate successful turns from interrupted or failed ones
- `turnIndex` to understand where in the chat history the problem happened

## First production smoke check

After deploying or rotating secrets:

1. Open the web chat as a normal user.
2. Send a plain question that should not use tools.
3. Confirm a `chat_turn` trace appears in Langfuse with the expected tags and metadata.
4. Send a question that should trigger `query_database`.
5. Confirm the same shape appears, now with a nested tool observation.

## What to check when telemetry is missing

If no traces appear at all:

- confirm the ECS web task has all `LANGFUSE_*` environment values
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

The cutover does not include a Langfuse dataset workflow yet. There is currently no admin or job flow in this repo that creates dataset items from `sourceTraceId` or `sourceObservationId`. Treat that as phase 2 observability work, not as a blocker for the runtime migration.
