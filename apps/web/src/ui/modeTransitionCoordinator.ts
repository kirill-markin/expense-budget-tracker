export type ApplicationMode = "all" | "filtered" | "demo";

export type ModeTransitionRequest = Readonly<{
  target: ApplicationMode;
  source: "automatic" | "manual";
}>;

type ModeTransitionCoordinatorDependencies = Readonly<{
  settleEditors: () => Promise<boolean>;
  commitTransition: (request: ModeTransitionRequest) => void;
  handleSettlementFailure: (request: ModeTransitionRequest) => void;
  handleSettlementError: (
    request: ModeTransitionRequest,
    error: unknown,
  ) => void;
}>;

export type ModeTransitionCoordinator = Readonly<{
  requestTransition: (request: ModeTransitionRequest) => Promise<boolean>;
  retryPendingTransition: () => Promise<boolean> | null;
}>;

export const createModeTransitionCoordinator = (
  dependencies: ModeTransitionCoordinatorDependencies,
): ModeTransitionCoordinator => {
  let activeTransition: Promise<boolean> | null = null;
  let pendingRequest: ModeTransitionRequest | null = null;

  const startPendingTransition = (): Promise<boolean> => {
    if (activeTransition !== null) return activeTransition;
    if (pendingRequest === null) {
      throw new Error("Cannot start a mode transition without a pending request");
    }

    let transition: Promise<boolean>;
    let transitionRequest: ModeTransitionRequest | null = null;
    transition = Promise.resolve()
      .then(dependencies.settleEditors)
      .then((settled): boolean => {
        const completedRequest = pendingRequest;
        if (completedRequest === null) {
          throw new Error("Mode transition settled without a pending request");
        }
        transitionRequest = completedRequest;
        if (settled) {
          pendingRequest = null;
          dependencies.commitTransition(completedRequest);
        } else {
          dependencies.handleSettlementFailure(completedRequest);
        }
        return settled;
      })
      .catch((error: unknown): boolean => {
        const failedRequest = pendingRequest ?? transitionRequest;
        pendingRequest = null;
        if (failedRequest === null) {
          throw error;
        }
        dependencies.handleSettlementError(failedRequest, error);
        return false;
      })
      .finally((): void => {
        if (activeTransition === transition) activeTransition = null;
      });
    activeTransition = transition;
    return transition;
  };

  const requestTransition = (
    request: ModeTransitionRequest,
  ): Promise<boolean> => {
    pendingRequest = request;
    return startPendingTransition();
  };

  const retryPendingTransition = (): Promise<boolean> | null => (
    pendingRequest === null ? null : startPendingTransition()
  );

  return { requestTransition, retryPendingTransition };
};
