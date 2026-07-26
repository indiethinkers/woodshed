import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { SquarePen } from "lucide-react";

// Shared anatomy for the middle list-panel sidebars (Notebook, People,
// Resources, Databases, Areas). Mirrors the Cadence TaskSidebar's design
// language — same header band, count pill, row hover treatment — so every
// surface's list panel reads as one family.

export function ListSidebar({
  title,
  count,
  children,
}: {
  /** Omit for surface-level sidebars whose page title already supplies context. */
  title?: string;
  /** Omit to hide the count pill (e.g. record-context sidebars). */
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="pb-5">
      {title && (
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 truncate text-[14px] font-semibold tracking-normal text-foreground">
              {title}
            </h2>
            {count !== undefined && (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-pill border border-border bg-background/35 px-1 text-[11px] font-medium text-muted-foreground">
                {count}
              </span>
            )}
          </div>
        </div>
      )}
      <div className={title ? "px-3 pt-5" : "px-4 py-4"}>{children}</div>
    </section>
  );
}

/** Mini section divider inside a sidebar — mono label, hairline, count. */
export function ListSidebarSection({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="mt-5 first-of-type:mt-0">
      <ListSidebarSectionHeader label={label} count={count} />
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

/** Full-width creation affordance shared with the Agent conversation list. */
export function ListSidebarPrimaryAction({
  label,
  onClick,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      aria-label={label}
      className="mb-5 flex h-8 w-full items-center gap-2.5 rounded-lg px-1.5 text-left text-[14px] font-medium text-foreground/85 outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-foreground/15 disabled:pointer-events-none disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <SquarePen className="size-4 shrink-0" strokeWidth={1.8} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

/** Spaced mono label, hairline, and two-digit count used across sidebars. */
export function ListSidebarSectionHeader({
  label,
  count,
}: {
  label: string;
  count: number;
}) {
  return (
    <div className="mb-3 flex items-center gap-3 px-2">
      <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </h3>
      <div aria-hidden className="h-px flex-1 bg-border" />
      <span className="font-mono text-[11px] font-semibold tabular-nums text-muted-foreground">
        {String(count).padStart(2, "0")}
      </span>
    </div>
  );
}

export function ListSidebarRows({ children }: { children: ReactNode }) {
  return <div className="space-y-0.5">{children}</div>;
}

export function ListSidebarRow({
  href,
  title,
  active = false,
  meta,
  leading,
  trailing,
}: {
  href: string;
  title: string;
  /** Highlight as the currently-open record. */
  active?: boolean;
  /** Secondary mono line under the title (date, source, role…). */
  meta?: string;
  /** Left slot — icon, avatar, color dot. */
  leading?: ReactNode;
  /** Right-aligned mono annotation (counts). */
  trailing?: string;
}) {
  return (
    <Link
      to={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-lg px-2 py-[7px] transition-colors ${
        active
          ? "bg-foreground/[0.05]"
          : "hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06]"
      }`}
    >
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span
          title={title}
          className="line-clamp-2 text-[13.5px] font-medium leading-[1.35] text-foreground"
        >
          {title}
        </span>
        {meta && (
          <span className="mt-[4px] block truncate font-mono text-[11px] leading-none text-muted-foreground/75">
            {meta}
          </span>
        )}
      </span>
      {trailing && (
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/75">
          {trailing}
        </span>
      )}
    </Link>
  );
}

export function ListSidebarEmpty({ children }: { children: ReactNode }) {
  return <p className="px-1 py-6 text-sm text-muted-foreground">{children}</p>;
}
