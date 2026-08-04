export type AgentCredentialSource =
  | "environment"
  | "hermes"
  | "stored"
  | "missing";

export interface ManagedHermesProfile {
  available: boolean;
  model: string;
  name: string;
  port: number;
}

export interface AgentConfig {
  baseUrl: string;
  credentialSource: AgentCredentialSource;
  displayName: string;
  hasApiKey: boolean;
  managedProfile: ManagedHermesProfile | null;
  model: string;
  sessionKey: string;
}

export function canUseAgentConfig(config: AgentConfig | null): boolean {
  return Boolean(
    config?.hasApiKey &&
      (config.managedProfile === null || config.managedProfile.available),
  );
}
