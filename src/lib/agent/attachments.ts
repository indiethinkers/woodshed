import type { FileUIPart } from "ai";

export const AGENT_ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.markdown";

export const AGENT_ATTACHMENT_SUPPORT_MESSAGE =
  "Agent attachments support images, PDF, and text files.";

export function isAgentImageAttachment(
  file: Pick<FileUIPart, "filename" | "mediaType">,
): boolean {
  const mediaType = file.mediaType.toLowerCase();
  return (
    mediaType === "image/png" ||
    mediaType === "image/jpeg" ||
    mediaType === "image/gif" ||
    mediaType === "image/webp" ||
    /\.(?:png|jpe?g|gif|webp)$/i.test(file.filename ?? "")
  );
}

export function isSupportedAgentAttachment(
  file: Pick<FileUIPart, "filename" | "mediaType">,
): boolean {
  const mediaType = file.mediaType.toLowerCase();
  if (
    isAgentImageAttachment(file) ||
    mediaType === "application/pdf" ||
    mediaType === "text/plain" ||
    mediaType === "text/markdown"
  ) {
    return true;
  }
  return /\.(?:pdf|txt|md|markdown)$/i.test(file.filename ?? "");
}
