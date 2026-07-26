interface BrandMarkProps {
  className?: string;
  title?: string;
}

export function BrandMark({ className, title }: BrandMarkProps) {
  return (
    <img
      src="/brand-mark.png"
      alt={title ?? ""}
      className={`block rounded-md ${className ?? ""}`}
      role={title ? "img" : "presentation"}
      aria-hidden={!title}
      draggable={false}
    />
  );
}
