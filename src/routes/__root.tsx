import { Outlet, createRootRoute } from "@tanstack/react-router";
import { PromptInputProvider } from "@/components/ai-elements/prompt-input";
import { Providers } from "@/components/layout/providers";
import { AppShell } from "@/components/layout/app-shell";
import { RootErrorBoundary } from "@/components/layout/root-error-boundary";

export const Route = createRootRoute({
  component: RootComponent,
  // TanStack Router's equivalent of app/error.tsx — a render error
  // inside any child renders the route-level boundary instead of
  // bubbling to a white screen. Sidebar stays usable; the user can
  // navigate elsewhere.
  errorComponent: RootErrorBoundary,
});

function RootComponent() {
  return (
    <Providers>
      <PromptInputProvider>
        <AppShell>
          <Outlet />
        </AppShell>
      </PromptInputProvider>
    </Providers>
  );
}
