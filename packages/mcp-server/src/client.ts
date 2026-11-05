import { AsyncLocalStorage } from "node:async_hooks";
import type { PaperclipMcpConfig } from "./config.js";

export class PaperclipApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(input: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    message: string;
  }) {
    super(input.message);
    this.name = "PaperclipApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.body = input.body;
  }
}

export interface JsonRequestOptions {
  body?: unknown;
  includeRunId?: boolean;
}

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function buildErrorMessage(method: string, path: string, status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return `${method} ${path} failed with ${status}: ${body.error}`;
  }
  return `${method} ${path} failed with ${status}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** A run identity scoped to one tool call. Blank values are ignored. */
export interface PaperclipCallContext {
  runId?: string | null;
  /** A run-scoped agent token; it is the call's bearer and fixes the call's run id. */
  token?: string | null;
  agentId?: string | null;
  companyId?: string | null;
}

export class PaperclipApiClient {
  // A long-lived server (one per agent, shared across heartbeats) has no PAPERCLIP_RUN_ID at
  // start; the caller passes the run id, or a whole run identity, per tool call instead, scoped
  // to that call only.
  private readonly callContext = new AsyncLocalStorage<PaperclipCallContext>();

  constructor(private readonly config: PaperclipMcpConfig) {}

  /** Runs `fn` with `runId` as the run id for its requests (falls back to PAPERCLIP_RUN_ID). */
  withRunId<T>(runId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
    const trimmed = runId?.trim();
    return trimmed ? this.withCallContext({ runId: trimmed }, fn) : fn();
  }

  /**
   * Runs `fn` with a call-scoped identity layered over the enclosing one and the server's own.
   * A host-sent run token (see run-meta.ts) is bound to its run, so its run id wins over a run id
   * the model passed: Paperclip rejects a run id header that disagrees with the token.
   */
  withCallContext<T>(context: PaperclipCallContext, fn: () => Promise<T>): Promise<T> {
    const outer = this.callContext.getStore() ?? {};
    const merged: PaperclipCallContext = { ...outer };
    for (const [key, value] of Object.entries(context) as [keyof PaperclipCallContext, string | null | undefined][]) {
      const trimmed = value?.trim();
      if (trimmed && !(key === "runId" && outer.token)) merged[key] = trimmed;
    }
    return this.callContext.run(merged, fn);
  }

  private current(): PaperclipCallContext {
    return this.callContext.getStore() ?? {};
  }

  private currentRunId(): string | null {
    return this.current().runId ?? this.config.runId;
  }

  private currentApiKey(): string {
    const key = this.current().token ?? this.config.apiKey;
    if (!key) {
      throw new Error(
        "No Paperclip credentials for this call: start the server with PAPERCLIP_API_KEY, or have the host send a run token in the tool call's _meta (\"paperclip.ai/run\").",
      );
    }
    return key;
  }

  get defaults() {
    const call = this.current();
    return {
      companyId: call.companyId ?? this.config.companyId,
      agentId: call.agentId ?? this.config.agentId,
      runId: this.currentRunId(),
    };
  }

  resolveCompanyId(companyId?: string | null): string {
    const resolved = companyId?.trim() || this.current().companyId || this.config.companyId;
    if (!resolved) {
      throw new Error("companyId is required because PAPERCLIP_COMPANY_ID is not set");
    }
    return resolved;
  }

  resolveAgentId(agentId?: string | null): string {
    const resolved = agentId?.trim() || this.current().agentId || this.config.agentId;
    if (!resolved) {
      throw new Error("agentId is required because PAPERCLIP_AGENT_ID is not set");
    }
    return resolved;
  }

  async requestJson<T>(method: string, path: string, options: JsonRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`API path must start with "/": ${path}`);
    }

    const url = new URL(path.slice(1), `${this.config.apiUrl}/`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.currentApiKey()}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const runId = this.currentRunId();
    if ((options.includeRunId ?? isWriteMethod(method)) && runId) {
      headers["X-Paperclip-Run-Id"] = runId;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const parsedBody = await parseResponseBody(response);

    if (!response.ok) {
      throw new PaperclipApiError({
        status: response.status,
        method: method.toUpperCase(),
        path,
        body: parsedBody,
        message: buildErrorMessage(method.toUpperCase(), path, response.status, parsedBody),
      });
    }

    return parsedBody as T;
  }
}
