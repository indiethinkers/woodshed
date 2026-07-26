import { Link } from "@tanstack/react-router";

/**
 * Router-level fallback for an unmatched route. Without it, navigating to a
 * URL that no longer resolves (a renamed/deleted record, a stale back-stack
 * entry) renders a blank body. Renders inside the app shell, so the nav rail
 * stays usable and the user can recover.
 */
export function NotFound() {
  return (
    <div className="flex w-full flex-col items-center justify-center gap-3 px-6 py-24 text-center">
      <p className="text-sm font-medium text-foreground">Page not found</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        This page doesn’t exist — it may have been renamed, moved, or never
        created.
      </p>
      <Link
        to="/"
        className="mt-1 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Go to Cadence
      </Link>
    </div>
  );
}
