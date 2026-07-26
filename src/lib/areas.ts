import { Area } from "@/lib/types";

/**
 * Sentinel area id used by the Areas surface to bucket records that have no
 * `area:` assigned. Not a real area — there's no file in `areas/` for it.
 * Notes and people can be created without an area; this id is how the UI
 * routes to them via `/areas/__unassigned__`. Resources are intentionally
 * area-less and stay in the Resources surface because the same source can
 * support multiple areas. The double underscore is a deliberate marker —
 * real area ids are kebab-case slugs.
 */
export const UNASSIGNED_AREA_ID = "__unassigned__";

/**
 * Built-in defaults seeded by the vault on first run. The runtime list is
 * fetched via useAreas() so user-created areas appear; this constant is
 * only used as a fallback when no Tauri runtime is available (vitest, browser
 * preview). The color values are legacy metadata retained for storage
 * compatibility.
 */
export const defaultAreas: Area[] = [
  { id: "woodshed", name: "Woodshed", color: "#3F3F46" },
  { id: "indie-thinkers", name: "Indie Thinkers", color: "#4338CA" },
  { id: "tech-twitter", name: "Tech Twitter", color: "#1DA1F2" },
  { id: "post-in-black", name: "Post In Black", color: "#000000" },
  { id: "personal", name: "Personal", color: "#355E3B" },
];

/**
 * Synchronous lookup against the defaults. UI components that already have
 * an Area[] from useAreas() should prefer that live list.
 */
export function getAreaName(id: string, areas: Area[] = defaultAreas): string {
  return areas.find((s) => s.id === id)?.name ?? id;
}
