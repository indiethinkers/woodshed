import { Link, useRouterState } from "@tanstack/react-router";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WarningBanner } from "@/components/settings/warning-banner";

const SETTINGS_SECTIONS = [
  { slug: "vault", label: "Vault" },
  { slug: "profile", label: "Profile" },
  { slug: "appearance", label: "Appearance" },
  { slug: "accounts", label: "Integrations" },
  { slug: "agent", label: "Agent" },
] as const;

export function SettingsPage({
  section,
  children,
}: {
  section: string;
  children: React.ReactNode;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeSlug = pathname.split("/")[2] ?? "vault";

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="mx-auto w-full max-w-[960px] px-10 pt-6 pb-12">
        <WarningBanner />
        <header className="mb-8">
          <div className="font-mono text-[12px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Settings
          </div>
          <h1 className="mt-2 text-[32px] font-semibold leading-none tracking-normal text-foreground">
            {section}
          </h1>
          <nav
            aria-label="Settings sections"
            className="mt-6 flex flex-wrap gap-1 border-b border-border pb-2"
          >
            {SETTINGS_SECTIONS.map((s) => {
              const isActive = activeSlug === s.slug;
              return (
                <Link
                  key={s.slug}
                  to={`/settings/${s.slug}` as "/settings/vault"}
                  className={`inline-flex h-8 items-center rounded-md px-3 text-sm transition-colors ${
                    isActive
                      ? "bg-muted-foreground/15 text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                  }`}
                >
                  {s.label}
                </Link>
              );
            })}
          </nav>
        </header>
        <div className="flex flex-col gap-6">{children}</div>
      </div>
    </ScrollArea>
  );
}

export function SettingsGroup({
  label,
  description,
  children,
}: {
  label?: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 pb-6 border-b border-border last:border-b-0">
      {label && (
        <div className="text-[13px] font-medium text-foreground">{label}</div>
      )}
      {description && (
        <p className="text-[15px] leading-[1.45] text-muted-foreground">
          {description}
        </p>
      )}
      {children}
    </div>
  );
}
