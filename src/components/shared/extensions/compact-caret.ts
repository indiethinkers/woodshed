import { Extension } from "@tiptap/core";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "@tiptap/pm/state";

type CompactCaretState = {
  focused: boolean;
  composing: boolean;
};

const compactCaretKey = new PluginKey<CompactCaretState>("compactCaret");

function shouldShowCompactCaret(state: EditorState) {
  const pluginState = compactCaretKey.getState(state);
  const { selection } = state;
  return Boolean(
    pluginState?.focused &&
      !pluginState.composing &&
      selection.empty &&
      selection instanceof TextSelection &&
      selection.$from.parent.inlineContent,
  );
}

function createCompactCaretElement() {
  const el = document.createElement("span");
  el.className = "tiptap-compact-caret";
  el.setAttribute("aria-hidden", "true");
  el.hidden = true;
  return el;
}

/**
 * WebKit sizes the native contenteditable caret to the current line box.
 * Woodshed prose uses generous leading, so the native caret can look much
 * taller than the glyphs. Draw a font-sized overlay caret instead of a
 * ProseMirror widget: inline widgets become extra wrapping boundaries in
 * WebKit, which can make words reflow around the cursor.
 */
export const CompactCaret = Extension.create({
  name: "compactCaret",

  addProseMirrorPlugins() {
    return [
      new Plugin<CompactCaretState>({
        key: compactCaretKey,
        state: {
          init: () => ({ focused: false, composing: false }),
          apply(tr, value) {
            const meta = tr.getMeta(compactCaretKey) as
              | Partial<CompactCaretState>
              | undefined;
            return meta ? { ...value, ...meta } : value;
          },
        },
        props: {
          handleDOMEvents: {
            focus(view) {
              view.dispatch(
                view.state.tr.setMeta(compactCaretKey, { focused: true }),
              );
              return false;
            },
            blur(view) {
              view.dispatch(
                view.state.tr.setMeta(compactCaretKey, { focused: false }),
              );
              return false;
            },
            compositionstart(view) {
              view.dispatch(
                view.state.tr.setMeta(compactCaretKey, { composing: true }),
              );
              return false;
            },
            compositionend(view) {
              view.dispatch(
                view.state.tr.setMeta(compactCaretKey, { composing: false }),
              );
              return false;
            },
          },
        },
        view(view) {
          const wrapper = view.dom.parentElement;
          const caret = createCompactCaretElement();
          wrapper?.appendChild(caret);

          let applied: boolean | null = null;
          let raf = 0;

          function setOverlayActive(active: boolean) {
            if (active === applied) return;
            applied = active;
            view.dom.classList.toggle("tiptap-compact-caret-active", active);
            caret.hidden = !active;
          }

          function positionCaret() {
            if (!wrapper) throw new Error("Missing editor wrapper");
            const fontSize = parseFloat(getComputedStyle(view.dom).fontSize);
            const caretHeight = Number.isFinite(fontSize) ? fontSize : 16;
            const coords = view.coordsAtPos(view.state.selection.from);
            const wrapperRect = wrapper.getBoundingClientRect();
            const top =
              coords.top -
              wrapperRect.top +
              Math.max(0, coords.bottom - coords.top - caretHeight) / 2;
            const left = coords.left - wrapperRect.left;
            if (!Number.isFinite(top) || !Number.isFinite(left)) {
              throw new Error("Invalid caret coordinates");
            }
            const maxTop = wrapperRect.height + caretHeight;
            const maxLeft = wrapperRect.width + 4;
            if (top < -caretHeight || top > maxTop || left < -4 || left > maxLeft) {
              throw new Error("Caret coordinates outside editor");
            }
            caret.style.height = `${caretHeight}px`;
            caret.style.transform = `translate3d(${left}px, ${top}px, 0)`;
          }

          function sync() {
            raf = 0;
            if (!shouldShowCompactCaret(view.state)) {
              setOverlayActive(false);
              return;
            }
            try {
              positionCaret();
              setOverlayActive(true);
            } catch {
              setOverlayActive(false);
            }
          }

          function scheduleSync() {
            if (raf) cancelAnimationFrame(raf);
            raf = requestAnimationFrame(sync);
          }

          scheduleSync();
          window.addEventListener("resize", scheduleSync);
          return {
            update: scheduleSync,
            destroy() {
              if (raf) cancelAnimationFrame(raf);
              window.removeEventListener("resize", scheduleSync);
              caret.remove();
              view.dom.classList.remove("tiptap-compact-caret-active");
            },
          };
        },
      }),
    ];
  },
});
