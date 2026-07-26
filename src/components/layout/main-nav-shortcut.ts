const DIGIT_CODE_RE = /^Digit([1-8])$/;

export function mainNavShortcutIndex(event: KeyboardEvent): number | null {
  if (!(event.metaKey || event.ctrlKey)) return null;
  if (event.altKey || event.shiftKey) return null;

  const codeMatch = event.code.match(DIGIT_CODE_RE);
  if (codeMatch) return Number(codeMatch[1]) - 1;

  if (/^[1-8]$/.test(event.key)) return Number(event.key) - 1;

  return null;
}
