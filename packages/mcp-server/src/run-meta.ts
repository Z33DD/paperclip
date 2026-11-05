import type { PaperclipCallContext } from "./client.js";

/**
 * Hosts that keep one long-lived MCP server for many runs (a Hermes gateway profile) send the
 * calling run's identity in the tool call's request metadata, outside the model's arguments:
 *
 *   params._meta["paperclip.ai/run"] = { token, runId, agentId, companyId }
 *
 * `token` is the run-scoped agent JWT Paperclip minted for that run. It never reaches the model or
 * the transcript, and it replaces both PAPERCLIP_API_KEY and the per-call `paperclipRunId` argument.
 */
export const RUN_META_KEY = "paperclip.ai/run";

const FIELDS = ["token", "runId", "agentId", "companyId"] as const;

export function readRunMeta(meta: unknown): PaperclipCallContext | null {
  if (!meta || typeof meta !== "object") return null;
  const run = (meta as Record<string, unknown>)[RUN_META_KEY];
  if (!run || typeof run !== "object" || Array.isArray(run)) return null;
  const context: PaperclipCallContext = {};
  for (const field of FIELDS) {
    const value = (run as Record<string, unknown>)[field];
    if (typeof value === "string" && value.trim()) context[field] = value.trim();
  }
  return Object.keys(context).length > 0 ? context : null;
}
