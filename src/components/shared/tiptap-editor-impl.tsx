import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useRightSidebar } from "@/components/layout/right-sidebar-context-internal";
import { useTabs } from "@/components/layout/tabs-context-internal";
import { useQueryClient } from "@tanstack/react-query";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import type {
  SuggestionKeyDownProps,
  SuggestionProps,
} from "@tiptap/suggestion";
import { resolveWikilink } from "@/lib/wikilinks";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { TextSelection } from "@tiptap/pm/state";
import type { ResolvedPos } from "@tiptap/pm/model";
import type { Node as PMNode, NodeType } from "prosemirror-model";
import {
  YoutubeResource,
  YOUTUBE_URL_RE,
  YOUTUBE_RESOURCE_TAG_LINE_RE,
} from "./extensions/youtube-resource";
import { TWEET_URL_RE } from "@/lib/twitter";
import { Twitter } from "./extensions/twitter";
import { ImageMd, isAbsoluteImageSrc } from "./extensions/image-md";
import { useVaultPath } from "@/lib/hooks/use-vault-path";
import { resolveLocalAssetSrc } from "@/lib/local-asset-src";
import { hasBackend, tauriInvoke } from "@/lib/tauri";
import { stripEmptyTimestampBulletsFromMarkdown } from "@/lib/daily-timestamps";
import { openExternalUrl } from "@/lib/open-external";
import { SlashCommand } from "./extensions/slash-command";
import { SectionHeader } from "./extensions/section-header";
import { MeetingTranscript } from "./extensions/meeting-transcript";
import { DailyTimestamp } from "./extensions/daily-timestamp";
import {
  OutlineListItem,
  parseCollapsedMarkers,
} from "./extensions/outline-fold";
import { CompactCaret } from "./extensions/compact-caret";
import { Wikilink, type WikilinkType } from "./extensions/wikilink";
import {
  WikilinkSuggestion,
  type WikilinkPickerSelection,
} from "./extensions/wikilink-suggestion";
import {
  WikilinkPicker,
  type WikilinkPickerHandle,
  type WikilinkPickerState,
} from "./wikilink-picker";
import {
  normalizeToOutline,
  removeGeneratedTrailingEmptyBullet,
} from "./outline-normalizer";
import { unwrapGeneratedOutlineMarkdown } from "./outline-markdown";
import {
  SlashCommandMenu,
  type SlashCommandMenuHandle,
  type SlashCommandMenuState,
} from "./slash-command-menu";
import {
  insertNormalizedPlainTextPaste,
  insertPlainTextParagraphsAsListItems,
  linkSelectionWithPastedUrl,
} from "./list-paste";
import { handleListIndentShortcut } from "./list-indent-shortcut";
import {
  deleteEmptyListItem,
  deleteListItemTextBeforeCursor,
  insertTimestampedHorizontalRule,
  insertTopLevelItemAfterChildren,
  listItemHasVisibleContent,
  nestTimestampedListMarker,
  outdentEmptyNestedListItem,
  outdentListItemAtStart,
  outdentNestedListItem,
} from "./timestamped-list-enter";
import { handleScrollToVisibleSelection } from "./selection-scroll";
import { isEditableElement } from "@/lib/dom/is-editable";
import { handleBlockArrowNavigation } from "./block-arrow-navigation";

const BODY_AUTOSAVE_DELAY_MS = 750;
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
// The URL→embed transform walks the whole doc; running it on every
// keystroke makes typing latency scale with document size. A pause this
// short still converts a pasted/typed URL before the user looks up.
const EMBED_TRANSFORM_DELAY_MS = 300;
type InsertImageOptions = {
  coords?: { x: number; y: number };
  pos?: number;
  replaceRange?: { from: number; to: number };
  usePendingPickerTarget?: boolean;
};

export interface TiptapEditorProps {
  value: string;
  /**
   * Persist `next` somewhere. Return a Promise if the persistence is
   * async — the wikilink click handler awaits it before navigating so
   * unsaved edits never get stranded by an immediate route change.
   * (See the comment on the wikilink click handler below.)
   */
  onCommit: (next: string) => void | Promise<void>;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /** Focus the editor at the end when Enter is pressed outside editable UI. */
  focusOnEnter?: boolean;
  /**
   * Whether to reserve a tall (30vh) scroll-past-end runway below the editor
   * so the caret can sit in the comfortable upper third on a long document.
   * Defaults to `true` for full-surface editors (Notebook). Set `false` for
   * editors embedded as a *section* with content beneath them (the event /
   * record notes that sit above their backlinks): there the runway is phantom
   * scroll space that makes a short page scrollable and lets focus / the first
   * keystroke jump the page downward into emptiness.
   */
  scrollPastEnd?: boolean;
  /**
   * Editing mode.
   *   - `freeform` (default): plain markdown — paragraphs, headings, lists.
   *   - `outline`: Roam-style hierarchical bullets. Loose top-level content
   *     is auto-wrapped into `bulletList > listItem` on load, an empty
   *     doc starts as a single bullet, Tab/Shift+Tab nest/unnest.
   *
   * The schema stays permissive in both modes (forcing a strict bullet-only
   * doc fights ProseMirror on every paste). Outline mode is a normalization
   * + UX layer on top of the standard schema.
   */
  mode?: "freeform" | "outline";
  /**
   * Cadence daily-notes affordance: timestamp newly-created list items and
   * preserve the capture time as hidden markdown metadata. Plain Tab /
   * Shift+Tab manage outline indentation while this mode is active.
   */
  timestampedListItems?: boolean;
  /**
   * One-way compatibility shim for pages that previously used outline mode.
   * When enabled, a document where every non-blank line is an outline row
   * opens as plain blocks instead of showing a marker before every block.
   */
  unwrapOutlineOnLoad?: boolean;
  /**
   * Optional override for image uploads. Receives the dropped/pasted
   * `File` and should return a URL or path that gets written into the
   * markdown as `![alt](src)`. When omitted, the editor calls the
   * `attachment_save` Tauri command, which writes the bytes to
   * `<vault>/attachments/<ULID>.<ext>` and returns the vault-relative
   * path. Override only if a surface needs to redirect uploads elsewhere.
   */
  onUploadImage?: (file: File) => Promise<string>;
  /**
   * Allow raw HTML blocks in the markdown round-trip. Off by default — most
   * surfaces want plain markdown only. The event-notes editors enable it so the
   * recorded meeting transcript (an opaque `<details>` block, see
   * `MeetingTranscript`) parses into its collapsible node instead of rendering
   * as literal `<details>` tags.
   */
  allowHtml?: boolean;
}

