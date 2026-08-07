import { isTauriRuntime } from "@/lib/runtime";

let cachedSupportsViewTransition: boolean | null = null;

/** Whether TanStack Router should drive crossfade view transitions. */
export function supportsViewTransition(): boolean {
  if (cachedSupportsViewTransition !== null) {
    return cachedSupportsViewTransition;
  }
  if (typeof document === "undefined") {
    cachedSupportsViewTransition = false;
    return false;
  }
  if (typeof document.startViewTransition !== "function") {
    cachedSupportsViewTransition = false;
    return false;
  }
  // WebKitGTK on Linux segfaults inside libwebkit2gtk when the router
  // commits a navigation under an active View Transition (null deref at
  // startup offset during sidebar / command-palette route changes). macOS
  // WKWebView handles the same path correctly — keep the crossfade there.
  if (isTauriRuntime() && /Linux/i.test(navigator.userAgent)) {
    cachedSupportsViewTransition = false;
    return false;
  }
  cachedSupportsViewTransition = true;
  return true;
}
