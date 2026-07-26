import type { NumberFormat } from "@/lib/hooks/use-tables";

// Localised number formatter for table cells. Split out of cell.tsx so
// the component module exports only React components, which lets Fast
// Refresh patch cells in place during dev instead of full-reloading
// (and dropping inline-edit state) on every save.
export function formatNumber(
  n: number,
  format: NumberFormat,
  precision: number | undefined,
): string {
  // currency formats default to 2 decimals; plain number format uses up
  // to 6 significant decimals so trivial values like 4.5 don't read as 4.50.
  switch (format) {
    case "us_dollar":
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: precision ?? 2,
        maximumFractionDigits: precision ?? 2,
      }).format(n);
    case "euro":
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: precision ?? 2,
        maximumFractionDigits: precision ?? 2,
      }).format(n);
    case "british_pound":
      return new Intl.NumberFormat("en-GB", {
        style: "currency",
        currency: "GBP",
        minimumFractionDigits: precision ?? 2,
        maximumFractionDigits: precision ?? 2,
      }).format(n);
    case "japanese_yen":
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "JPY",
        minimumFractionDigits: precision ?? 0,
        maximumFractionDigits: precision ?? 0,
      }).format(n);
    case "percent":
      return new Intl.NumberFormat("en-US", {
        style: "percent",
        minimumFractionDigits: precision ?? 0,
        maximumFractionDigits: precision ?? 2,
      }).format(n);
    case "number":
    default:
      return new Intl.NumberFormat("en-US", {
        minimumFractionDigits: precision ?? 0,
        maximumFractionDigits: precision ?? 6,
      }).format(n);
  }
}
