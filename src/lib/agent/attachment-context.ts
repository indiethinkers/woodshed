import type { FileUIPart } from "ai";

const ATTACHMENT_HEADER = "Attachments:\n";
const ATTACHMENT_LINE_RE = /^- (.+?)(?: \(([^()\s]+\/[^()\s]+)\))?$/;

export function attachmentContextFromFiles(files: FileUIPart[]): string {
  if (files.length === 0) return "";
  return `${ATTACHMENT_HEADER}${files
    .map(
      (file) =>
        `- ${attachmentLabel(file)}${file.mediaType ? ` (${file.mediaType})` : ""}`,
    )
    .join("\n")}`;
}

export function parsePersistedAttachmentContext(content: string): {
  files: FileUIPart[];
  text: string;
} {
  const separatorIndex = content.lastIndexOf(`\n\n${ATTACHMENT_HEADER}`);
  const headerIndex =
    separatorIndex >= 0
      ? separatorIndex + 2
      : content.startsWith(ATTACHMENT_HEADER)
        ? 0
        : -1;
  if (headerIndex < 0) return { files: [], text: content };

  const attachmentLines = content
    .slice(headerIndex + ATTACHMENT_HEADER.length)
    .split("\n");
  if (attachmentLines.length === 0 || attachmentLines.some((line) => !line)) {
    return { files: [], text: content };
  }

  const files: FileUIPart[] = [];
  for (const line of attachmentLines) {
    const match = ATTACHMENT_LINE_RE.exec(line);
    if (!match) return { files: [], text: content };
    files.push({
      type: "file",
      filename: match[1],
      mediaType: match[2],
      url: "",
    });
  }

  return {
    files,
    text: content.slice(0, separatorIndex >= 0 ? separatorIndex : 0).trimEnd(),
  };
}

export function attachmentLabel(file: FileUIPart): string {
  return file.filename?.trim() || "Attachment";
}
