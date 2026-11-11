/**
 * Thrown by the runtime through the OpenAI loop to end a run whose outcome it
 * has already settled (cancelled, invalidated, or failed by a stream error),
 * so whatever it unwinds must not count it as a failure of its own.
 */
export const CHAT_RUN_LOOP_STOP_SIGNAL = Symbol("chat_run_loop_stop");
