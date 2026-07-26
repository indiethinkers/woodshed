import { CustomTable } from "@/lib/types";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface CustomTableViewProps {
  table: CustomTable;
}

export function CustomTableView({ table }: CustomTableViewProps) {
  function formatCell(value: unknown): string {
    if (Array.isArray(value)) return value.join(", ");
    if (value === null || value === undefined) return "";
    return String(value);
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-lg font-semibold">{table.name}</h1>
        <span className="text-xs font-mono text-muted-foreground">
          {table.folder}
        </span>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              {table.schema.map((col) => (
                <TableHead key={col} className="capitalize">
                  {col.replace(/_/g, " ")}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.rows.map((row, i) => (
              <TableRow key={i}>
                <TableCell className="text-xs font-mono text-muted-foreground">
                  {row.file}
                </TableCell>
                {table.schema.map((col) => (
                  <TableCell key={col} className="text-sm">
                    {formatCell(row[col])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
