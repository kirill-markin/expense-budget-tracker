import type { ChatDictationState } from "../hooks/chatDictation";
import type { ChatComposerAction } from "../streamRecovery";

export type ChatComposerCapabilitiesParams = Readonly<{
  composerAction: ChatComposerAction;
  isHistoryLoaded: boolean;
  isStopping: boolean;
  isLiveStreamConnected: boolean;
  dictationState: ChatDictationState;
  hasPendingMessage: boolean;
  shouldSubmitOnEnter: boolean;
}>;

export type ChatComposerCapabilities = Readonly<{
  isTextareaDisabled: boolean;
  isSubmitButtonDisabled: boolean;
  isEnterSubmissionEnabled: boolean;
  isAttachButtonDisabled: boolean;
  isMicrophoneButtonDisabled: boolean;
  isDropTargetEnabled: boolean;
  shouldSubmitOnEnter: boolean;
}>;

const isDictationBusy = (dictationState: ChatDictationState): boolean =>
  dictationState === "requesting_permission" || dictationState === "transcribing";

export const getChatComposerCapabilities = (
  params: ChatComposerCapabilitiesParams,
): ChatComposerCapabilities => {
  const {
    composerAction,
    isHistoryLoaded,
    isStopping,
    isLiveStreamConnected,
    dictationState,
    hasPendingMessage,
    shouldSubmitOnEnter,
  } = params;
  const isDictationActive = dictationState !== "idle";
  const canAttachFiles = isHistoryLoaded && !isStopping && !isDictationActive;
  const isSubmitButtonDisabled = composerAction === "stop"
    ? !isHistoryLoaded || isStopping
    : !isHistoryLoaded
      || isStopping
      || isDictationActive
      || isLiveStreamConnected
      || !hasPendingMessage;
  const isEnterSubmissionEnabled = shouldSubmitOnEnter
    && composerAction === "send"
    && !isSubmitButtonDisabled;

  return {
    isTextareaDisabled: isDictationActive,
    isSubmitButtonDisabled,
    isEnterSubmissionEnabled,
    isAttachButtonDisabled: !canAttachFiles,
    isMicrophoneButtonDisabled: !isHistoryLoaded
      || isStopping
      || isDictationBusy(dictationState),
    isDropTargetEnabled: canAttachFiles,
    shouldSubmitOnEnter,
  };
};
