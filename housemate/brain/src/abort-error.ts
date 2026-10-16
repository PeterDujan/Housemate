/** Abort errors shared by the model backends and their callers. */

export function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** The signal's own reason message, or "Model call aborted". */
export function abortErrorFromSignal(signal: AbortSignal): Error {
  const reason = signal.reason;
  return abortError(reason instanceof Error && reason.message.trim() ? reason.message : "Model call aborted");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
