import Image, { type ImageOptions } from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";

/**
 * Block-level image node. The default `@tiptap/extension-image` renders
 * `<img>` and supports `src`/`alt`/`title` — that's already what standard
 * markdown `![alt](src)` parses into. tiptap-markdown auto-registers a
 * serializer for the `image` node, so the on-disk round-trip works
 * without us adding markdown storage here.
 *
 * One thing we DO override: `renderHTML`. Images saved via the editor's
 * paste/drop handlers are stored as vault-relative paths
 * (`attachments/<ULID>.png`). The WebView can't load those raw — they
 * need to go through Tauri's asset protocol via `convertFileSrc`. The
 * `resolveSrc` option is the seam: tiptap-editor-impl wires it to the
 * vault path. Scheme-qualified sources pass through this extension unchanged;
 * the application CSP blocks remote HTTP(S) images in the main webview.
 */
export interface ImageMdOptions extends ImageOptions {
  /** Transform `src` (vault-relative or otherwise) into a URL the WebView
   *  can load. Default is the identity. */
  resolveSrc: (src: string) => string;
}

export const ImageMd = Image.extend<ImageMdOptions>({
  addOptions() {
    const base = this.parent?.();
    return {
      // Defaults from `@tiptap/extension-image` — explicit here so the
      // return type satisfies the required-fields shape of ImageOptions.
      inline: base?.inline ?? false,
      allowBase64: base?.allowBase64 ?? false,
      HTMLAttributes: base?.HTMLAttributes ?? {},
      resize: base?.resize ?? false,
      resolveSrc: (src: string) => src,
    };
  },
  renderHTML({ HTMLAttributes }) {
    const src = HTMLAttributes.src;
    const resolved = typeof src === "string" ? this.options.resolveSrc(src) : src;
    return [
      "img",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: resolved }),
    ];
  },
}).configure({
  inline: false,
  allowBase64: true,
  HTMLAttributes: {
    class: "tiptap-image",
  },
});

/** True for anything we should leave alone: `data:` URLs, absolute URLs,
 *  blob/file/asset URLs — anything that already has a scheme. */
export function isAbsoluteImageSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src);
}
