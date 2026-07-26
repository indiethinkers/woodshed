export function isAgentPanelToggleShortcut(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.altKey || event.shiftKey) return false;
  return event.code === "KeyB" || event.key.toLowerCase() === "b";
}
