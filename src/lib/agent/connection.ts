export function isLoopbackAgentUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    const ipv4 = hostname.split(".");
    const isIpv4Loopback =
      ipv4.length === 4 &&
      ipv4[0] === "127" &&
      ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
    return hostname === "localhost" || isIpv4Loopback || hostname === "[::1]";
  } catch {
    return false;
  }
}
