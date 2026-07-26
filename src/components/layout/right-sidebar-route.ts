export function isSameReferencePage(a: string, b: string): boolean {
  const left = comparableReferenceHref(a);
  const right = comparableReferenceHref(b);
  return left.length > 0 && left === right;
}

export function comparableReferenceHref(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  try {
    const base =
      typeof window === "undefined" ? "http://woodshed.local" : window.location.origin;
    const url = new URL(trimmed, base);
    return `${normalizePathname(url.pathname)}${url.search}`;
  } catch {
    const [withoutHash] = trimmed.split("#");
    const queryIndex = withoutHash.indexOf("?");
    const pathname =
      queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
    const search = queryIndex === -1 ? "" : withoutHash.slice(queryIndex);
    return `${normalizePathname(pathname)}${search}`;
  }
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}
