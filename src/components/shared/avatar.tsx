import { AvatarColor } from "@/lib/types";
import { getAvatarColor } from "@/lib/avatars";
import { isLocalFilePath, resolveLocalAssetSrc } from "@/lib/local-asset-src";

interface AvatarProps {
  initials: string;
  /**
   * Fallback background tint used when no `image` is provided. People
   * no longer carry a per-person color in the data model — every
   * initials-fallback reads as Woodshed-teal — but the prop remains
   * `optional` so future surfaces can still distinguish identities by
   * tint when they have one.
   */
  color?: AvatarColor;
  size?: "sm" | "md" | "lg" | "xl";
  image?: string;
}

const sizeClasses = {
  sm: "h-7 w-7 text-xs",
  md: "h-9 w-9 text-sm",
  // 48px — anchors a detail-page header where the title leads and the
  // avatar is a quiet identity marker, not a hero shot.
  xl: "h-12 w-12 text-base",
  lg: "h-14 w-14 text-lg",
};

export function Avatar({ initials, color = "teal", size = "md", image }: AvatarProps) {
  const imageSrc = image ? resolveAvatarSrc(image) : null;
  if (imageSrc) {
    return (
      <img
        src={imageSrc}
        alt={initials}
        className={`${sizeClasses[size]} rounded-full object-cover shrink-0`}
      />
    );
  }

  const { bg, text } = getAvatarColor(color);
  return (
    <div
      className={`${sizeClasses[size]} rounded-full flex items-center justify-center font-medium shrink-0`}
      style={{ backgroundColor: bg, color: text }}
    >
      {initials}
    </div>
  );
}

/**
 * Convert a stored avatar value into something an `<img>` tag can load.
 *
 * The backend pre-resolves vault-relative attachments to absolute
 * filesystem paths so this function normally sees an absolute filesystem path
 * (`/Users/.../woodshed/attachments/…`). Pass that through the runtime's
 * local-asset resolver so Tauri can serve it.
 *
 * Remote/data/blob sources are rejected here as a second line of defense
 * against tracking and active content in hand-edited person records.
 *
 * Legacy `/avatars/` values refer to bundled files that are no longer shipped,
 * so reject them and let the caller render initials instead.
 */
export function resolveAvatarSrc(image: string): string | null {
  if (image.startsWith("/avatars/")) return null;
  if (/^(?:https?|data|blob):/i.test(image)) return null;
  if (isLocalFilePath(image)) {
    return resolveLocalAssetSrc(image);
  }
  return image;
}
