/**
 * Listening port for the container entry points.
 *
 * The port is required and explicit: a container that is started without PORT
 * fails immediately instead of listening on a surprising default.
 */

const MAX_PORT = 65_535;

export const readRequiredPort = (environment: NodeJS.ProcessEnv): number => {
  const value = environment.PORT;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Container entry points require a non-empty PORT environment variable");
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new Error(`PORT must be an integer between 1 and ${String(MAX_PORT)}, received "${value}"`);
  }

  return port;
};
