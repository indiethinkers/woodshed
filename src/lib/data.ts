import { customTables } from "@/lib/mock-data/custom-tables";

export function getCustomTable(name: string) {
  return customTables[name];
}
