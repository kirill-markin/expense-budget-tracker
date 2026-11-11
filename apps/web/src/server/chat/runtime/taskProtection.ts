import { log } from "@/server/logger";

export const CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES = 30;
/** Well inside the expiry, so one failed renewal still leaves a retry before protection lapses. */
export const CHAT_TASK_PROTECTION_RENEW_INTERVAL_MS = 10 * 60 * 1000;
const TASK_PROTECTION_PATH = "/task-protection/v1/state";
const TASK_PROTECTION_RETRY_COUNT = 3;

type FetchLike = typeof fetch;

type TaskProtectionController = Readonly<{
  beginProtectedRun: () => Promise<void>;
  endProtectedRun: () => Promise<void>;
  getActiveProtectedRunCount: () => number;
}>;

type StopRenewalTimer = () => void;

type TaskProtectionDependencies = Readonly<{
  fetchFn: FetchLike;
  getAgentUri: () => string | undefined;
  startRenewalTimer: (
    onTick: () => Promise<void>,
    intervalMs: number,
  ) => StopRenewalTimer;
}>;

type TaskProtectionRequestBody = Readonly<{
  ProtectionEnabled: boolean;
  ExpiresInMinutes?: number;
}>;

const buildTaskProtectionUrl = (
  agentUri: string,
): string => {
  const normalizedAgentUri = agentUri.endsWith("/")
    ? agentUri.slice(0, -1)
    : agentUri;
  return `${normalizedAgentUri}${TASK_PROTECTION_PATH}`;
};

const putTaskProtectionStateWithRetries = async (
  fetchFn: FetchLike,
  agentUri: string,
  protectionEnabled: boolean,
): Promise<void> => {
  const requestBody: TaskProtectionRequestBody = protectionEnabled
    ? {
      ProtectionEnabled: true,
      ExpiresInMinutes: CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES,
    }
    : {
      ProtectionEnabled: false,
    };

  let lastError: Error | null = null;
  let attempt = 0;
  while (attempt < TASK_PROTECTION_RETRY_COUNT) {
    attempt += 1;

    try {
      const response = await fetchFn(buildTaskProtectionUrl(agentUri), {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        return;
      }

      const responseText = await response.text();
      throw new Error(
        `Task protection request failed with status ${String(response.status)}: ${responseText}`,
      );
    } catch (error) {
      lastError = error instanceof Error
        ? error
        : new Error(String(error));
    }
  }

  if (lastError === null) {
    throw new Error("Task protection request failed without an error");
  }

  throw lastError;
};

export const createTaskProtectionControllerWithDeps = (
  dependencies: TaskProtectionDependencies,
): TaskProtectionController => {
  let activeProtectedRunCount = 0;
  let taskProtectionEnabled = false;
  let stopRenewalTimer: StopRenewalTimer | null = null;
  let operationQueue: Promise<void> = Promise.resolve();

  const enqueueOperation = (
    operation: () => Promise<void>,
  ): Promise<void> => {
    const nextOperation = operationQueue.then(operation, operation);
    operationQueue = nextOperation.catch((): void => undefined);
    return nextOperation;
  };

  const updateTaskProtection = async (
    protectionEnabled: boolean,
  ): Promise<void> => {
    const agentUri = dependencies.getAgentUri();
    if (agentUri === undefined || agentUri.length === 0) {
      return;
    }

    try {
      await putTaskProtectionStateWithRetries(
        dependencies.fetchFn,
        agentUri,
        protectionEnabled,
      );
      const successAction = !protectionEnabled
        ? "task_protection_disabled"
        : taskProtectionEnabled
          ? "task_protection_renewed"
          : "task_protection_enabled";
      taskProtectionEnabled = protectionEnabled;
      log({
        domain: "chat",
        action: successAction,
        activeProtectedRunCount,
        expiresInMinutes: protectionEnabled
          ? CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES
          : undefined,
      });
    } catch (error) {
      log({
        domain: "chat",
        action: protectionEnabled
          ? "task_protection_enable_failed"
          : "task_protection_disable_failed",
        activeProtectedRunCount,
        expiresInMinutes: protectionEnabled
          ? CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES
          : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Renewing also retries an enable that failed when the first run began.
  const renewTaskProtection = async (): Promise<void> =>
    enqueueOperation(async (): Promise<void> => {
      if (activeProtectedRunCount === 0) {
        return;
      }

      await updateTaskProtection(true);
    });

  const beginProtectedRun = async (): Promise<void> =>
    enqueueOperation(async (): Promise<void> => {
      activeProtectedRunCount += 1;
      if (stopRenewalTimer === null) {
        stopRenewalTimer = dependencies.startRenewalTimer(
          renewTaskProtection,
          CHAT_TASK_PROTECTION_RENEW_INTERVAL_MS,
        );
      }

      if (taskProtectionEnabled) {
        return;
      }

      await updateTaskProtection(true);
    });

  const endProtectedRun = async (): Promise<void> =>
    enqueueOperation(async (): Promise<void> => {
      if (activeProtectedRunCount === 0) {
        return;
      }

      activeProtectedRunCount -= 1;
      if (activeProtectedRunCount > 0) {
        return;
      }

      if (stopRenewalTimer !== null) {
        stopRenewalTimer();
        stopRenewalTimer = null;
      }

      if (!taskProtectionEnabled) {
        return;
      }

      await updateTaskProtection(false);
    });

  return {
    beginProtectedRun,
    endProtectedRun,
    getActiveProtectedRunCount: (): number => activeProtectedRunCount,
  };
};

const sharedTaskProtectionController = createTaskProtectionControllerWithDeps({
  fetchFn: fetch,
  getAgentUri: (): string | undefined => process.env.ECS_AGENT_URI,
  startRenewalTimer: (
    onTick: () => Promise<void>,
    intervalMs: number,
  ): StopRenewalTimer => {
    const timer = setInterval((): void => {
      void onTick();
    }, intervalMs);
    timer.unref();
    return (): void => {
      clearInterval(timer);
    };
  },
});

export const beginChatTaskProtection = async (): Promise<void> =>
  sharedTaskProtectionController.beginProtectedRun();

export const endChatTaskProtection = async (): Promise<void> =>
  sharedTaskProtectionController.endProtectedRun();
