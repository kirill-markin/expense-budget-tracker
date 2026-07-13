import assert from "node:assert/strict";
import test from "node:test";

import {
  getChatComposerCapabilities,
  type ChatComposerCapabilitiesParams,
} from "./chatComposerCapabilities";

const READY_TO_SEND_PARAMS: ChatComposerCapabilitiesParams = {
  composerAction: "send",
  isHistoryLoaded: true,
  isStopping: false,
  isLiveStreamConnected: false,
  isAttachmentProcessing: false,
  dictationState: "idle",
  hasPendingMessage: true,
  shouldSubmitOnEnter: true,
};

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
