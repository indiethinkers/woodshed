"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useGraph } from "@/lib/hooks/use-graph";
import { cn } from "@/lib/utils";

// Fixed world space for the simulation. The SVG scales to its container;
// pan/zoom happens in the transform group, so node coordinates never need
// to know the actual viewport size.
const VIEW_W = 1600;
const VIEW_H = 1000;

interface GraphNodeDatum extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: string;
  href?: string | null;
  area?: string | null;
  degree: number;
}

interface GraphEdgeDatum extends SimulationLinkDatum<GraphNodeDatum> {
  source: string | GraphNodeDatum;
  target: string | GraphNodeDatum;
}

// Literal Tailwind classes — Tailwind's scanner needs the full class names
// in source, so each kind maps to a concrete `fill-*` token.
const KIND_FILL: Record<string, string> = {
  note: "fill-sky-400",
  daily: "fill-cyan-400",
  person: "fill-violet-400",
  event: "fill-amber-400",
  task: "fill-emerald-400",
  resource: "fill-rose-400",
  area: "fill-fuchsia-400",
  agent_chat: "fill-indigo-400",
  mail: "fill-lime-400",
  table: "fill-teal-400",
  row: "fill-slate-400",
  unresolved: "fill-zinc-400",
};

const KIND_LABEL: Record<string, string> = {
  note: "Note",
  daily: "Journal",
  person: "Person",
  event: "Event",
  task: "Task",
  resource: "Resource",
  area: "Area",
  agent_chat: "Agent chat",
  mail: "Mail",
  table: "Table",
  row: "Row",
  unresolved: "Unresolved link",
};

const KIND_ORDER = [
  "note",
  "daily",
  "person",
  "event",
  "task",
  "resource",
  "area",
  "agent_chat",
  "mail",
  "table",
  "row",
  "unresolved",
];

function nodeRadius(d: GraphNodeDatum): number {
  if (d.kind === "unresolved") return 4;
  return 4 + Math.min(10, Math.sqrt(d.degree) * 1.7);
}

