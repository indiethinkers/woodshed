import type { FileUIPart } from "ai";

export const AGENT_ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation,application/rtf,application/epub+zip,.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.markdown,.csv,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.ods,.odp,.rtf,.epub";

export const AGENT_ATTACHMENT_SUPPORT_MESSAGE =
  "Agent attachments support images, PDF, Office documents, and text files.";

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
    isAgentDocumentMediaType(mediaType) ||
    mediaType === "text/plain" ||
    mediaType === "text/markdown"
  ) {
    return true;
  }
  return /\.(?:pdf|txt|md|markdown|csv|docx?|docm|pptx?|pptm|ppsx?|ppsm|xlsx?|xlsm|xlsb|odt|ods|odp|rtf|epub)$/i.test(
    file.filename ?? "",
  );
}

export function isAgentDocumentMediaType(mediaType: string): boolean {
  return (
    mediaType === "application/pdf" ||
    mediaType === "text/csv" ||
    mediaType === "application/msword" ||
    mediaType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mediaType === "application/vnd.ms-word.document.macroenabled.12" ||
    mediaType === "application/vnd.ms-powerpoint" ||
    mediaType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mediaType === "application/vnd.ms-powerpoint.presentation.macroenabled.12" ||
    mediaType ===
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow" ||
    mediaType === "application/vnd.ms-powerpoint.slideshow.macroenabled.12" ||
    mediaType === "application/vnd.ms-excel" ||
    mediaType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mediaType === "application/vnd.ms-excel.sheet.macroenabled.12" ||
    mediaType === "application/vnd.ms-excel.sheet.binary.macroenabled.12" ||
    mediaType === "application/vnd.oasis.opendocument.text" ||
    mediaType === "application/vnd.oasis.opendocument.spreadsheet" ||
    mediaType === "application/vnd.oasis.opendocument.presentation" ||
    mediaType === "application/rtf" ||
    mediaType === "text/rtf" ||
    mediaType === "application/epub+zip"
  );
}
