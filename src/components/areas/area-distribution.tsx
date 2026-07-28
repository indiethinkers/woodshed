import { useMemo } from "react";
import type { Area } from "@/lib/types";
import type { UnifiedItem } from "@/lib/area-activity";

/**
 * Part-to-whole meter showing where recent activity landed across areas.
 *
 * Design constraints worth keeping in mind before editing:
 *
 * - **Segment colors are user data.** Each area carries its own `color`, chosen
 *   in the app. They cannot be validated for contrast or colorblind separation
 *   at build time, and a user can legitimately pick black (invisible on the dark
 *   surface) or two near-identical blues. Identity therefore never rests on
 *   color: every segment is named with its share in the legend, and the table
 *   below the meter lists every area regardless of what the meter can show.
 * - **Segments are separated by a gap in the surface color, never a border.**
 *   The flex `gap` renders as the page surface showing through.
 * - **The tail folds into "Other".** Past ~6 segments the slivers are unreadable
 *   and adjacent hues blur, so only the largest slices get their own segment.
 * - **Thin mark.** A saturated full-width block reads loud; the meter is 8px.
 */

/** Beyond this, segments are too thin to read and hues start to blur. */
const MAX_SEGMENTS = 6;
const WINDOW_DAYS = 30;

interface Slice {
  key: string;
  label: string;
  color: string | null;
  count: number;
  share: number;
}

interface AreaDistributionProps {
  areas: Area[];
  items: UnifiedItem[];
  today: string;
}

function daysAgo(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export function AreaDistribution({
  areas,
  items,
  today,
}: AreaDistributionProps) {
  const { slices, total, windowed } = useMemo(() => {
    const since = daysAgo(today, WINDOW_DAYS - 1);
    const inWindow = items.filter((item) => {
      const day = item.date?.slice(0, 10);
      return !!day && day >= since && day <= today;
    });

    // Fall back to all-time when the window is empty — a blank meter on a vault
    // that simply had a quiet month would read as broken.
    const windowed = inWindow.length > 0;
    const source = windowed ? inWindow : items.filter((i) => !!i.date);

    const counts = new Map<string, number>();
    for (const item of source) {
      const key = item.area || "";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const total = source.length;
    if (total === 0) return { slices: [] as Slice[], total: 0, windowed };

    const named: Slice[] = [...counts.entries()]
      .map(([id, count]) => {
        const area = areas.find((a) => a.id === id);
        return {
          key: id || "unassigned",
          label: area?.name ?? "Unassigned",
          color: area?.color ?? null,
          count,
          share: count / total,
        };
      })
      .sort((a, b) => b.count - a.count);

    if (named.length <= MAX_SEGMENTS) return { slices: named, total, windowed };

    const head = named.slice(0, MAX_SEGMENTS - 1);
    const tail = named.slice(MAX_SEGMENTS - 1);
    const tailCount = tail.reduce((sum, s) => sum + s.count, 0);
    return {
      slices: [
        ...head,
        {
          key: "__other",
          label: `Other (${tail.length})`,
          color: null,
          count: tailCount,
          share: tailCount / total,
        },
      ],
      total,
      windowed,
    };
  }, [areas, items, today]);

  if (total === 0) return null;

  const percent = (share: number) => Math.round(share * 100);
  const summary = slices
    .map((s) => `${s.label} ${percent(s.share)}%`)
    .join(", ");

  return (
    <section className="mb-8" aria-label="Activity distribution across areas">
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className="font-mono text-[9px] font-medium uppercase tracking-[0.17em] text-muted-foreground/80">
          Where your attention went
        </span>
        <span className="h-px flex-1 bg-border/70" aria-hidden />
        <span className="font-mono text-[9px] uppercase tracking-[0.17em] text-muted-foreground/60">
          {windowed ? `Last ${WINDOW_DAYS} days` : "All time"}
        </span>
      </div>

      {/* gap-[2px] on a surface-colored parent is the separator — never a
          border on the segments themselves. */}
      <div
        role="img"
        aria-label={`Activity by area: ${summary}`}
        className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-content"
      >
        {slices.map((slice) => (
          <div
            key={slice.key}
            title={`${slice.label} — ${slice.count} of ${total} (${percent(slice.share)}%)`}
            style={{
              width: `${slice.share * 100}%`,
              // `null` (Unassigned / Other) has no identity colour of its own,
              // so it takes a recessive neutral rather than borrowing a hue.
              background: slice.color ?? "var(--color-border)",
            }}
            className="min-w-[3px] shrink-0"
          />
        ))}
      </div>

      {/* The legend is what actually carries identity — see the note above about
          user-chosen colors. */}
      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {slices.map((slice) => (
          <li key={slice.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: slice.color ?? "var(--color-border)" }}
            />
            <span className="text-[12px] text-foreground/80">{slice.label}</span>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {percent(slice.share)}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