async function fileToBytes(file: File): Promise<Uint8Array> {
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

// A link the system browser (or mail client) should handle, vs. an internal
// app route (`/people/…`) or in-page anchor (`#section`) which stay in-app.
function isExternalHref(href: string): boolean {
  return /^(https?:|mailto:|tel:)/i.test(href);
}

function extFromFile(file: File): string {
  // Prefer the actual filename — the MIME type from clipboard pastes is
  // often a generic `image/png` even when the original was a JPEG, and
  // the user's filename is what they'll see in Finder.
  const dot = file.name.lastIndexOf(".");
  if (dot >= 0 && dot < file.name.length - 1) {
    return file.name.slice(dot + 1);
  }
  // Fall back to the MIME subtype (`image/png` → `png`).
  const slash = file.type.indexOf("/");
  return slash >= 0 ? file.type.slice(slash + 1) : "";
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function sameOutlineMarkdownIgnoringListSpacing(left: string, right: string) {
  return compactListSpacing(left).trimEnd() === compactListSpacing(right).trimEnd();
}

function compactListSpacing(value: string): string {
  const lines = value.split(/\r?\n/);
  return lines
    .filter((line, index) => {
      if (line.trim() !== "") return true;
      const previous = nearestNonBlankLine(lines, index, -1);
      const next = nearestNonBlankLine(lines, index, 1);
      return !(isMarkdownListLine(previous) && isMarkdownListLine(next));
    })
    .join("\n");
}

function nearestNonBlankLine(
  lines: string[],
  start: number,
  direction: -1 | 1,
): string {
  for (
    let index = start + direction;
    index >= 0 && index < lines.length;
    index += direction
  ) {
    if (lines[index].trim() !== "") return lines[index];
  }
  return "";
}

function isMarkdownListLine(line: string): boolean {
  return /^\s*(?:[-+*]|\d+[.)])(?:\s|$)/.test(line);
}

/** Default upload path: bytes → Tauri → `attachments/<ULID>.<ext>` →
 *  vault-relative string that lands in the markdown body. */
async function defaultUploadImage(file: File): Promise<string | null> {
  if (!hasBackend()) return null;
  if (file.size === 0 || file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Images must be between 1 byte and 20 MiB");
  }
  const bytes = await fileToBytes(file);
  const ext = extFromFile(file);
  const rel = await tauriInvoke<string>("attachment_save", {
    bytes: Array.from(bytes),
    ext,
  });
  return rel ?? null;
}

/**
 * Markdown body editor backed by Tiptap. Markdown stays the on-disk
 * format — `tiptap-markdown` handles the round-trip, with custom
 * serializers on the YouTube and Twitter nodes that just emit the URL
 * on its own line. Pasting a YouTube or X / Twitter URL is converted
 * into the corresponding embed via the node's paste rule. Initial
 * content gets the same treatment via a one-time post-load transform.
 */
export function TiptapEditor({
  value,
  onCommit,
  placeholder,
  className,
  autoFocus,
  focusOnEnter = false,
  mode = "freeform",
  timestampedListItems = false,
  unwrapOutlineOnLoad = false,
  scrollPastEnd = true,
  onUploadImage,
  allowHtml = false,
}: TiptapEditorProps) {
  const editorValue = useMemo(
    () =>
      mode === "freeform" && unwrapOutlineOnLoad
        ? unwrapGeneratedOutlineMarkdown(value)
        : value,
    [mode, unwrapOutlineOnLoad, value],
  );
  const lastMarkdownRef = useRef<string>(editorValue);
  const latestMarkdownRef = useRef<string>(editorValue);
  // The external value most recently loaded into the editor (raw, as it
  // came from disk/cache). The post-load embed transform and markdown
  // normalization make getMarkdown() diverge from this string without any
  // user edit, so dirty-tracking refs can't double as "did the file
  // change?" tracking — this ref answers that question on its own.
  const ingestedValueRef = useRef<string>(editorValue);
  const [slashState, setSlashState] = useState<SlashCommandMenuState | null>(
    null,
  );
  const slashMenuRef = useRef<SlashCommandMenuHandle | null>(null);
  const [wikilinkState, setWikilinkStateInner] =
    useState<WikilinkPickerState | null>(null);
  const wikilinkStateRef = useRef<WikilinkPickerState | null>(null);
  // Alias-link mode: set while the wikilink picker is open over a text
  // selection (user pressed `[`). Holds the selection's display text and
  // doc range so the chosen page becomes the link target → `[[Target|alias]]`.
  // `aliasQueryRef` mirrors the (refinable) search string. Both null in the
  // ordinary `[[`-typed picker flow.
  const aliasRef = useRef<{ alias: string; from: number; to: number } | null>(
    null,
  );
  const aliasQueryRef = useRef("");
  const setWikilinkState = useCallback((next: WikilinkPickerState | null) => {
    // Closing the picker (Escape / commit / blur) leaves alias mode too.
    if (next === null) aliasRef.current = null;
    wikilinkStateRef.current = next;
    setWikilinkStateInner(next);
  }, []);
  const wikilinkPickerRef = useRef<WikilinkPickerHandle | null>(null);
  const createWikilinkSuggestionRenderer = useCallback(() => {
    const updatePicker = (
      props: SuggestionProps<unknown, WikilinkPickerSelection>,
    ) => {
      setWikilinkState({
        query: props.query,
        command: (selection) => props.command(selection),
        clientRect: props.clientRect ?? null,
      });
    };

    return {
      onStart: updatePicker,
      onUpdate: updatePicker,
      onExit: () => setWikilinkState(null),
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (event.key === "Escape") {
          setWikilinkState(null);
          return true;
        }
        return wikilinkPickerRef.current?.onKeyDown(event) ?? false;
      },
    };
  }, [setWikilinkState]);
  const editorRef = useRef<Editor | null>(null);

  // Commit a picker selection in alias mode: replace the highlighted range
  // with `[[Target|alias]]` (or a plain `[[alias]]` when the chosen page name
  // equals the selection). `selection.text` is the chosen/created page title;
  // the alias is whatever text the user had selected.
  const aliasCommand = useCallback(
    (selection: WikilinkPickerSelection) => {
      const a = aliasRef.current;
      const editor = editorRef.current;
      if (!a || !editor) return;
      const target = selection.text.trim();
      const attrs: {
        text: string;
        target: string | null;
        type: WikilinkType | null;
      } = {
        text: a.alias,
        target: target && target !== a.alias ? target : null,
        type: selection.kind === "create" ? selection.type : null,
      };
      editor
        .chain()
        .focus()
        .deleteRange({ from: a.from, to: a.to })
        .insertContentAt(a.from, [
          { type: "wikilink", attrs },
          { type: "text", text: " " },
        ])
        .run();
      setWikilinkState(null);
    },
    [setWikilinkState],
  );

  // (Re)open the alias picker for the current `aliasQueryRef`. Called on open
  // and on every refining keystroke; the clientRect tracks the live selection.
  const setAliasPickerState = useCallback(
    (query: string) => {
      setWikilinkState({
        query,
        command: aliasCommand,
        clientRect: () => {
          const a = aliasRef.current;
          const view = editorRef.current?.view;
          if (!a || !view) return null;
          const c = view.coordsAtPos(a.from);
          return new DOMRect(c.left, c.top, 0, c.bottom - c.top);
        },
      });
    },
    [aliasCommand, setWikilinkState],
  );

  const openAliasPicker = useCallback(
    (alias: string, from: number, to: number) => {
      aliasRef.current = { alias, from, to };
      aliasQueryRef.current = alias;
      setAliasPickerState(alias);
    },
    [setAliasPickerState],
  );

  const pendingImagePickerTargetRef = useRef<
    { range: { from: number; to: number } } | { pos: number } | null
  >(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { openInNewTab } = useTabs();
  const { addPage } = useRightSidebar();
  // `onCommit` is a prop and can change between renders, but `useEditor`
  // captures its callbacks once. Keep the latest in a ref so onBlur /
  // wikilink-click read the current handler.
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);
  // Autosave is debounced, then flushed on blur/unmount/navigation. Keep
  // the latest markdown in refs so an unmount can still start the write even
  // if ProseMirror never emitted a blur event.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const pendingCommitRef = useRef<Promise<void> | null>(null);
  const queuedMarkdownRef = useRef<string | null>(null);
  const createdRef = useRef(false);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current === null) return;
    clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = null;
  }, []);

  const drainCommitQueue = useCallback((): Promise<void> => {
    if (pendingCommitRef.current) return pendingCommitRef.current;

    const run = (async () => {
      while (queuedMarkdownRef.current !== null) {
        const md = queuedMarkdownRef.current;
        queuedMarkdownRef.current = null;
        if (md === lastMarkdownRef.current) continue;
        await onCommitRef.current(md);
        lastMarkdownRef.current = md;
        // The file now holds `md`, so the ingestion tracker follows it —
        // otherwise an external edit reverting the file to the originally
        // loaded content would look "already ingested" and be ignored.
        ingestedValueRef.current = md;
      }
    })().finally(() => {
      pendingCommitRef.current = null;
    });

    pendingCommitRef.current = run;
    return run;
  }, []);

  const commitMarkdownIfDirty = useCallback(
    (md: string): Promise<void> => {
      latestMarkdownRef.current = md;
      if (md === lastMarkdownRef.current && queuedMarkdownRef.current === null) {
        return pendingCommitRef.current ?? Promise.resolve();
      }
      queuedMarkdownRef.current = md;
      return drainCommitQueue();
    },
    [drainCommitQueue],
  );

  const flushCommit = useCallback(
    (md = latestMarkdownRef.current): Promise<void> => {
      clearAutosaveTimer();
      return commitMarkdownIfDirty(md);
    },
    [clearAutosaveTimer, commitMarkdownIfDirty],
  );

  // Diff the current markdown against the last committed value. Returns the
  // host commit promise, so callers that need a guarantee that the bytes are
  // on disk can `await` it.
  const commitEditorIfDirty = useCallback(
    (editor: Editor | null): Promise<void> => {
      if (!editor || editor.isDestroyed) return flushCommit();
      const md = (
        editor.storage as unknown as { markdown: MarkdownStorage }
      ).markdown.getMarkdown();
      return flushCommit(md);
    },
    [flushCommit],
  );

  // Serialization happens when the timer FIRES, not when each keystroke
  // schedules it — getMarkdown() walks the whole doc, and doing that per
  // keystroke is the difference between a caret that keeps up and one
  // that lags on long notes. Blur / unmount / wikilink-click all flush
  // through commitEditorIfDirty, which serializes from the live editor.
  const scheduleAutosave = useCallback(
    (editor: Editor) => {
      clearAutosaveTimer();
      autosaveTimerRef.current = setTimeout(() => {
        autosaveTimerRef.current = null;
        if (editor.isDestroyed) {
          void commitMarkdownIfDirty(latestMarkdownRef.current);
          return;
        }
        const md = (
          editor.storage as unknown as { markdown: MarkdownStorage }
        ).markdown.getMarkdown();
        void commitMarkdownIfDirty(md);
      }, BODY_AUTOSAVE_DELAY_MS);
    },
    [clearAutosaveTimer, commitMarkdownIfDirty],
  );

  // Debounced URL→embed transform (see EMBED_TRANSFORM_DELAY_MS).
  const embedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleEmbedTransform = useCallback((editor: Editor) => {
    if (embedTimerRef.current !== null) {
      clearTimeout(embedTimerRef.current);
    }
    embedTimerRef.current = setTimeout(() => {
      embedTimerRef.current = null;
      if (!editor.isDestroyed) replaceUrlParagraphsWithEmbeds(editor);
    }, EMBED_TRANSFORM_DELAY_MS);
  }, []);

  // Flush-on-unmount lives BEFORE useEditor so its cleanup runs before
  // useEditor's own cleanup destroys the editor (React runs cleanups in
  // declaration order) — the final serialization still sees a live view.
  useEffect(() => {
    return () => {
      if (embedTimerRef.current !== null) {
        clearTimeout(embedTimerRef.current);
        embedTimerRef.current = null;
      }
      void commitEditorIfDirty(editorRef.current);
    };
  }, [commitEditorIfDirty]);
  // Vault path is passed in by the outer wrapper, which holds the editor
  // off-mount until the path is resolved. That guarantees `resolveSrc`
  // returns a valid asset URL on the very first render, so we don't have
  // to re-instantiate the editor when the path lands.
  const { data: vaultPath } = useVaultPath();
  const resolveSrc = useCallback(
    (src: string): string => {
      if (isAbsoluteImageSrc(src)) return src;
      if (!vaultPath) return src;
      return resolveLocalAssetSrc(`${vaultPath}/${src}`) ?? src;
    },
    [vaultPath],
  );
  // Latest upload handler kept in a ref so the closures inside Tiptap
  // event handlers always see the current callback without re-creating
  // the editor on every render.
  const onUploadImageRef = useRef(onUploadImage);
  useEffect(() => {
    onUploadImageRef.current = onUploadImage;
  }, [onUploadImage]);

  // Resolve a File → URL. Order: caller override → Tauri attachment_save
  // → data URL only when there is no native backend (browser-mode dev /
  // vitest). Native validation failures must not be bypassed by embedding
  // the rejected bytes directly in markdown.
  const uploadImage = useCallback(async (file: File): Promise<string | null> => {
    if (
      !file.type.startsWith("image/") ||
      file.size === 0 ||
      file.size > MAX_IMAGE_UPLOAD_BYTES
    ) {
      return null;
    }
    const hook = onUploadImageRef.current;
    if (hook) {
      try {
        return await hook(file);
      } catch (err) {
        console.error("image upload override failed, falling back to default", err);
      }
    }
    try {
      const rel = await defaultUploadImage(file);
      if (rel) return rel;
    } catch (err) {
      console.error("attachment_save rejected image", err);
      if (hasBackend()) return null;
    }
    return fileToDataUrl(file);
  }, []);

  // Insert an image by replacing the slash-command range, using drop
  // coordinates, or falling back to the current selection.
  const insertImage = useCallback(
    async (file: File, options?: InsertImageOptions) => {
      const editor = editorRef.current;
      if (!editor) return;
      let pos: number | null = options?.pos ?? null;
      let replaceRange: { from: number; to: number } | null =
        options?.replaceRange ?? null;
      const src = await uploadImage(file);
      if (options?.usePendingPickerTarget) {
        const target = pendingImagePickerTargetRef.current;
        pendingImagePickerTargetRef.current = null;
        if (target && "range" in target) replaceRange = target.range;
        if (target && "pos" in target) pos = target.pos;
      }
      if (!src) return;
      if (pos == null && options?.coords) {
        const at = editor.view.posAtCoords({
          left: options.coords.x,
          top: options.coords.y,
        });
        if (at) pos = at.pos;
      }
      const chain = editor.chain().focus();
      if (replaceRange) {
        chain.insertContentAt(clampInsertRange(editor, replaceRange), {
          type: "image",
          attrs: { src, alt: file.name },
        });
      } else if (pos != null) {
        chain.insertContentAt(clampInsertPos(editor, pos), {
          type: "image",
          attrs: { src, alt: file.name },
        });
      } else {
        chain.setImage({ src, alt: file.name });
      }
      chain.run();
    },
    [uploadImage],
  );

  const queryClient = useQueryClient();
  // Pasting an X / YouTube URL also saves it to Resources. Fire-and-forget:
  // the backend dedupes by URL and resolves a real title via oEmbed (no AI),
  // skipping the daily-page trace because the embed itself already lives in
  // the body being edited. Failures stay silent — the embed still renders.
  const captureEmbedResource = useCallback(
    (url: string, tag: "twitter" | "youtube") => {
      void tauriInvoke<unknown>("resource_capture_url", {
        input: { url, tags: [tag], skipDailyLog: true },
      })
        .then((created) => {
          if (!created) return;
          // Backend writes are self-writes the watcher filters; with
          // staleTime: Infinity the caches need an explicit nudge. People
          // too — the capture links (or creates) the author as a person.
          void queryClient.invalidateQueries({ queryKey: ["resources"] });
          void queryClient.invalidateQueries({ queryKey: ["wikilinkTargets"] });
          void queryClient.invalidateQueries({ queryKey: ["people"] });
        })
        .catch((error) => {
          // eslint-disable-next-line no-console
          console.error("[woodshed] embed resource capture failed:", error);
        });
    },
    [queryClient],
  );

  const editor = useEditor({
    // Render the editor in the first commit instead of deferring creation to a
    // post-paint effect. `false` is the SSR-safe default (avoids hydration
    // mismatches), but this is a client-only Tauri app with no SSR — deferring
    // just meant the notes appeared a beat after the rest of the page on every
    // navigation (the editor remounts per record via `key`). Eager render makes
    // the text show up with the page.
    immediatelyRender: true,
    extensions: [
      StarterKit.configure({
        // The default paragraph/list/blockquote nodes are enough; disable
        // codeBlock for now since we don't render fenced code blocks in
        // notes, and it complicates serialization.
        codeBlock: false,
        heading: { levels: [1, 2, 3, 4, 5] },
        link: { openOnClick: false, autolink: true },
        // Outline mode is bullet-first: a trailing empty paragraph after the
        // last bullet would let the user fall out of the outline. In
        // freeform mode we keep the trailing-node affordance so a doc
        // ending with a heading or list still has somewhere to type.
        trailingNode: mode === "outline" ? false : undefined,
        // Outline mode swaps in OutlineListItem (collapsible bullets); it
        // keeps the standard list keymap and adds the collapse attribute +
        // fold affordance. Other surfaces keep StarterKit's list item.
        ...(mode === "outline" ? { listItem: false as const } : {}),
      }),
      ...(mode === "outline" ? [OutlineListItem] : []),
      // Smart punctuation as INPUT RULES, replacing at the keystroke.
      // Without this, macOS's own smart-quote substitution (active in
      // WKWebView contenteditables) rewrites `'` → `'` only when the word
      // commits on space — a late glyph swap that visibly shifts the text.
      // With the input rule the curly quote is there from the first frame,
      // so the OS pass finds nothing to replace. Only the rules that
      // preempt macOS substitutions are enabled; the exotic conversions
      // ((c) → ©, 1/2 → ½, etc.) stay off so notes aren't rewritten in
      // ways the user never typed.
      Typography.configure({
        leftArrow: false,
        rightArrow: false,
        copyright: false,
        trademark: false,
        servicemark: false,
        registeredTrademark: false,
        oneHalf: false,
        oneQuarter: false,
        threeQuarters: false,
        plusMinus: false,
        notEqual: false,
        laquo: false,
        raquo: false,
        multiplication: false,
        superscriptTwo: false,
        superscriptThree: false,
      }),
      // Retain pasted HTML tables as editable table nodes and serialize them
      // back to Markdown instead of flattening their rows into plain prose.
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      SectionHeader,
      MeetingTranscript,
      ...(timestampedListItems ? [DailyTimestamp] : []),
      Markdown.configure({
        html: allowHtml,
        linkify: true,
        breaks: false,
        bulletListMarker: "-",
        // Parse pasted plain-text as markdown so `# heading`, `**bold**`,
        // backtick code, etc. render with their proper structure instead
        // of landing as literal characters inside the current bullet. URL
        // embedding still works downstream — the embed transform reads
        // `paragraph.textContent`, which equals the URL whether it's wrapped
        // in a link by the parser or not.
        transformPastedText: true,
        transformCopiedText: true,
      }),
      Placeholder.configure({
        placeholder: ({ node }) =>
          node.type.name === "sectionHeader"
            ? "Section title"
            : placeholder ?? "",
        showOnlyWhenEditable: true,
        showOnlyCurrent: false,
        // Descend through non-textblock wrappers (bulletList, listItem,
        // blockquote). Without this, outline-mode bullets — where the
        // empty <p> lives at bulletList > listItem > paragraph — never
        // receive the `is-empty` + `data-placeholder` decoration, and
        // the placeholder CSS in styles.css has nothing to render.
        includeChildren: true,
      }),
      YoutubeResource.configure({
        addPasteHandler: true,
        onPasted: (url) => captureEmbedResource(url, "youtube"),
      }),
      Twitter.configure({
        onPasted: (url) => captureEmbedResource(url, "twitter"),
      }),
      ImageMd.configure({ resolveSrc }),
      CompactCaret,
      Wikilink,
      WikilinkSuggestion.configure({
        suggestion: {
          render: createWikilinkSuggestionRenderer,
        },
        atSuggestion: {
          render: createWikilinkSuggestionRenderer,
        },
      }),
      SlashCommand.configure({
        suggestion: {
          render: () => ({
            onStart: (props) => {
              setSlashState({
                items: props.items,
                query: props.query,
                command: (item) => props.command(item),
                clientRect: props.clientRect ?? null,
              });
            },
            onUpdate: (props) => {
              setSlashState({
                items: props.items,
                query: props.query,
                command: (item) => props.command(item),
                clientRect: props.clientRect ?? null,
              });
            },
            onExit: () => {
              setSlashState(null);
            },
            // Forward keyboard events to the React menu so it can drive
            // selection without re-implementing arrow / enter handling
            // inside a ProseMirror plugin. Returning true here stops the
            // editor's own keymap (and our outer Escape→blur handler)
            // from firing — a single Escape just closes the menu, the
            // user's caret stays put, and a follow-up Escape will then
            // blur the editor as usual.
            onKeyDown: ({ event }) => {
              if (event.key === "Escape") {
                setSlashState(null);
                return true;
              }
              return slashMenuRef.current?.onKeyDown(event) ?? false;
            },
          }),
        },
      }),
    ],
    content: editorValue,
    autofocus: autoFocus ? "start" : false,
    editorProps: {
      handleScrollToSelection: handleScrollToVisibleSelection,
      attributes: {
        class: `tiptap-content focus:outline-none ${className ?? ""}`,
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
        // Outline mode opts in to Roam-style indent rails (vertical guide
        // lines connecting bullet dots through their children). The rails
        // are scoped to `[data-outline]` so freeform editors stay clean.
        // Timestamped daily notes are the exception: they're an outline too,
        // but they own a combined treatment under `[data-daily-timestamps]`
        // (hidden capture metadata + nested bullets), so we keep
        // `data-outline` off them to avoid two style layers fighting.
        ...(mode === "outline" && !timestampedListItems
          ? { "data-outline": "" }
          : {}),
        ...(timestampedListItems ? { "data-daily-timestamps": "" } : {}),
      },
      // Escape blurs the editor instead of being swallowed by ProseMirror.
      // Outer surfaces already gate their own
      // Escape handlers behind `isEditableElement` — blurring here lets a
      // single Escape exit typing, and a second Escape bubble to those.
      // Also handles selection-link: typing `[` with text selected opens the
      // wikilink picker with the selection kept as the display alias, so the
      // chosen page becomes the link target → `[[Target|alias]]`. (The plain
      // picker path lives in WikilinkSuggestion and triggers when `[[` is
      // typed at an empty selection.)
      handleKeyDown(view, event) {
        if (wikilinkStateRef.current) {
          if (event.key === "Escape") {
            event.preventDefault();
            setWikilinkState(null);
            return true;
          }
          const handledByPicker =
            wikilinkPickerRef.current?.onKeyDown(event) ?? false;
          if (handledByPicker) {
            event.preventDefault();
            return true;
          }
        }
        // While the alias picker is open the editor is locked on the
        // highlighted selection (our replace target). Printable keys and
        // Backspace refine the search; everything else (bar the picker nav /
        // Escape handled above) is swallowed so the selection stays intact.
        if (aliasRef.current && wikilinkStateRef.current) {
          if (event.key === "Backspace") {
            event.preventDefault();
            aliasQueryRef.current = aliasQueryRef.current.slice(0, -1);
            setAliasPickerState(aliasQueryRef.current);
            return true;
          }
          if (
            event.key.length === 1 &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            aliasQueryRef.current += event.key;
            setAliasPickerState(aliasQueryRef.current);
            return true;
          }
          event.preventDefault();
          return true;
        }
        // Daily notes that aren't outlines swallow Tab (flat stream of
        // thoughts). In outline mode Tab/Shift+Tab nest via the list keymap.
        if (
          timestampedListItems &&
          mode !== "outline" &&
          handleListIndentShortcut(event)
        ) {
          return true;
        }
        if (
          timestampedListItems &&
          event.key === "-" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          editorRef.current &&
          insertTimestampedHorizontalRule(editorRef.current)
        ) {
          event.preventDefault();
          return true;
        }
        if (
          timestampedListItems &&
          event.key === " " &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          editorRef.current &&
          nestTimestampedListMarker(editorRef.current)
        ) {
          event.preventDefault();
          return true;
        }
        if (timestampedListItems && handleTimestampedListEnter(event, editorRef.current)) {
          return true;
        }
        if (
          mode === "outline" &&
          event.key === "Tab" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          editorRef.current?.state.selection.empty
        ) {
          event.preventDefault();
          editorRef.current.commands.sinkListItem("listItem");
          return true;
        }
        if (
          mode === "outline" &&
          event.key === "Tab" &&
          event.shiftKey &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          editorRef.current?.state.selection.empty &&
          outdentNestedListItem(editorRef.current)
        ) {
          event.preventDefault();
          return true;
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === "a" &&
          editorRef.current
        ) {
          event.preventDefault();
          return editorRef.current.commands.selectAll();
        }
        if (
          mode === "outline" &&
          event.metaKey &&
          event.key === "Backspace" &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          editorRef.current
        ) {
          event.preventDefault();
          deleteListItemTextBeforeCursor(editorRef.current) ||
            deleteEmptyListItem(editorRef.current);
          return true;
        }
        if (
          mode === "outline" &&
          (event.key === "Backspace" || event.key === "Delete") &&
          !editorRef.current?.state.selection.empty &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          editorRef.current
        ) {
          event.preventDefault();
          editorRef.current.commands.deleteSelection();
          return true;
        }
        if (
          mode === "outline" &&
          (event.key === "Backspace" || event.key === "Delete") &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          editorRef.current &&
          deleteEmptyListItem(editorRef.current)
        ) {
          event.preventDefault();
          return true;
        }
        if (
          mode === "outline" &&
          event.key === "Backspace" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          editorRef.current &&
          outdentListItemAtStart(editorRef.current)
        ) {
          event.preventDefault();
          return true;
        }
        if (handleBlockArrowNavigation(view, event)) {
          return true;
        }
        if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
          (view.dom as HTMLElement).blur();
          return true;
        }
        if (
          event.key === "[" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.altKey
        ) {
          const { state } = view;
          const { selection } = state;
          if (!selection.empty) {
            const text = state.doc
              .textBetween(selection.from, selection.to, " ")
              .trim();
            // Reject empty text or text that already contains brackets — not
            // a clean alias target.
            if (text && !/[[\]\n]/.test(text)) {
              event.preventDefault();
              openAliasPicker(text, selection.from, selection.to);
              return true;
            }
          }
        }
        return false;
      },
      // Paste an image from the clipboard — handled before ProseMirror's
      // default text/HTML paste so we don't end up with a stray base64
      // string in the document.
      handlePaste(_view, event) {
        const items = event.clipboardData?.items;
        if (items) {
          for (const item of items) {
            if (item.kind === "file" && item.type.startsWith("image/")) {
              const file = item.getAsFile();
              if (!file) continue;
              event.preventDefault();
              void insertImage(file);
              return true;
            }
          }
        }
        // Rich clipboard content carries a text/html flavor. Let Tiptap's
        // normal ProseMirror parser own it so headings, emphasis, lists,
        // links, and tables survive a copy/paste. The custom paths below are
        // deliberately plain-text normalization for terminal/email wrapping.
        const hasRichText = Boolean(
          event.clipboardData?.getData("text/html").trim(),
        );
        if (hasRichText) return false;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        const liveEditor = editorRef.current;
        // Paste a URL while text is selected → turn the selection into an
        // external link instead of replacing it with the raw URL. Must run
        // before the plain-text handlers below, which would otherwise consume
        // the paste and overwrite the selection. (Tiptap's own linkOnPaste
        // never gets a turn because this editor owns handlePaste.)
        if (text && liveEditor && linkSelectionWithPastedUrl(liveEditor, text)) {
          event.preventDefault();
          return true;
        }
        // In list-shaped notes, ProseMirror's default paste turns blank-line
        // paragraphs into multiple paragraphs inside one <li>. Woodshed's
        // dash/outline notes expect those paragraphs to become sibling rows.
        if (
          text &&
          liveEditor &&
          insertPlainTextParagraphsAsListItems(liveEditor, text)
        ) {
          event.preventDefault();
          return true;
        }
        if (text && liveEditor && insertNormalizedPlainTextPaste(liveEditor, text)) {
          event.preventDefault();
          return true;
        }
        return false;
      },
      handleDrop(_view, event, _slice, moved) {
        // Internal drags (selected text moved within the doc) come through
        // with `moved=true` — let ProseMirror's default handler run.
        if (moved) return false;
        const dt = (event as DragEvent).dataTransfer;
        if (!dt || dt.files.length === 0) return false;
        const file = Array.from(dt.files).find((f) =>
          f.type.startsWith("image/"),
        );
        if (!file) return false;
        event.preventDefault();
        void insertImage(file, {
          coords: {
            x: (event as DragEvent).clientX,
            y: (event as DragEvent).clientY,
          },
        });
        return true;
      },
    },
    onCreate: ({ editor }) => {
      // Outline mode: wrap loose top-level content (paragraphs, headings,
      // code blocks, blockquotes) into bulletList > listItem so the doc
      // is a Roam-style outline from the first frame. Lossless — switching
      // back to freeform leaves the markdown as `- thing` which renders as
      // a list anywhere.
      if (mode === "outline") {
        normalizeToOutline(editor);
        parseCollapsedMarkers(editor);
        removeGeneratedTrailingEmptyBullet(editor);
      }
      // The initial markdown parse leaves YouTube / Twitter URLs as plain
      // links. Convert any URL-only paragraph into the matching embed.
      replaceUrlParagraphsWithEmbeds(editor);
      const md = (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
      lastMarkdownRef.current = md;
      latestMarkdownRef.current = md;
      createdRef.current = true;
    },
    onUpdate: ({ editor }) => {
      // Same transform after every change — catches the case where the
      // user types or pastes a URL on its own line and presses Enter.
      // Debounced so continuous typing never pays for the doc walk.
      scheduleEmbedTransform(editor);
      if (createdRef.current) {
        scheduleAutosave(editor);
      }
    },
    onTransaction: ({ transaction }) => {
      const target = pendingImagePickerTargetRef.current;
      if (!target || !transaction.docChanged) return;
      if ("range" in target) {
        pendingImagePickerTargetRef.current = {
          range: {
            from: transaction.mapping.map(target.range.from, 1),
            to: transaction.mapping.map(target.range.to, -1),
          },
        };
      } else {
        pendingImagePickerTargetRef.current = {
          pos: transaction.mapping.map(target.pos, 1),
        };
      }
    },
    onBlur: ({ editor }) => {
      // Fire-and-forget — host's save runs in the background. The
      // wikilink click handler uses the same helper but awaits it before
      // navigating so unsaved edits aren't stranded by an immediate route
      // change.
      void commitEditorIfDirty(editor);
    },
  });

  // Keep a stable ref to the live editor so callbacks declared above
  // `useEditor` (insertImage, etc) can read it without a re-render dance.
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (!focusOnEnter || !editor) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key !== "Enter") return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }
      if (isEditableElement(event.target)) return;
      event.preventDefault();
      editor?.commands.focus("end");
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [editor, focusOnEnter]);

  // The /image slash command dispatches a synthetic `tiptap-open-image-picker`
  // event on the editor DOM; we listen here and pop the OS file picker.
  // Routing it through the picker keeps the upload codepath in React land
  // (where the `onUploadImage` hook lives) instead of inside the extension.
  useEffect(() => {
    const dom = editorHostRef.current;
    if (!dom) return;
    function onOpenPicker(event: Event) {
      pendingImagePickerTargetRef.current = imagePickerTarget(event);
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void insertImage(file, { usePendingPickerTarget: true });
        else pendingImagePickerTargetRef.current = null;
      };
      input.addEventListener(
        "cancel",
        () => {
          pendingImagePickerTargetRef.current = null;
        },
        { once: true },
      );
      input.click();
    }
    dom.addEventListener("tiptap-open-image-picker", onOpenPicker);
    return () => {
      dom.removeEventListener("tiptap-open-image-picker", onOpenPicker);
    };
  }, [insertImage]);

  // Click-to-navigate on wikilink atoms. The atom renders as
  // `<a class="tiptap-wikilink" data-text="…">` with no href, so the
  // browser does nothing by default — ProseMirror would otherwise place
  // a NodeSelection on the atom. We intercept plain clicks on RESOLVED
  // wikilinks and route via the router. Shift+click opens the target in the
  // references sidebar; Shift+Cmd/Ctrl+click opens it in a new tab. Editor
  // wikilinks carry no href, so the document-level link handlers cannot
  // catch them.
  useEffect(() => {
    if (!editor) return;
    const liveEditor = editor;
    const host = editorHostRef.current;
    if (!host) return;
    const dom: HTMLDivElement = host;
    async function onClick(event: MouseEvent) {
      if (event.button !== 0) return;
      if (event.altKey) return;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey) return;
      const newTab = event.shiftKey && (event.metaKey || event.ctrlKey);
      const reference = event.shiftKey && !event.metaKey && !event.ctrlKey;
      const target = event.target as HTMLElement | null;
      // Real <a href> links (from the Link extension) open in the system
      // browser on a plain click — same activate-on-plain-click convention as
      // wikilinks. Modified clicks (cmd/ctrl/shift, already partly gated above)
      // fall through to the editor so the caret can land in the link text.
      // Wikilink atoms carry no href, so they never match here.
      const externalLink = target?.closest<HTMLElement>("a[href]");
      if (
        externalLink &&
        dom.contains(externalLink) &&
        !event.shiftKey &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        const href = externalLink.getAttribute("href")?.trim();
        if (href && isExternalHref(href)) {
          event.preventDefault();
          event.stopPropagation();
          void openExternalUrl(href).catch(() => {
            // Keep user-authored URLs and native integration errors out of logs.
            console.error("Woodshed could not open the external link.");
          });
          return;
        }
      }
      const link = target?.closest<HTMLElement>("a.tiptap-wikilink");
      if (!link || !dom.contains(link)) return;
      const display = link.getAttribute("data-text") ?? link.textContent ?? "";
      // Aliased links resolve by their target, not the displayed text.
      const aliasTarget = link.getAttribute("data-target");
      const resolveKey = aliasTarget?.trim() || display;
      if (!resolveKey.trim()) return;
      const resolved = resolveWikilink(resolveKey);
      if (!resolved) {
        // Useful diagnostic: link in editor was clicked but the resolver
        // cache doesn't know about it. Usually means the target file hasn't
        // been indexed yet — try Settings → Vault → Reset & re-scan.
        // eslint-disable-next-line no-console
        console.warn(`[wikilink] unresolved click: [[${resolveKey}]]`);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Flush any unsaved edits BEFORE navigating. Previously we relied on
      // `liveEditor.commands.blur()` to trigger onBlur → onCommit, then
      // immediately called `navigate(...)`. That has a race: React Query's
      // `mutate` is non-blocking, so the route change tore down the host
      // component (and the editor) before the Tauri save command actually
      // ran, and the user's edits — including the very wikilink they just
      // clicked — never reached disk. Awaiting the shared commit path here
      // pins the file write to before navigation. A new-tab open still
      // changes the active route (tabs share one router), so the same
      // flush applies.
      try {
        await commitEditorIfDirty(liveEditor);
      } catch (err) {
        // Don't block navigation on a save failure — the host's mutation
        // will surface the error through its own channels. Log so we
        // notice in dev / the diagnostics log.
        // eslint-disable-next-line no-console
        console.error("[wikilink] commit-before-navigate failed", err);
      }
      // resolved.href is a wikilink-resolved string (`/people/<id>`,
      // `/notebook/<id>`, etc.) — use `href` so TanStack Router parses
      // it rather than matching against the typed route registry.
      if (newTab) {
        openInNewTab(resolved.href);
      } else if (reference) {
        addPage({ href: resolved.href, title: resolved.label });
      } else {
        void navigate({ href: resolved.href });
      }
    }
    dom.addEventListener("click", onClick);
    return () => {
      dom.removeEventListener("click", onClick);
    };
  }, [editor, navigate, openInNewTab, addPage, commitEditorIfDirty]);

  // External value changes (e.g. file watcher) flow back in through props;
  // skip only when the focused editor has local dirty edits. If the editor is
  // focused but unchanged, accept the external value so a stale instance can't
  // later blur and save old markdown over newer file/query content.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const currentMarkdown = (
      editor.storage as unknown as { markdown: MarkdownStorage }
    ).markdown.getMarkdown();
    if (value === currentMarkdown) {
      lastMarkdownRef.current = value;
      latestMarkdownRef.current = value;
      ingestedValueRef.current = value;
      if (queuedMarkdownRef.current === value) {
        queuedMarkdownRef.current = null;
      }
      return;
    }
    if (editorValue === currentMarkdown) {
      lastMarkdownRef.current = editorValue;
      latestMarkdownRef.current = editorValue;
      ingestedValueRef.current = editorValue;
      if (queuedMarkdownRef.current === editorValue) {
        queuedMarkdownRef.current = null;
      }
      return;
    }
    if (editorValue === lastMarkdownRef.current) return;
    // Already loaded this exact external value — the difference between it
    // and getMarkdown() is in-editor normalization (URL→embed conversion,
    // whitespace), not a file change. Reloading would churn the doc on every
    // render and re-mark normalization as a dirty edit.
    if (editorValue === ingestedValueRef.current) return;
    // Daily saves deliberately strip abandoned empty timestamp bullets before
    // writing to disk. When that stripped DTO echoes back while the editor is
    // focused, keep the live blank row in place so the user can outdent/type
    // into it instead of having the caret remapped to the previous bullet.
    if (
      timestampedListItems &&
      editor.isFocused &&
      currentMarkdown !== editorValue &&
      sameOutlineMarkdownIgnoringListSpacing(
        stripEmptyTimestampBulletsFromMarkdown(currentMarkdown),
        editorValue,
      )
    ) {
      lastMarkdownRef.current = currentMarkdown;
      latestMarkdownRef.current = currentMarkdown;
      ingestedValueRef.current = editorValue;
      if (
        queuedMarkdownRef.current === currentMarkdown ||
        queuedMarkdownRef.current === editorValue
      ) {
        queuedMarkdownRef.current = null;
      }
      return;
    }
    // Any local dirty edit wins over an incoming prop value, even if focus was
    // briefly lost to editor chrome or a node view. Self-saves update React
    // Query with the just-saved body; applying that as "external" content
    // would tear down and rebuild the ProseMirror doc while the user is typing.
    if (currentMarkdown !== lastMarkdownRef.current) return;
    const wasFocused = editor.isFocused;
    const selection = editor.state.selection;
    clearAutosaveTimer();
    queuedMarkdownRef.current = null;
    lastMarkdownRef.current = editorValue;
    latestMarkdownRef.current = editorValue;
    ingestedValueRef.current = editorValue;
    editor.commands.setContent(editorValue, { emitUpdate: false });
    if (wasFocused && selection instanceof TextSelection) {
      try {
        const pos = Math.min(selection.from, editor.state.doc.content.size);
        editor.view.dispatch(
          editor.state.tr.setSelection(
            TextSelection.near(editor.state.doc.resolve(pos), -1),
          ),
        );
        editor.view.focus();
      } catch {
        // If the external edit moved the caret into a non-text position,
        // ProseMirror's default post-setContent selection is safer.
      }
    }
    // Outline structure + collapse markers must settle synchronously, before
    // the browser paints. Markdown parsing leaves the `<!-- collapsed -->` fold
    // markers as trailing TEXT (parseCollapsedMarkers lifts them into the fold
    // attribute and strips them); deferring that pass lets the raw marker text
    // flash visibly for a frame on every value sync. These are plain
    // structure/attribute transactions (no React node-views), so running them
    // inline here is as safe as the setContent above — and matches what
    // onCreate already does on first mount.
    if (mode === "outline") {
      normalizeToOutline(editor);
      parseCollapsedMarkers(editor);
      removeGeneratedTrailingEmptyBullet(editor);
    }
    // Defer only the embed transform: it mounts React node-views (YouTube /
    // Twitter), and dispatching that from inside an effect can trigger
    // flushSync while React is still rendering.
    queueMicrotask(() => {
      if (editor.isDestroyed) return;
      replaceUrlParagraphsWithEmbeds(editor);
      // Rebase the clean baseline onto the post-transform serialization.
      // Loading a file is not an edit: without this, the embed conversion
      // and markdown normalization leave getMarkdown() ≠ lastMarkdownRef,
      // and the next blur/unmount/autosave silently rewrites the file the
      // user only ever opened. Safe to do here — microtasks run before any
      // user input event can dirty the doc.
      const md = (
        editor.storage as unknown as { markdown: MarkdownStorage }
      ).markdown.getMarkdown();
      lastMarkdownRef.current = md;
      latestMarkdownRef.current = md;
    });
  }, [value, editorValue, editor, mode, clearAutosaveTimer]);

  return (
    <div
      ref={editorHostRef}
      className="relative"
      data-tiptap-wrapper
      {...(scrollPastEnd ? {} : { "data-no-scroll-past-end": "" })}
    >
      <EditorContent editor={editor} />
      {slashState && (
        <SlashCommandMenu ref={slashMenuRef} state={slashState} />
      )}
      {wikilinkState && (
        <WikilinkPicker ref={wikilinkPickerRef} state={wikilinkState} />
      )}
    </div>
  );
}

