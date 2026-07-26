import { useWikilinkTargets } from "./use-wikilink-targets";

/**
 * Mounts at the React tree root (in `Providers`) to keep the wikilink
 * resolver cache warm. Renders nothing — it exists only for its hook
 * subscription side-effect.
 *
 * Lives in its own .tsx file (separate from the use-wikilink-targets
 * hook module) so React Fast Refresh can patch it in place during dev.
 * Modules that mix component and non-component exports fall back to a
 * full reload on every save.
 */
export function WikilinkTargetsBridge() {
  useWikilinkTargets();
  return null;
}
