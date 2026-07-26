export function handleListIndentShortcut(event: KeyboardEvent): boolean {
  if (event.key !== "Tab") return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;

  event.preventDefault();
  return true;
}
