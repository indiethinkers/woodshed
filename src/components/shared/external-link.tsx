import type { ComponentProps, MouseEvent } from "react";
import { openExternalUrl } from "@/lib/open-external";

export type ExternalAnchorProps = ComponentProps<"a"> & {
  href: string;
};

/**
 * Opens a public URL through Woodshed's narrow native boundary. Plain anchors
 * stay inside WKWebView, so every external link should use this component.
 */
export function ExternalAnchor({
  href,
  onClick,
  rel = "noopener noreferrer",
  target = "_blank",
  ...props
}: ExternalAnchorProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented) return;

    event.preventDefault();
    void openExternalUrl(href).catch(() => {
      // Keep private URLs and integration errors out of the console. Surfaces
      // that need inline recovery can preventDefault in onClick and own it.
      console.error("Woodshed could not open the external link.");
    });
  }

  return (
    <a
      {...props}
      href={href}
      rel={rel}
      target={target}
      onClick={handleClick}
    />
  );
}
