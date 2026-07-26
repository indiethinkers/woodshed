import { Star } from "lucide-react";

/**
 * Star toggle for a record's detail-page header. Persisted as
 * `favorite: true` in the record's frontmatter — favorites surface in the
 * index pages' list panel.
 */
export function FavoriteToggle({
  favorite,
  onToggle,
  subject,
}: {
  favorite: boolean;
  onToggle: () => void;
  /** Record name for the accessible label. */
  subject: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={favorite}
      aria-label={
        favorite
          ? `Remove ${subject} from favorites`
          : `Add ${subject} to favorites`
      }
      title={favorite ? "Remove from favorites" : "Add to favorites"}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-foreground/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15 ${
        favorite
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Star
        className="h-4 w-4"
        strokeWidth={1.7}
        fill={favorite ? "currentColor" : "none"}
      />
    </button>
  );
}
