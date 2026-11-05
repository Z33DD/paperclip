export const ADAPTER_TYPE = "hermes_gateway";
export const ADAPTER_LABEL = "Hermes Gateway";

// Same as hermes_local: a Hermes agent turn with tool calls often runs past 10 minutes.
export const DEFAULT_TIMEOUT_SEC = 1800;
export const DEFAULT_EVENT_RECONNECT_MS = 2_000;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
export const STOP_GRACE_MS = 10_000;
