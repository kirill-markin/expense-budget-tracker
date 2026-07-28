import assert from "node:assert/strict";
import test from "node:test";

import {
  getChatComposerCapabilities,
  type ChatComposerCapabilitiesParams,
} from "./chatComposerCapabilities";

const READY_TO_SEND_PARAMS: ChatComposerCapabilitiesParams = {
  composerAction: "send",
  isHistoryLoaded: true,
  isTextareaReady: true,
  isStopping: false,
  isLiveStreamConnected: false,
  isAttachmentProcessing: false,
  isSubmissionPending: false,
  dictationState: "idle",
  hasPendingMessage: true,
  shouldSubmitOnEnter: true,
};

test("disables the textarea until the selected target is ready", (): void => {
  const capabilities = getChatComposerCapabilities({
    ...READY_TO_SEND_PARAMS,
    isHistoryLoaded: false,
    isTextareaReady: false,
  });

  assert.equal(capabilities.isTextareaDisabled, true);
  assert.equal(capabilities.isSubmitButtonDisabled, true);
});

test("keeps only the textarea ready during an exact adoption handoff", (): void => {
  const capabilities = getChatComposerCapabilities({
    ...READY_TO_SEND_PARAMS,
    isHistoryLoaded: false,
    isTextareaReady: true,
  });

  assert.deepEqual(capabilities, {
    isTextareaDisabled: false,
    isSubmitButtonDisabled: true,
    isEnterSubmissionEnabled: false,
    isAttachButtonDisabled: true,
    isMicrophoneButtonDisabled: true,
    isDropTargetEnabled: false,
    shouldSubmitOnEnter: true,
  });
});

test("disables attachment-conflicting actions while preprocessing", (): void => {
  const capabilities = getChatComposerCapabilities({
    ...READY_TO_SEND_PARAMS,
    isAttachmentProcessing: true,
  });

  assert.deepEqual(capabilities, {
    isTextareaDisabled: false,
    isSubmitButtonDisabled: true,
    isEnterSubmissionEnabled: false,
    isAttachButtonDisabled: true,
    isMicrophoneButtonDisabled: true,
    isDropTargetEnabled: false,
    shouldSubmitOnEnter: true,
  });
});

test("keeps the active-run stop action available while preprocessing", (): void => {
  const capabilities = getChatComposerCapabilities({
    ...READY_TO_SEND_PARAMS,
    composerAction: "stop",
    isLiveStreamConnected: true,
    isAttachmentProcessing: true,
  });

  assert.equal(capabilities.isSubmitButtonDisabled, false);
  assert.equal(capabilities.isAttachButtonDisabled, true);
  assert.equal(capabilities.isMicrophoneButtonDisabled, true);
  assert.equal(capabilities.isDropTargetEnabled, false);
  assert.equal(capabilities.isEnterSubmissionEnabled, false);
});

test("blocks another send while a draft create request is unresolved", (): void => {
  const capabilities = getChatComposerCapabilities({
    ...READY_TO_SEND_PARAMS,
    isSubmissionPending: true,
  });

  assert.equal(capabilities.isTextareaDisabled, false);
  assert.equal(capabilities.isSubmitButtonDisabled, true);
  assert.equal(capabilities.isEnterSubmissionEnabled, false);
  assert.equal(capabilities.isAttachButtonDisabled, false);
});

test("blocks Send while Stop remains pending after an idle snapshot", (): void => {
  const capabilities = getChatComposerCapabilities({
    ...READY_TO_SEND_PARAMS,
    isStopping: true,
  });

  assert.equal(capabilities.isSubmitButtonDisabled, true);
  assert.equal(capabilities.isEnterSubmissionEnabled, false);
});
