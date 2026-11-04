import type { heartbeatRuns } from "@paperclipai/db";
import {
  REMOTE_RUN_REATTACH_CONTEXT_KEY,
  type RemoteRunDetachedRecovery,
  type RemoteRunReattachContext,
} from "@paperclipai/adapter-utils";
import { findServerAdapter } from "../../adapters/index.js";

type Run = typeof heartbeatRuns.$inferSelect;

/**
 * A legacy run whose provider work lives on a remote service (for example a
 * Hermes gateway run) keeps going when this server stops. If its adapter can
 * follow that run again and the run recorded the remote id, losing the server
 * is not lost work: return the evidence recovery records instead of treating
 * the outcome as unknown.
 */
export function remoteRunDetachedEvidence(
  adapterType: string,
  run: Pick<Run, "runtimeMode" | "externalRunId">,
): RemoteRunDetachedRecovery | null {
  const externalRunId = run.externalRunId?.trim();
  if (run.runtimeMode !== "legacy" || !externalRunId) return null;
  if (findServerAdapter(adapterType)?.supportsRemoteRunReattach !== true) return null;
  return { kind: "remote_detached", externalRunId, providerWorkStarted: true };
}

export function readRemoteRunDetachedEvidence(resultJson: unknown): RemoteRunDetachedRecovery | null {
  if (typeof resultJson !== "object" || resultJson === null) return null;
  const evidence = (resultJson as Record<string, unknown>).executionRecovery;
  if (typeof evidence !== "object" || evidence === null) return null;
  const record = evidence as Record<string, unknown>;
  if (record.kind !== "remote_detached" || record.providerWorkStarted !== true) return null;
  const externalRunId = typeof record.externalRunId === "string" ? record.externalRunId.trim() : "";
  return externalRunId ? { kind: "remote_detached", externalRunId, providerWorkStarted: true } : null;
}

/**
 * Context for the successor of a detached run: it observes the same remote
 * run rather than starting provider work. Any other successor must not inherit
 * a reattach target from an earlier attempt.
 */
export function applyRemoteRunReattachContext(
  retryContext: Record<string, unknown>,
  source: Pick<Run, "id" | "resultJson">,
): void {
  delete retryContext[REMOTE_RUN_REATTACH_CONTEXT_KEY];
  const evidence = readRemoteRunDetachedEvidence(source.resultJson);
  if (!evidence) return;
  const reattach: RemoteRunReattachContext = { externalRunId: evidence.externalRunId, sourceRunId: source.id };
  retryContext[REMOTE_RUN_REATTACH_CONTEXT_KEY] = reattach;
}
