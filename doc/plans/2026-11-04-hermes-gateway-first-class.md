# Hermes Gateway as a first-class adapter

Date: 2026-11-04. Branch: `feat/hermes-gateway-first-class` (fork Z33DD/paperclip).

## Why

A company that runs every agent through `hermes_gateway` (Hermes API server, `/v1/runs` +
SSE) hits the same walls on day one:

1. **The issue page shows nothing useful while an agent works.** Tool calls and results
   arrive as `tool.started` / `tool.completed` events, which the transcript parser
   rendered as anonymous `Hermes event: tool.started` system lines. A run with 70 tool
   calls looks frozen. Releases up to 2026.1023.0 also wrote each delta without a newline,
   which glued the next event line onto it, so the page showed only the first word of
   the reply (upstream fixed that one in #15201).
2. **Hard to set up from the UI.** The onboarding wizard only offers `claude_local` / `codex_local`,
   and a gateway agent made from **New agent** timed out after 10 minutes.
3. **A Paperclip restart kills live runs.** The run keeps going on the Hermes side, but
   Paperclip marks it `process_lost` because only Paperclip Runner runs can reattach. Then
   recovery re-wakes the agent and starts a duplicate.
4. **Agents can't write to Paperclip without extra wiring.** Writes need the run id. The
   stock MCP server reads it once at startup, which is wrong for a long-lived gateway
   (see paperclipai/paperclip#16636), so operators patch it per call.

## Phase 1: transcript (done)

- `gateway/server/execute.ts`: Hermes tool events have no call id, so the adapter pairs
  `tool.started` with the next `tool.completed`/`tool.failed` of the same tool (FIFO, which
  matches Hermes' sequential executor) and stamps both with `paperclip_tool_use_id`. If
  Hermes ever sends `tool_call_id`, that id wins.
- `gateway/ui/parse-stdout.ts`:
  - `tool.started` → `tool_call` (preview as input)
  - `tool.completed` / `tool.failed` → `tool_result` (preview, error flag)
  - `message.interim` dropped when `already_streamed`
  - `run.completed` → one line with model and token usage
  - `subagent.start` / `subagent.complete` → readable lines
  - Logs written before pairing still render, with one id per event.
- A run Hermes stops before finishing comes back `failed` with only `turn_exit_reason`, no `error`.
  `max_iterations_reached(n/m)` now maps to `hermes_gateway_iteration_limit` with a message that the work
  may be done (the reply is Hermes' forced summary); any other reason is named, instead of the reply
  being shown as the error.

## Phase 2: create and configure in the UI (done, smaller than planned)

Upstream had already done most of it (#13011): **New agent** offers a Hermes Gateway card, asks for the API
base URL and the API key (saved as an organization secret), and runs the adapter's environment test before
creating the agent. The agent page edits every gateway field. What was left:

- The gateway's default timeout was 600 s, so an agent created from the UI cut off ordinary Hermes turns
  (a 31-lead batch took 16.5 minutes). It is now 1800 s, the same as `hermes_local`.
- `KNOWN_DEFAULTS` entries for both Hermes adapters, matching the server's capabilities.
- The URL field explains `/p/<profile>` for one gateway that serves several Hermes profiles.

Not done: a Hermes source in the first-run onboarding wizard. Upstream deliberately limited that wizard to
Claude and Codex (#18309); a Hermes company adds its agents from **New agent** after onboarding.

## Phase 3: survive Paperclip restarts (done)

Before this change, a restart either waited on a gateway run that ignored the abort
signal, or reaped the run as `process_lost` with no evidence. Recovery then put a board
hold on the issue (`legacy_execution_requires_reconciliation`), while Hermes finished
the work unseen.

- **Contract** (`adapter-utils/remote-run-reattach.ts`):
  - `onExternalRun` lets a remote adapter report its provider run id.
  - `supportsRemoteRunReattach` marks an adapter whose `execute()` can follow
    `context.remoteRunReattach` instead of starting work.
  - `executionRecovery.kind = "remote_detached"` is the evidence recovery records.
  - `serverShutdownAbortReason` tells a shutdown apart from an operator Stop.
- **Hermes gateway adapter:**
  - Reports the Hermes run id right after `POST /v1/runs`; the host persists it as
    `heartbeat_runs.external_run_id`.
  - Now honours the run signal:
    - **Operator Stop:** `POST /stop`. It claims `interrupted`/`providerStopped` only
      when Hermes confirms a terminal status.
    - **Server shutdown:** leaves the Hermes run going and returns `remote_detached`.
  - **Reattach:** with `context.remoteRunReattach`, it skips the create, checks
    `GET /v1/runs/{id}` (404 → `hermes_gateway_reattach_not_found`), then consumes the
    event backlog.
  - Event streams resume with `Last-Event-ID`, and replayed `seq`s are dropped, so a
    reconnect no longer duplicates output.
- **Recovery:** both the graceful-shutdown path and the orphan sweep record `remote_detached`
  when the adapter supports reattach and the run has an external id.
  - `legacyExecutionNeedsReconciliation` exempts that evidence, still inside the
    two-attempt bound.
  - The process-loss retry is scheduled at once (`delayMs: 0`), because Hermes keeps
    the stream backlog for about 5 minutes and the final status for 1 hour.
  - `scheduleBoundedRetryForRun` puts `remoteRunReattach` on the successor and strips it
    from any other successor.
  - A run with no recorded external id is held as before.

## Phase 4: Paperclip tools without operator wiring (in progress)

Today a Hermes company needs three things per agent before its agents can write to the board: a
long-lived Paperclip API key in the agent's environment, the Paperclip MCP server patched to take the run
id per call (#16636 is the upstream version), and an instruction telling the model to copy the Run ID
from its wake prompt into every write. Paperclip already mints a per-run agent JWT for local adapters,
and that token carries `run_id` itself; the gap is getting it to the Paperclip tools of a Hermes gateway,
whose MCP servers are long-lived, per profile, with a fixed environment.

The channel is MCP's own request metadata: `tools/call` takes `_meta`, which reaches the server's tool
handler and never goes through the model or the transcript.

- **Paperclip server:** `supportsRunAuthToken` on a server adapter mints the run JWT for that adapter,
  as `supportsLocalAgentJwt` does for local ones, without the local-only meaning the UI gives that flag.
  `hermes_gateway` sets it.
- **Gateway adapter:** with a run token, `POST /v1/runs` carries
  `mcp_meta: { "<server>": { "paperclip.ai/run": { token, runId, agentId, companyId } } }`. The server
  name is `paperclipMcpServer` in the adapter config (default `paperclip`; `false` turns it off).
- **Paperclip MCP server:** a tool call whose `_meta` has `paperclip.ai/run` uses that token as its bearer,
  that run id, and that agent/company as defaults, for that call only (AsyncLocalStorage, like the per-call
  run id). Started without `PAPERCLIP_API_KEY`, it serves calls that bring their own credentials and
  refuses the rest with a clear error.
- **Hermes** (patch, to be offered upstream): `POST /v1/runs` accepts `mcp_meta`, keeps it in memory for
  that run only (never persisted or logged), and sends each server's entry as `meta` on that run's
  `tools/call` requests to that server.

With all four, an operator configures the Paperclip MCP server once per Hermes install (command +
`PAPERCLIP_API_URL`); agents need no key, and the model never handles a run id or a credential.

## Out of scope

- Cost in USD: Hermes reports tokens, not money. Paperclip keeps token usage. Pricing stays
  with the provider routing.
