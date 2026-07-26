const EMPTY_DAILY_EDITOR_MARKDOWN = "- ";
const TIMESTAMPED_LITERAL_BULLET = /^- \[(\d{2}:\d{2})\] - (.*)$/;
const TIMESTAMPED_TOP_LEVEL_ROW = /^- \[(\d{2}:\d{2})\] (.*)$/;

export function dailyEditorValue(body: string): string {
  if (body.trim().length === 0) return EMPTY_DAILY_EDITOR_MARKDOWN;

  // Cadence stores every top-level journal row as a timestamped bullet. That
  // hidden timestamp prevents Tiptap's normal `- ` input rule from firing, so
  // older builds could persist an intended child bullet as literal `- text`
  // inside the timestamped row. Rehydrate that unambiguous shape as a nested
  // list item. Contiguous rows stamped in that same minute are the Enter-key
  // continuation of the broken list; a different timestamp ends the repair.
  // The editor's next real edit will serialize the repaired shape.
  let hasTopLevelItem = false;
  let continuationTime: string | null = null;
  return body
    .split(/\r?\n/)
    .map((line) => {
      const literalBullet = line.match(TIMESTAMPED_LITERAL_BULLET);
      if (hasTopLevelItem && literalBullet) {
        continuationTime = literalBullet[1];
        return `  - ${literalBullet[2]}`;
      }

      const timestampedRow = line.match(TIMESTAMPED_TOP_LEVEL_ROW);
      if (continuationTime && timestampedRow?.[1] === continuationTime) {
        return `  - ${timestampedRow[2]}`;
      }

      continuationTime = null;
      if (timestampedRow || /^- /.test(line)) hasTopLevelItem = true;
      return line;
    })
    .join("\n");
}
