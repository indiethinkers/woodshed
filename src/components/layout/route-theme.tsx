/**
 * RouteTheme used to force selected routes onto a pure white content
 * surface. The Cadence redesign makes the warm paper token the app-wide
 * canvas, so this remains as a no-box compatibility wrapper.
 */
export function RouteTheme({ children }: { children: React.ReactNode }) {
  return <div className="contents">{children}</div>;
}
