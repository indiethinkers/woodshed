import { isTauriRuntime } from "@/lib/runtime";
import { tauriTransport } from "./tauri-transport";
import type { WoodshedClient } from "./types";

const browserTransport: WoodshedClient = {
  async invoke() {
    return null;
  },
  async log() {
    return;
  },
  subscribeVaultChanges() {
    return () => {};
  },
};

export function woodshedClient(): WoodshedClient {
  return isTauriRuntime() ? tauriTransport : browserTransport;
}

export type { WoodshedClient };
