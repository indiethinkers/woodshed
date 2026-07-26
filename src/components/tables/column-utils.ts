import type { ColumnType } from "@/lib/hooks/use-tables";

// Display label for a table column type. Lives alongside the column
// header but split out so column-header.tsx is component-only —
// React Fast Refresh requires consistent component exports per module.
export function columnTypeLabel(type: ColumnType): string {
  switch (type) {
    case "text":
      return "Text";
    case "number":
      return "Number";
    case "select":
      return "Select";
    case "multi_select":
      return "Multi-select";
    case "checkbox":
      return "Checkbox";
    case "date":
      return "Date";
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
