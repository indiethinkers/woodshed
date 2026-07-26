export function canShowAgentPanel(pathname: string): boolean {
  return !pathname.startsWith("/agent") && !pathname.startsWith("/welcome");
}

/** The contextual Bot panel temporarily owns the app's left chrome. The full
 * Agent route is a normal surface and keeps the global navigation rail. */
export function isAgentFocusMode(
  pathname: string,
  agentPanelOpen: boolean,
): boolean {
  return agentPanelOpen && canShowAgentPanel(pathname);
}
