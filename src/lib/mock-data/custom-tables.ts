import { CustomTable } from "@/lib/types";

export const customTables: Record<string, CustomTable> = {
  sites: {
    name: "Sites",
    folder: "data/sites/",
    schema: ["domain", "dr", "health_score", "monthly_traffic", "monetization", "status"],
    rows: [
      { file: "techtwitterdotcom.md", domain: "techtwitterdotcom.com", dr: 49, health_score: 99, monthly_traffic: 1044, monetization: ["guest-posts", "sponsored-profiles", "niche-edits"], status: "active" },
      { file: "site-two.md", domain: "site2.com", dr: 12, health_score: 94, monthly_traffic: 230, monetization: [], status: "building" },
    ],
  },
  backlinks: {
    name: "Backlinks",
    folder: "data/backlinks/",
    schema: ["target_site", "target_dr", "type", "anchor_text", "price", "status"],
    rows: [
      { file: "devto-guest-post.md", target_site: "dev.to", target_dr: 61, type: "guest-post", anchor_text: "twitter trending tools", price: 0, status: "outreach" },
      { file: "smashing-niche-edit.md", target_site: "smashingmagazine.com", target_dr: 89, type: "niche-edit", anchor_text: "tech twitter directory", price: 350, status: "live" },
      { file: "css-tricks-guest.md", target_site: "css-tricks.com", target_dr: 78, type: "guest-post", anchor_text: "developer community", price: 0, status: "published" },
    ],
  },
};