function clampInsertPos(editor: Editor, pos: number) {
  if (!Number.isFinite(pos)) return editor.state.selection.from;
  return Math.max(0, Math.min(Math.trunc(pos), editor.state.doc.content.size));
}

function clampInsertRange(
  editor: Editor,
  range: { from: number; to: number },
) {
  const from = clampInsertPos(editor, range.from);
  const to = clampInsertPos(editor, range.to);
  return from <= to ? { from, to } : { from: to, to: from };
}

function imagePickerTarget(
  event: Event,
): { range: { from: number; to: number } } | { pos: number } | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as
    | { range?: { from?: unknown; to?: unknown }; pos?: unknown }
    | null;
  if (
    typeof detail?.range?.from === "number" &&
    Number.isFinite(detail.range.from) &&
    typeof detail.range.to === "number" &&
    Number.isFinite(detail.range.to)
  ) {
    return { range: { from: detail.range.from, to: detail.range.to } };
  }
  return typeof detail?.pos === "number" && Number.isFinite(detail.pos)
    ? { pos: detail.pos }
    : null;
}

function handleTimestampedListEnter(
  event: KeyboardEvent,
  editor: Editor | null,
): boolean {
  if (!editor) return false;
  if (event.key !== "Enter") return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
    return false;
  }
  if (!selectionIsInsideNode(editor, "listItem")) return false;

  // A blank row is already ready for the next thought. It gets stamped
  // when the user types, so repeated Enter presses should not create a
  // stack of empty rows. The nested case is different: pressing Enter on
  // an empty child row means "come back out one level", matching normal
  // outline editors without letting the caret escape the bullet list.
  if (!currentListItemHasVisibleContent(editor)) {
    event.preventDefault();
    if (outdentEmptyNestedListItem(editor)) return true;
    return true;
  }

  if (insertTopLevelItemAfterChildren(editor)) {
    event.preventDefault();
    return true;
  }

  if (!editor.commands.splitListItem("listItem")) return false;
  event.preventDefault();
  return true;
}

