const separator = "\u0000";

const positions = new Map<string, number>();
let pendingRestore:
  | {
      tabId: string;
      href: string;
      top: number;
    }
  | null = null;

function key(tabId: string, href: string): string {
  return `${tabId}${separator}${href}`;
}

export function rememberContentScroll(
  tabId: string | null | undefined,
  href: string,
  top: number,
) {
  if (!tabId) return;
  positions.set(key(tabId, href), top);
}

export function requestContentScrollRestore(
  tabId: string | null | undefined,
  href: string,
) {
  if (!tabId) return;
  pendingRestore = {
    tabId,
    href,
    top: positions.get(key(tabId, href)) ?? 0,
  };
}

export function consumeContentScrollRestore(
  tabId: string | null | undefined,
  href: string,
): number | null {
  if (!tabId || !pendingRestore) return null;
  if (pendingRestore.tabId !== tabId || pendingRestore.href !== href) {
    pendingRestore = null;
    return null;
  }
  const top = pendingRestore.top;
  pendingRestore = null;
  return top;
}
