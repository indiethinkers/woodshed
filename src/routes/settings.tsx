import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  return (
    <div
      className="relative flex-1 h-full min-h-0 min-w-0 flex flex-col bg-content"
      data-woodshed-content-panel=""
      data-woodshed-surface="settings"
    >
      <Outlet />
    </div>
  );
}
