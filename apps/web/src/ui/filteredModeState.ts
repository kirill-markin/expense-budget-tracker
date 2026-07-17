import type { AutoFilterDelayMinutes, EnabledAutoFilterDelayMinutes } from "@/lib/locale";

export type VisibilityMode = "all" | "filtered";

export type TimerDecision =
  | Readonly<{ kind: "arm"; delayMs: number; lastActiveAt: number }>
  | Readonly<{ kind: "cancel" }>
  | Readonly<{ kind: "switchToFiltered" }>;

type RestoreVisibilityModeInput = Readonly<{
  storedMode: string | null;
  storedLastActiveAt: string | null;
  autoFilterDelayMinutes: AutoFilterDelayMinutes;
  nowMs: number;
}>;

type RemainingDelayInput = Readonly<{
  delayMs: number;
  lastActiveAt: number;
  nowMs: number;
}>;

type VisibleTimerDecisionInput = Readonly<{
  autoFilterDelayMinutes: AutoFilterDelayMinutes;
  visibilityMode: VisibilityMode;
  lastActiveAt: number | null;
  nowMs: number;
}>;

type PolicyChangeTimerDecisionInput = Readonly<{
  autoFilterDelayMinutes: AutoFilterDelayMinutes;
  visibilityMode: VisibilityMode;
  nowMs: number;
}>;

type ManualModeTimerDecisionInput = Readonly<{
  autoFilterDelayMinutes: AutoFilterDelayMinutes;
  visibilityMode: VisibilityMode;
  nowMs: number;
}>;

export const parseStoredVisibilityMode = (raw: string | null): VisibilityMode | null => {
  if (raw === "all" || raw === "filtered") {
    return raw;
  }
  return null;
};

export const parseStoredLastActiveAt = (raw: string | null): number | null => {
  if (raw === null || raw.trim() === "") {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
};

export const getAutoFilterDelayMs = (
  autoFilterDelayMinutes: EnabledAutoFilterDelayMinutes,
): number => autoFilterDelayMinutes * 60 * 1000;

export const getRemainingDelayMs = (input: RemainingDelayInput): number => {
  const elapsedMs = input.nowMs - input.lastActiveAt;
  if (elapsedMs <= 0) {
    return input.delayMs;
  }

  return Math.max(input.delayMs - elapsedMs, 0);
};

export const resolveStoredVisibilityMode = (input: RestoreVisibilityModeInput): VisibilityMode => {
  const storedMode = parseStoredVisibilityMode(input.storedMode);

  if (input.autoFilterDelayMinutes === null) {
    return storedMode ?? "all";
  }

  if (storedMode === "filtered") {
    return "filtered";
  }

  if (storedMode !== "all") {
    return "filtered";
  }

  const lastActiveAt = parseStoredLastActiveAt(input.storedLastActiveAt);
  if (lastActiveAt === null) {
    return "filtered";
  }

  const remainingDelayMs = getRemainingDelayMs({
    delayMs: getAutoFilterDelayMs(input.autoFilterDelayMinutes),
    lastActiveAt,
    nowMs: input.nowMs,
  });

  return remainingDelayMs > 0 ? "all" : "filtered";
};

export const resolveVisibleTimerDecision = (input: VisibleTimerDecisionInput): TimerDecision => {
  if (input.autoFilterDelayMinutes === null || input.visibilityMode === "filtered") {
    return { kind: "cancel" };
  }

  if (input.lastActiveAt === null) {
    return { kind: "switchToFiltered" };
  }

  const remainingDelayMs = getRemainingDelayMs({
    delayMs: getAutoFilterDelayMs(input.autoFilterDelayMinutes),
    lastActiveAt: input.lastActiveAt,
    nowMs: input.nowMs,
  });

  if (remainingDelayMs === 0) {
    return { kind: "switchToFiltered" };
  }

  return { kind: "arm", delayMs: remainingDelayMs, lastActiveAt: input.lastActiveAt };
};

export const resolvePolicyChangeTimerDecision = (
  input: PolicyChangeTimerDecisionInput,
): TimerDecision => {
  if (input.autoFilterDelayMinutes === null || input.visibilityMode === "filtered") {
    return { kind: "cancel" };
  }

  return {
    kind: "arm",
    delayMs: getAutoFilterDelayMs(input.autoFilterDelayMinutes),
    lastActiveAt: input.nowMs,
  };
};

export const resolveManualModeTimerDecision = (
  input: ManualModeTimerDecisionInput,
): TimerDecision => {
  if (input.autoFilterDelayMinutes === null || input.visibilityMode === "filtered") {
    return { kind: "cancel" };
  }

  return {
    kind: "arm",
    delayMs: getAutoFilterDelayMs(input.autoFilterDelayMinutes),
    lastActiveAt: input.nowMs,
  };
};
