import { describe, expect, it } from "vitest";
import {
  applyRemoteRunReattachContext,
  readRemoteRunDetachedEvidence,
  remoteRunDetachedEvidence,
} from "./remote-run-reattach.js";

describe("remoteRunDetachedEvidence", () => {
  it("names the remote run for an adapter that can reattach to it", () => {
    expect(remoteRunDetachedEvidence("hermes_gateway", { runtimeMode: "legacy", externalRunId: "run_1" }))
      .toEqual({ kind: "remote_detached", externalRunId: "run_1", providerWorkStarted: true });
  });

  it("gives no evidence without a recorded run, for native runs, or for adapters that cannot reattach", () => {
    expect(remoteRunDetachedEvidence("hermes_gateway", { runtimeMode: "legacy", externalRunId: null })).toBeNull();
    expect(remoteRunDetachedEvidence("hermes_gateway", { runtimeMode: "native", externalRunId: "run_1" })).toBeNull();
    expect(remoteRunDetachedEvidence("hermes_local", { runtimeMode: "legacy", externalRunId: "run_1" })).toBeNull();
    expect(remoteRunDetachedEvidence("openclaw_gateway", { runtimeMode: "legacy", externalRunId: "run_1" })).toBeNull();
  });
});

describe("applyRemoteRunReattachContext", () => {
  it("points the successor at the detached remote run", () => {
    const context: Record<string, unknown> = { issueId: "issue-1" };
    applyRemoteRunReattachContext(context, {
      id: "pc-run-1",
      resultJson: { executionRecovery: { kind: "remote_detached", externalRunId: "run_1", providerWorkStarted: true } },
    });
    expect(context.remoteRunReattach).toEqual({ externalRunId: "run_1", sourceRunId: "pc-run-1" });
  });

  it("never lets a successor of another failure inherit an earlier reattach target", () => {
    const context: Record<string, unknown> = { remoteRunReattach: { externalRunId: "run_old", sourceRunId: "pc-run-0" } };
    applyRemoteRunReattachContext(context, { id: "pc-run-1", resultJson: { errorCode: "hermes_gateway_run_failed" } });
    expect(context).not.toHaveProperty("remoteRunReattach");
  });

  it("reads only complete detached evidence", () => {
    expect(readRemoteRunDetachedEvidence({ executionRecovery: { kind: "bootstrap", providerWorkStarted: false } })).toBeNull();
    expect(readRemoteRunDetachedEvidence({ executionRecovery: { kind: "remote_detached", externalRunId: "run_1" } })).toBeNull();
    expect(readRemoteRunDetachedEvidence(null)).toBeNull();
  });
});