function selectionIsInsideNode(editor: Editor, nodeName: string): boolean {
  const { $from, $to } = editor.state.selection;
  return (
    ancestorDepthByName($from, nodeName) !== null &&
    ancestorDepthByName($to, nodeName) !== null
  );
}

function currentListItemHasVisibleContent(editor: Editor): boolean {
  const depth = ancestorDepthByName(editor.state.selection.$from, "listItem");
  if (depth === null) return false;
  return listItemHasVisibleContent(editor.state.selection.$from.node(depth));
}

function ancestorDepthByName($pos: ResolvedPos, nodeName: string): number | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    if ($pos.node(depth).type.name === nodeName) return depth;
  }
  return null;
}

// ---- URL-only paragraph → embed transform ----

/**
 * Walk the doc once and replace recognized URL-only paragraphs (and, for
 * YouTube, the optional `#resource #youtube` prelude paragraph immediately
 * preceding the URL) with their corresponding embed nodes.
 *
 * The traversal collects top-level paragraph positions first, then applies
 * replacements bottom-up so earlier positions stay valid.
 *
 * On-disk shapes recognized:
 *   - "<youtube-url>"                                  → youtubeResource
 *   - "#resource #youtube\n\n<youtube-url>"            → youtubeResource (prelude consumed)
 *   - "<tweet-url>"                                    → twitter
 */
