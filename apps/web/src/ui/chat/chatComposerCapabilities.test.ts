import assert from "node:assert/strict";
import test from "node:test";

import { getChatComposerCapabilities } from "./chatComposerCapabilities";

test("getChatComposerCapabilities enables send and draft controls for a non-empty idle draft", () => {
  assert.deepEqual(
    getChatComposerCapabilities({
      composerAction: "send",
      isHistoryLoaded: true,
      isStopping: false,
      isLiveStreamConnected: false,
      dictationState: "idle",
      hasPendingMessage: true,
    }),
    {
      isTextareaDisabled: false,
      isSubmitButtonDisabled: false,
      isAttachButtonDisabled: false,
      isMicrophoneButtonDisabled: false,
      isDropTargetEnabled: true,
    },
  );
});

test("getChatComposerCapabilities disables send for an empty idle draft", () => {
  assert.equal(
    getChatComposerCapabilities({
      composerAction: "send",
      isHistoryLoaded: true,
      isStopping: false,
      isLiveStreamConnected: false,
      dictationState: "idle",
      hasPendingMessage: false,
    }).isSubmitButtonDisabled,
    true,
  );
});

test("getChatComposerCapabilities keeps draft inputs available while the assistant is streaming", () => {
  assert.deepEqual(
    getChatComposerCapabilities({
      composerAction: "stop",
      isHistoryLoaded: true,
      isStopping: false,
      isLiveStreamConnected: true,
      dictationState: "idle",
      hasPendingMessage: true,
    }),
    {
      isTextareaDisabled: false,
      isSubmitButtonDisabled: false,
      isAttachButtonDisabled: false,
      isMicrophoneButtonDisabled: false,
      isDropTargetEnabled: true,
    },
  );
});

test("getChatComposerCapabilities blocks draft actions while a stop request is in flight", () => {
  assert.deepEqual(
    getChatComposerCapabilities({
      composerAction: "stop",
      isHistoryLoaded: true,
      isStopping: true,
      isLiveStreamConnected: true,
      dictationState: "idle",
      hasPendingMessage: true,
    }),
    {
      isTextareaDisabled: false,
      isSubmitButtonDisabled: true,
      isAttachButtonDisabled: true,
      isMicrophoneButtonDisabled: true,
      isDropTargetEnabled: false,
    },
  );
});

test("getChatComposerCapabilities keeps the microphone enabled while recording so the user can stop dictation", () => {
  assert.deepEqual(
    getChatComposerCapabilities({
      composerAction: "stop",
      isHistoryLoaded: true,
      isStopping: false,
      isLiveStreamConnected: true,
      dictationState: "recording",
      hasPendingMessage: true,
    }),
    {
      isTextareaDisabled: true,
      isSubmitButtonDisabled: false,
      isAttachButtonDisabled: true,
      isMicrophoneButtonDisabled: false,
      isDropTargetEnabled: false,
    },
  );
});

test("getChatComposerCapabilities blocks send, attachment, and drop while dictation is waiting for permission", () => {
  assert.deepEqual(
    getChatComposerCapabilities({
      composerAction: "send",
      isHistoryLoaded: true,
      isStopping: false,
      isLiveStreamConnected: false,
      dictationState: "requesting_permission",
      hasPendingMessage: true,
    }),
    {
      isTextareaDisabled: true,
      isSubmitButtonDisabled: true,
      isAttachButtonDisabled: true,
      isMicrophoneButtonDisabled: true,
      isDropTargetEnabled: false,
    },
  );
});

test("getChatComposerCapabilities blocks send, attachment, and drop while dictation is transcribing", () => {
  assert.deepEqual(
    getChatComposerCapabilities({
      composerAction: "send",
      isHistoryLoaded: true,
      isStopping: false,
      isLiveStreamConnected: false,
      dictationState: "transcribing",
      hasPendingMessage: true,
    }),
    {
      isTextareaDisabled: true,
      isSubmitButtonDisabled: true,
      isAttachButtonDisabled: true,
      isMicrophoneButtonDisabled: true,
      isDropTargetEnabled: false,
    },
  );
});
