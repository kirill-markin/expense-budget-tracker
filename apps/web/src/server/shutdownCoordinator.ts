import { log } from "@/server/logger";

export const CHAT_SERVER_DRAINING_MESSAGE = "Chat server is restarting, please retry";

let draining = false;
let signalHandlersRegistered = false;

const handleSigterm = (): void => {
  if (draining) {
    return;
  }

  draining = true;
  log({
    domain: "api",
    action: "shutdown_draining",
    signal: "SIGTERM",
  });
};

export const ensureShutdownCoordinatorRegistered = (): void => {
  if (signalHandlersRegistered) {
    return;
  }

  signalHandlersRegistered = true;
  process.once("SIGTERM", handleSigterm);
};

export const isServerDraining = (): boolean => {
  ensureShutdownCoordinatorRegistered();
  return draining;
};

export const setServerDrainingForTests = (value: boolean): void => {
  draining = value;
};

ensureShutdownCoordinatorRegistered();
