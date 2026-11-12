import { log } from "@/server/logger";

export const CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES = 30;
/** Well inside the expiry, so one failed renewal still leaves a retry before protection lapses. */
export const CHAT_TASK_PROTECTION_RENEW_INTERVAL_MS = 10 * 60 * 1000;
/** Matches the 60-minute chat turn limit, so no turn holds back a deploy for longer. */
export const CHAT_TASK_PROTECTION_MAX_WINDOW_MINUTES = 60;
const MS_PER_MINUTE = 60 * 1000;
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
  log: typeof log;
  now: () => number;
  startRenewalTimer: (
    onTick: () => Promise<void>,
    intervalMs: number,
  ) => StopRenewalTimer;
}>;

type TaskProtectionRequestBody =
  | Readonly<{
    ProtectionEnabled: true;
    ExpiresInMinutes: number;
  }>
  | Readonly<{
    ProtectionEnabled: false;
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
  requestBody: TaskProtectionRequestBody,
): Promise<void> => {
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
  // Start of the current continuous protection window: the successful enable after protection was off.
  let protectionWindowStartedAtMs: number | null = null;
  // When the agent's protection lapses: the last successful enable or renewal plus its expiry.
  let protectionExpiresAtMs: number | null = null;
  let renewalCeilingReachedLogged = false;
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
    requestBody: TaskProtectionRequestBody,
  ): Promise<void> => {
    const agentUri = dependencies.getAgentUri();
    if (agentUri === undefined || agentUri.length === 0) {
      return;
    }

    const expiresInMinutes = requestBody.ProtectionEnabled
      ? requestBody.ExpiresInMinutes
      : undefined;
    // Taken before the request so the window never starts later than the agent applies it.
    const requestedAtMs = dependencies.now();
    try {
      await putTaskProtectionStateWithRetries(
        dependencies.fetchFn,
        agentUri,
        requestBody,
      );
      const successAction = !requestBody.ProtectionEnabled
        ? "task_protection_disabled"
        : taskProtectionEnabled
          ? "task_protection_renewed"
          : "task_protection_enabled";
      if (!requestBody.ProtectionEnabled) {
        protectionWindowStartedAtMs = null;
        protectionExpiresAtMs = null;
        renewalCeilingReachedLogged = false;
      } else {
        if (!taskProtectionEnabled) {
          protectionWindowStartedAtMs = requestedAtMs;
        }
        protectionExpiresAtMs = requestedAtMs + requestBody.ExpiresInMinutes * MS_PER_MINUTE;
      }
      taskProtectionEnabled = requestBody.ProtectionEnabled;
      dependencies.log({
        domain: "chat",
        action: successAction,
        activeProtectedRunCount,
        expiresInMinutes,
      });
    } catch (error) {
      dependencies.log({
        domain: "chat",
        action: requestBody.ProtectionEnabled
          ? "task_protection_enable_failed"
          : "task_protection_disable_failed",
        activeProtectedRunCount,
        expiresInMinutes,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // No expiry may pass the window ceiling; under a minute before it, protection is left to expire.
  const enableTaskProtection = async (): Promise<void> => {
    const windowStartedAtMs = protectionWindowStartedAtMs;
    if (windowStartedAtMs === null) {
      await updateTaskProtection({
        ProtectionEnabled: true,
        ExpiresInMinutes: CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES,
      });
      return;
    }

    const windowAgeMs = dependencies.now() - windowStartedAtMs;
    const minutesUntilCeiling = Math.floor(
      (CHAT_TASK_PROTECTION_MAX_WINDOW_MINUTES * MS_PER_MINUTE - windowAgeMs)
        / MS_PER_MINUTE,
    );
    if (minutesUntilCeiling < 1) {
      if (!renewalCeilingReachedLogged) {
        renewalCeilingReachedLogged = true;
        dependencies.log({
          domain: "chat",
          action: "task_protection_renewal_ceiling_reached",
          activeProtectedRunCount,
          protectionWindowAgeMs: windowAgeMs,
        });
      }
      return;
    }

    await updateTaskProtection({
      ProtectionEnabled: true,
      ExpiresInMinutes: Math.min(
        CHAT_TASK_PROTECTION_EXPIRES_IN_MINUTES,
        minutesUntilCeiling,
      ),
    });
  };

  // Renewing also retries an enable that failed when the first run began.
  const renewTaskProtection = async (): Promise<void> =>
    enqueueOperation(async (): Promise<void> => {
      if (activeProtectedRunCount === 0) {
        return;
      }

      await enableTaskProtection();
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

      // A failed disable leaves the flag on with no run holding it. Once the agent's protection has
      // lapsed, this run starts a new window; before that, it renews at once inside the old window,
      // whose ceiling still caps the expiry.
      if (
        activeProtectedRunCount === 1
        && taskProtectionEnabled
        && (protectionExpiresAtMs === null || dependencies.now() >= protectionExpiresAtMs)
      ) {
        taskProtectionEnabled = false;
        protectionWindowStartedAtMs = null;
        protectionExpiresAtMs = null;
        renewalCeilingReachedLogged = false;
      }

      if (taskProtectionEnabled && activeProtectedRunCount > 1) {
        return;
      }

      await enableTaskProtection();
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

      await updateTaskProtection({ ProtectionEnabled: false });
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
  log,
  now: Date.now,
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