function replaceUrlParagraphsWithEmbeds(editor: Editor) {
  const { state } = editor;
  const { doc, schema } = state;

  type Para = {
    from: number;
    to: number;
    text: string;
    parent: PMNode | null;
    /** Child index within `parent`, for schema-validity checks. */
    index: number;
  };
  const paragraphs: Para[] = [];
  // Walk the doc collecting every paragraph regardless of nesting depth.
  // Outline mode wraps content inside `bulletList > listItem > paragraph`,
  // so a top-level-only walk would silently skip URL embeds in bullets.
  // Embeds (youtubeResource, twitter) are atom block nodes — descendants
  // never enter them, so the traversal is safe.
  //
  // We also track each paragraph's parent node so the prelude-collapse
  // below only fires when prelude + URL share the same parent (otherwise
  // replaceWith would span across two listItems and break the outline
  // schema). Identity comparison on the parent node is sufficient — and
  // dodges the `$pos.before(0)` error that fires for top-level paragraphs.
  doc.descendants((child, pos, parent) => {
    if (child.type.name !== "paragraph") return undefined;
    paragraphs.push({
      from: pos,
      to: pos + child.nodeSize,
      text: child.textContent.trim(),
      parent: parent ?? null,
      index: doc.resolve(pos).index(),
    });
    return false;
  });

  // A replacement is only safe where the embed node is legal in the parent's
  // content model. The one that bit hardest: a timestamped bullet's first (and
  // only) paragraph — listItem requires a paragraph first, so replacing
  // it forced ProseMirror's slice-fitter to improvise, which destroyed the
  // timestamp and emptied the bullet (the 2026-06-10 journal wipe). Checking
  // canReplaceWith up front means "convert where legal, leave the text alone
  // everywhere else" — no refitting, ever.
  const canHostEmbed = (p: Para, fromIndex: number, type: NodeType): boolean => {
    const parent = p.parent;
    if (!parent) return false;
    return parent.canReplaceWith(fromIndex, p.index + 1, type);
  };

  type Repl = { from: number; to: number; node: PMNode };
  const replacements: Repl[] = [];

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (!p.text) continue;

    // YouTube: optional `#resource #youtube` prelude on the previous
    // paragraph collapses with the URL into one wrapped node — but only
    // when both paragraphs share the same parent. In outline mode each
    // paragraph lives inside its own listItem, and a cross-listItem
    // replaceWith would break the schema.
    const yt = p.text.match(YOUTUBE_URL_RE);
    if (yt && yt[0] === p.text) {
      const ytType = schema.nodes.youtubeResource;
      if (ytType) {
        const prev = i > 0 ? paragraphs[i - 1] : null;
        const consumePrelude =
          prev &&
          prev.parent === p.parent &&
          YOUTUBE_RESOURCE_TAG_LINE_RE.test(prev.text) &&
          canHostEmbed(p, prev.index, ytType);
        if (consumePrelude) {
          replacements.push({
            from: prev!.from,
            to: p.to,
            node: ytType.create({ url: p.text, videoId: yt[1] }),
          });
        } else if (canHostEmbed(p, p.index, ytType)) {
          replacements.push({
            from: p.from,
            to: p.to,
            node: ytType.create({ url: p.text, videoId: yt[1] }),
          });
        }
      }
      continue;
    }

    const tw = p.text.match(TWEET_URL_RE);
    if (tw && tw[0] === p.text) {
      const twType = schema.nodes.twitter;
      if (twType && canHostEmbed(p, p.index, twType)) {
        replacements.push({
          from: p.from,
          to: p.to,
          node: twType.create({ url: p.text, tweetId: tw[2], handle: tw[1] }),
        });
      }
      continue;
    }
  }

  if (replacements.length === 0) return;

  let tr = state.tr;
  // Apply in reverse so positions earlier in the doc are unaffected by the
  // splices we already performed.
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    tr = tr.replaceWith(r.from, r.to, r.node);
  }
  if (!tr.docChanged) return;
  // Leave ProseMirror's mapped selection alone. Forcing the selection to the
  // end of the document makes a lower embed conversion steal the caret from
  // text the user is editing above it.
  editor.view.dispatch(tr);
}
