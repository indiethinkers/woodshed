import type { VaultChange } from "@/lib/vault-events";

export interface WoodshedClient {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T | null>;
  log(
    level: "info" | "warn" | "error",
    target: string,
    message: string,
  ): Promise<void>;
  subscribeVaultChanges(callback: (change: VaultChange) => void): () => void;
}
