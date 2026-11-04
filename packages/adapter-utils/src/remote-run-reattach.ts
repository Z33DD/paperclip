/**
 * The provider run lives on a remote service that kept running after Paperclip
 * lost its handle (server shutdown or crash). A successor observes that same
 * remote run instead of starting new provider work, so no actions replay.
 */
export interface RemoteRunDetachedRecovery {
  kind: "remote_detached";
  externalRunId: string;
  providerWorkStarted: true;
}

/** Context key a reattaching successor run carries for its adapter. */
export const REMOTE_RUN_REATTACH_CONTEXT_KEY = "remoteRunReattach";

export interface RemoteRunReattachContext {
  externalRunId: string;
  sourceRunId: string;
}

export function readRemoteRunReattachContext(context: Record<string, unknown> | null | undefined): RemoteRunReattachContext | null {
  const value = context?.[REMOTE_RUN_REATTACH_CONTEXT_KEY];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const externalRunId = typeof record.externalRunId === "string" ? record.externalRunId.trim() : "";
  const sourceRunId = typeof record.sourceRunId === "string" ? record.sourceRunId.trim() : "";
  return externalRunId && sourceRunId ? { externalRunId, sourceRunId } : null;
}

/** Abort reason name the host uses when it stops for a server shutdown, not an operator Stop. */
export const SERVER_SHUTDOWN_ABORT_NAME = "PaperclipServerShutdown";

export function serverShutdownAbortReason(message: string): Error {
  const error = new Error(message);
  error.name = SERVER_SHUTDOWN_ABORT_NAME;
  return error;
}

export function isServerShutdownAbort(reason: unknown): boolean {
  return reason instanceof Error && reason.name === SERVER_SHUTDOWN_ABORT_NAME;
}
