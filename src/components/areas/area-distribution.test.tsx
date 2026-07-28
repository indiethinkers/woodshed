import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AreaDistribution } from "./area-distribution";
import type { UnifiedItem } from "@/lib/area-activity";
import type { Area } from "@/lib/types";

const TODAY = "2026-07-27";

function area(id: string, name: string, color: string): Area {
  return { id, name, color };
}

function items(spec: Array<[string, string, number]>): UnifiedItem[] {
  // [areaId, isoDay, count]
  return spec.flatMap(([areaId, day, count]) =>
    Array.from({ length: count }, (_, i) => ({
      id: `${areaId}-${day}-${i}`,
      type: "task" as const,
      title: "t",
      subtitle: "",
      area: areaId,
      date: `${day}T09:00:00`,
      href: "/",
      filePath: "tasks/x.md",
    })),
  );
}

describe("AreaDistribution", () => {
  it("renders nothing when there is no dated activity at all", () => {
    const { container } = render(
      <AreaDistribution areas={[area("a", "Alpha", "#3987e5")]} items={[]} today={TODAY} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows each area's share of the last 30 days", () => {
    render(
      <AreaDistribution
        areas={[area("a", "Alpha", "#3987e5"), area("b", "Beta", "#d95926")]}
        items={items([
          ["a", "2026-07-20", 3],
          ["b", "2026-07-20", 1],
        ])}
        today={TODAY}
      />,
    );
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText(/Last 30 days/i)).toBeInTheDocument();
  });

  it("excludes activity older than the window", () => {
    render(
      <AreaDistribution
        areas={[area("a", "Alpha", "#3987e5"), area("b", "Beta", "#d95926")]}
        items={items([
          ["a", "2026-07-20", 1],
          ["b", "2026-01-01", 9],
        ])}
        today={TODAY}
      />,
    );
    // Beta's 9 records are outside the window, so Alpha owns the whole meter.
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });

  it("falls back to all-time when nothing happened in the window", () => {
    // A quiet month must not render as a broken/empty meter.
    render(
      <AreaDistribution
        areas={[area("a", "Alpha", "#3987e5")]}
        items={items([["a", "2026-01-01", 4]])}
        today={TODAY}
      />,
    );
    expect(screen.getByText(/All time/i)).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
  });

  it("folds the tail into Other past six segments", () => {
    // Slivers below a few percent are unreadable and adjacent hues blur, so
    // only the largest slices keep their own segment.
    const areas = Array.from({ length: 9 }, (_, i) =>
      area(`a${i}`, `Area ${i}`, "#3987e5"),
    );
    render(
      <AreaDistribution
        areas={areas}
        items={items(
          areas.map((a, i) => [a.id, "2026-07-20", 10 - i] as [string, string, number]),
        )}
        today={TODAY}
      />,
    );
    expect(screen.getByText("Other (4)")).toBeInTheDocument();
    // Five named + one Other.
    expect(screen.getByText("Area 0")).toBeInTheDocument();
    expect(screen.queryByText("Area 8")).not.toBeInTheDocument();
  });

  it("labels every segment so identity never rests on colour alone", () => {
    // Area colours are user-chosen and cannot be validated for contrast or CVD
    // separation at build time — a user can pick black on a dark surface. The
    // legend is the required relief.
    render(
      <AreaDistribution
        areas={[area("a", "Invisible", "#000000"), area("b", "Beta", "#d95926")]}
        items={items([
          ["a", "2026-07-20", 1],
          ["b", "2026-07-20", 1],
        ])}
        today={TODAY}
      />,
    );
    expect(screen.getByText("Invisible")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Invisible 50%/ }),
    ).toBeInTheDocument();
  });

  it("uses foreground contrast for the section label in light mode", () => {
    render(
      <AreaDistribution
        areas={[area("a", "Alpha", "#3987e5")]}
        items={items([["a", "2026-07-20", 1]])}
        today={TODAY}
      />,
    );

    expect(screen.getByText(/Where your attention went/i)).toHaveClass(
      "text-foreground",
    );
  });

  it("keeps the time-window label readable in light mode", () => {
    render(
      <AreaDistribution
        areas={[area("a", "Alpha", "#3987e5")]}
        items={items([["a", "2026-07-20", 1]])}
        today={TODAY}
      />,
    );

    const label = screen.getByText(/Last 30 days/i);
    expect(label).toHaveClass("text-[10px]", "text-muted-foreground");
    expect(label).not.toHaveClass("text-muted-foreground/60");
  });
});
