import { brainxFetch } from "./brainx-http";

export type ConnectionState = "connected" | "organization_managed" | "action_required" | "unavailable";
export type ConnectionProvider = "feishu" | "openmai" | "supermai" | "reloop";
export type SupermaiPlatform = "boss" | "maimai" | "liepin";

export type ProviderConnection = {
  provider: ConnectionProvider;
  kind: "identity" | "sourcing";
  managed_by: "user" | "organization" | "device";
  state: ConnectionState;
  capabilities: string[];
  needs_user_action: boolean;
  action: { kind: string; target: string | null } | null;
  last_checked_at: string;
  error_code: string | null;
  details?: {
    desktop_available?: boolean;
    desktop_busy?: boolean;
    version?: string | null;
    platforms?: Partial<Record<SupermaiPlatform, { running?: boolean; logged_in?: boolean }>>;
    backend?: string | null;
    schema?: string | null;
  };
};

export type ConnectionsResponse = {
  schema_version: string;
  identity_provider: "feishu";
  items: ProviderConnection[];
};

export function getConnections(signal?: AbortSignal) {
  return brainxFetch<ConnectionsResponse>("/api/v1/connections", { signal });
}

export function startSupermaiLogin(platform: SupermaiPlatform) {
  return brainxFetch<{ ok: true; platform: SupermaiPlatform; user_action: string }>(
    "/api/v1/connections/supermai/start",
    { method: "POST", body: { platform } },
  );
}
