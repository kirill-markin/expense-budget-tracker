import type { TFunction } from "i18next";

// Headers identify catalog messages while preserving the plain-text response bodies.
export const SETTINGS_ERROR_CODE_HEADER = "X-Settings-Error-Code";
export const AGENT_KEY_ACTIVE_COUNT_HEADER = "X-Agent-Key-Active-Count";
export const AGENT_KEY_LIMIT_HEADER = "X-Agent-Key-Limit";

export const SETTINGS_ERROR_CODES = {
  confirmationPhraseMismatch: "confirmation_phrase_mismatch",
  invalidMonthRange: "invalid_month_range",
  agentKeyLimitReached: "agent_key_limit_reached",
} as const;

export const readSettingsError = async (response: Response, t: TFunction): Promise<string> => {
  switch (response.headers.get(SETTINGS_ERROR_CODE_HEADER)) {
    case SETTINGS_ERROR_CODES.confirmationPhraseMismatch:
      return t("publicShare.confirmationPhraseMismatch");
    case SETTINGS_ERROR_CODES.invalidMonthRange:
      return t("publicShare.invalidMonthRange");
    case SETTINGS_ERROR_CODES.agentKeyLimitReached: {
      const activeCount = response.headers.get(AGENT_KEY_ACTIVE_COUNT_HEADER);
      const limit = response.headers.get(AGENT_KEY_LIMIT_HEADER);
      if (activeCount === null || limit === null || !/^\d+$/u.test(activeCount) || !/^\d+$/u.test(limit)) {
        throw new Error(`Agent key limit response (${response.status}) must include the active key count and limit.`);
      }
      return t("agentAccess.activeKeyLimitReached", { activeCount, limit });
    }
    default:
      return response.text();
  }
};