export function GraphView() {
  const { data, isLoading } = useGraph();
  const navigate = useNavigate();
  // Tick counter: the simulation mutates node x/y in place; bumping this
  // state on every tick is what makes the SVG re-render with new positions.
  const [, setFrame] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  // null = all record types shown; a kind string isolates the graph to that
  // type (single-select — clicking the active chip returns to All).
  const [activeKind, setActiveKind] = useState<string | null>(null);
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simRef = useRef<Simulation<GraphNodeDatum, GraphEdgeDatum> | null>(null);
  // Suppress the click-to-navigate that would otherwise fire after a drag.
  const draggedRef = useRef(false);

  // ── Derive datums + adjacency from the snapshot ────────────────────────
  const { nodes, edges, adjacency } = useMemo(() => {
    if (!data) return { nodes: [], edges: [], adjacency: new Map<string, Set<string>>() };

    // The filter isolates the graph to one record type (null = all). Hidden
    // kinds are dropped before layout so the simulation only ever sees the
    // visible subset (which also re-layouts automatically on change).
    const kindById = new Map(data.nodes.map((n) => [n.id, n.kind]));
    const isHidden = (id: string) =>
      activeKind !== null && kindById.get(id) !== activeKind;
    const visible =
      activeKind === null
        ? data.nodes
        : data.nodes.filter((n) => n.kind === activeKind);

    const degree = new Map<string, number>();
    for (const e of data.edges) {
      if (isHidden(e.source) || isHidden(e.target)) continue;
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const byId = new Set(visible.map((n) => n.id));

    const nodeDatums: GraphNodeDatum[] = visible.map((n) => ({
      id: n.id,
      label: n.label,
      kind: n.kind,
      href: n.href,
      area: n.area,
      degree: degree.get(n.id) ?? 0,
    }));

    const edgeDatums: GraphEdgeDatum[] = data.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));

    const adj = new Map<string, Set<string>>();
    for (const e of data.edges) {
      if (!byId.has(e.source) || !byId.has(e.target)) continue;
      let s = adj.get(e.source);
      if (!s) adj.set(e.source, (s = new Set()));
      s.add(e.target);
      let t = adj.get(e.target);
      if (!t) adj.set(e.target, (t = new Set()));
      t.add(e.source);
    }

    return { nodes: nodeDatums, edges: edgeDatums, adjacency: adj };
  }, [data, activeKind]);

  // ── Simulation ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (nodes.length === 0) return;
    const sim = forceSimulation<GraphNodeDatum>(nodes)
      .force(
        "link",
        forceLink<GraphNodeDatum, GraphEdgeDatum>(edges)
          .id((d) => d.id)
          .distance((d) => {
            const source = d.source as GraphNodeDatum;
            const target = d.target as GraphNodeDatum;
            return 56 + (source.degree + target.degree) * 3;
          })
          .strength(0.55),
      )
      .force("charge", forceManyBody().strength(-220))
      .force("center", forceCenter(VIEW_W / 2, VIEW_H / 2))
      .force("collide", forceCollide<GraphNodeDatum>().radius((d) => nodeRadius(d) + 3).strength(0.85))
      .force("x", forceX(VIEW_W / 2).strength(0.04))
      .force("y", forceY(VIEW_H / 2).strength(0.04))
      .on("tick", () => setFrame((f) => f + 1));
    simRef.current = sim;
    return () => {
      sim.stop();
      simRef.current = null;
    };
  }, [nodes, edges]);

  // ── Wheel zoom (native non-passive listener so preventDefault works) ──
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setTransform((t) => {
        const k = Math.min(4, Math.max(0.2, t.k * Math.exp(-e.deltaY * 0.0015)));
        const x = px - ((px - t.x) / t.k) * k;
        const y = py - ((py - t.y) / t.k) * k;
        return { k, x, y };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ── Node dragging (pins the node via fx/fy) ────────────────────────────
  const onNodePointerDown = useCallback(
    (e: React.PointerEvent, node: GraphNodeDatum) => {
      e.stopPropagation();
      draggedRef.current = false;
      const sim = simRef.current;
      if (!sim) return;
      node.fx = node.x ?? VIEW_W / 2;
      node.fy = node.y ?? VIEW_H / 2;
      sim.alphaTarget(0.3).restart();
      const svg = svgRef.current!;
      const rect = svg.getBoundingClientRect();
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - (e.clientX ?? 0);
        const dy = ev.clientY - (e.clientY ?? 0);
        if (Math.hypot(dx, dy) > 4) draggedRef.current = true;
        node.fx = (ev.clientX - rect.left - transform.x) / transform.k;
        node.fy = (ev.clientY - rect.top - transform.y) / transform.k;
      };
      const onUp = () => {
        node.fx = undefined;
        node.fy = undefined;
        sim.alphaTarget(0);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [transform],
  );

  // ── Background pan ─────────────────────────────────────────────────────
  const onBackgroundPointerDown = useCallback((e: React.PointerEvent) => {
    draggedRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;
    const t0 = transform;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.hypot(dx, dy) > 4) draggedRef.current = true;
      setTransform({ k: t0.k, x: t0.x + dx, y: t0.y + dy });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [transform]);

  const resetView = useCallback(() => {
    setTransform({ k: 1, x: 0, y: 0 });
    simRef.current?.alpha(1).restart();
  }, []);

  const selectKind = useCallback((kind: string | null) => {
    setActiveKind((prev) => (prev === kind ? null : kind));
  }, []);

  // ── Hover highlighting ─────────────────────────────────────────────────
  const dimmed = useCallback(
    (id: string) => {
      if (!hovered) return false;
      if (id === hovered) return false;
      return !adjacency.get(hovered)?.has(id);
    },
    [hovered, adjacency],
  );

  const edgeHighlighted = useCallback(
    (e: GraphEdgeDatum) => {
      if (!hovered) return false;
      const s = typeof e.source === "string" ? e.source : e.source.id;
      const t = typeof e.target === "string" ? e.target : e.target.id;
      return s === hovered || t === hovered;
    },
    [hovered],
  );

  const hoveredNode = hovered ? nodes.find((n) => n.id === hovered) : undefined;
  const kindsPresent = useMemo(() => {
    const present = new Set(data?.nodes.map((n) => n.kind) ?? []);
    return KIND_ORDER.filter((k) => present.has(k));
  }, [data]);
  const unresolvedCount = data?.nodes.filter((n) => n.kind === "unresolved").length ?? 0;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Indexing vault…
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No records yet — the graph fills as you add notes and [[links]].
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden" data-testid="graph-view">
      <svg
        ref={svgRef}
        className="h-full w-full cursor-grab touch-none select-none active:cursor-grabbing"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Vault wikilink graph"
        onPointerDown={onBackgroundPointerDown}
        onDoubleClick={resetView}
      >
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          {/* Edges */}
          {edges.map((e, i) => {
            if (typeof e.source === "string" || typeof e.target === "string") return null;
            const isGhost =
              e.source.kind === "unresolved" || e.target.kind === "unresolved";
            const highlighted = edgeHighlighted(e);
            return (
              <line
                key={i}
                x1={e.source.x ?? VIEW_W / 2}
                y1={e.source.y ?? VIEW_H / 2}
                x2={e.target.x ?? VIEW_W / 2}
                y2={e.target.y ?? VIEW_H / 2}
                className={cn(
                  "stroke-border transition-opacity",
                  highlighted ? "opacity-100" : dimmed(e.source.id) || dimmed(e.target.id) ? "opacity-[0.06]" : "opacity-40",
                )}
                strokeWidth={isGhost ? 1 : 1.2}
                strokeDasharray={isGhost ? "3 3" : undefined}
              />
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const isGhost = node.kind === "unresolved";
            const radius = nodeRadius(node);
            const showLabel = hovered === node.id || isGhost;
            const isDimmed = dimmed(node.id);
            return (
              <g
                key={node.id}
                data-node-id={node.id}
                transform={`translate(${node.x ?? VIEW_W / 2} ${node.y ?? VIEW_H / 2})`}
                className={cn(
                  "cursor-pointer transition-opacity",
                  isDimmed && "opacity-20",
                )}
                onPointerEnter={() => setHovered(node.id)}
                onPointerLeave={() => setHovered((h) => (h === node.id ? null : h))}
                onPointerDown={(e) => onNodePointerDown(e, node)}
                onClick={() => {
                  if (draggedRef.current) return;
                  if (node.href) {
                    void navigate({ to: node.href });
                  }
                }}
              >
                {showLabel && (
                  <text
                    y={-radius - 6}
                    textAnchor="middle"
                    className="pointer-events-none fill-foreground font-medium"
                    style={{ fontSize: isGhost ? 11 : 12 }}
                  >
                    {node.label}
                  </text>
                )}
                <circle
                  r={radius}
                  className={cn(
                    isGhost
                      ? "fill-zinc-400/25 stroke-zinc-400/70"
                      : KIND_FILL[node.kind] ?? "fill-muted-foreground",
                  )}
                  strokeWidth={hovered === node.id ? 2 : 1.25}
                  stroke={hovered === node.id ? "currentColor" : undefined}
                />
                {node.href && (
                  <title>{`${node.label} — ${KIND_LABEL[node.kind] ?? node.kind} (open)`}</title>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Hovered-node card */}
      {hoveredNode && (
        <div className="pointer-events-none absolute left-4 top-4 max-w-72 rounded-lg border border-border bg-background/95 p-3 shadow-sm backdrop-blur">
          <p className="truncate text-[13px] font-semibold text-foreground">
            {hoveredNode.label}
          </p>
          <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            {KIND_LABEL[hoveredNode.kind] ?? hoveredNode.kind}
            {hoveredNode.area ? ` · ${hoveredNode.area}` : ""} ·{" "}
            {adjacency.get(hoveredNode.id)?.size ?? 0} links
          </p>
          {hoveredNode.href && (
            <Link
              to={hoveredNode.href}
              className="pointer-events-auto mt-1.5 inline-flex text-[12px] font-medium text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
            >
              Open record
            </Link>
          )}
        </div>
      )}

      {/* Toolbar: counts, legend, controls */}
      <div className="absolute right-4 top-4 flex flex-col items-end gap-2">
        <div className="rounded-lg border border-border bg-background/95 px-3 py-2 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
          <span className="tabular-nums">
            {activeKind !== null
              ? `${nodes.length} of ${data?.nodes.length ?? nodes.length} records · ${edges.length} links`
              : `${nodes.length} records · ${edges.length} links`}
            {unresolvedCount > 0 ? ` · ${unresolvedCount} unresolved` : ""}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-background/95 p-3 shadow-sm backdrop-blur">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
            Filter by type
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button
              type="button"
              aria-pressed={activeKind === null}
              onClick={() => selectKind(null)}
              className={cn(
                "inline-flex items-center rounded px-1 py-0.5 text-[11px] transition-colors",
                activeKind === null
                  ? "text-foreground"
                  : "text-muted-foreground/70 hover:text-foreground",
              )}
            >
              All
            </button>
            {kindsPresent.map((kind) => {
              const active = activeKind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={active}
                  onClick={() => selectKind(kind)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] transition-colors",
                    active
                      ? "text-foreground"
                      : "text-muted-foreground/70 hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full transition-opacity",
                      kind === "unresolved"
                        ? "border border-dashed border-zinc-400 bg-transparent"
                        : KIND_FILL[kind],
                      activeKind !== null && !active && "opacity-30",
                    )}
                  />
                  {KIND_LABEL[kind] ?? kind}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={resetView}
            className="mt-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground/85 transition-colors hover:bg-muted/60"
          >
            Re-layout
          </button>
        </div>
      </div>

      <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 text-[11px] text-muted-foreground/60">
        Drag nodes · scroll to zoom · drag canvas to pan · click a record to open · double-click to reset
      </p>
    </div>
  );
}
