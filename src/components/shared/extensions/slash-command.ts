import { Extension, type Range } from "@tiptap/core";
import { Suggestion, type SuggestionOptions } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import type { LucideIcon } from "lucide-react";
import {
  Image as ImageIcon,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Minus,
  Code,
  Type,
} from "lucide-react";

export interface SlashCommandItem {
  id: string;
  title: string;
  description?: string;
  keywords: string;
  icon: LucideIcon;
  command: (props: { editor: Editor; range: Range }) => void;
}

function setSectionHeader(editor: Editor, range: Range) {
  const chain = editor.chain().focus().deleteRange(range);
  if (editor.isActive("listItem")) {
    chain.liftListItem("listItem").setNode("sectionHeader").run();
    return;
  }
  chain.setNode("sectionHeader").run();
}

export const slashCommandItems: SlashCommandItem[] = [
  {
    id: "text",
    title: "Text",
    description: "Plain paragraph.",
    keywords: "text paragraph plain p",
    icon: Type,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setNode("paragraph").run();
    },
  },
  {
    id: "h1",
    title: "Heading 1",
    description: "Big section heading.",
    keywords: "h1 heading title large",
    icon: Heading1,
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 1 })
        .run();
    },
  },
  {
    id: "h2",
    title: "Heading 2",
    description: "Medium section heading.",
    keywords: "h2 heading subtitle",
    icon: Heading2,
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 2 })
        .run();
    },
  },
  {
    id: "h3",
    title: "Heading 3",
    description: "Small section heading.",
    keywords: "h3 heading",
    icon: Heading3,
    command: ({ editor, range }) => {
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .setNode("heading", { level: 3 })
        .run();
    },
  },
  {
    id: "section-header",
    title: "Section header",
    description: "Label with a horizontal rule.",
    keywords: "section header divider label rule notes schedule",
    icon: Heading2,
    command: ({ editor, range }) => {
      setSectionHeader(editor, range);
    },
  },
  {
    id: "bullet-list",
    title: "Bulleted list",
    description: "Simple bulleted list.",
    keywords: "bullet list ul unordered",
    icon: List,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBulletList().run();
    },
  },
  {
    id: "ordered-list",
    title: "Numbered list",
    description: "List with numbers.",
    keywords: "ordered list ol numbered",
    icon: ListOrdered,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleOrderedList().run();
    },
  },
  {
    id: "task-list",
    title: "To-do list",
    description: "Track tasks with checkboxes.",
    keywords: "todo task checklist checkbox",
    icon: ListTodo,
    command: ({ editor, range }) => {
      const can = editor.can() as unknown as { toggleTaskList?: () => boolean };
      if (typeof can.toggleTaskList === "function") {
        (editor.chain().focus().deleteRange(range) as unknown as {
          toggleTaskList: () => { run: () => void };
        })
          .toggleTaskList()
          .run();
      } else {
        editor.chain().focus().deleteRange(range).toggleBulletList().run();
      }
    },
  },
  {
    id: "quote",
    title: "Quote",
    description: "Capture a quote.",
    keywords: "quote blockquote",
    icon: Quote,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleBlockquote().run();
    },
  },
  {
    id: "divider",
    title: "Divider",
    description: "Visual separator between sections.",
    keywords: "divider hr horizontal rule line",
    icon: Minus,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setHorizontalRule().run();
    },
  },
  {
    id: "code",
    title: "Inline code",
    description: "Wrap selection in inline code.",
    keywords: "code inline mono",
    icon: Code,
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).toggleCode().run();
    },
  },
  {
    id: "image",
    title: "Image",
    description: "Upload or embed an image.",
    keywords: "image picture photo media upload",
    icon: ImageIcon,
    command: ({ editor, range }) => {
      // Keep the slash trigger in place while the native file picker is open.
      // If we delete it now, the user sees the current block vanish before
      // they have picked a file. The editor host replaces this exact range
      // with the image only after a file is selected.
      editor.view.dom.dispatchEvent(
        new CustomEvent("tiptap-open-image-picker", {
          bubbles: true,
          detail: { range },
        }),
      );
    },
  },
];

export const SlashCommandPluginKey = new PluginKey("slash-command");

export interface SlashCommandOptions {
  suggestion: Omit<SuggestionOptions<SlashCommandItem>, "editor">;
}

/**
 * Slash-command extension. Triggered by `/` at the start of a line or
 * after whitespace. Filters `slashCommandItems` by query and delegates
 * rendering to a React popup wired up in `TiptapEditor`.
 */
export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: "slashCommand",

  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        allowAreas: false,
        pluginKey: SlashCommandPluginKey,
        command: ({ editor, range, props }) => {
          props.command({ editor, range });
        },
        items: ({ query }) => {
          const q = query.trim().toLowerCase();
          if (!q) return slashCommandItems;
          return slashCommandItems.filter((item) => {
            return (
              item.title.toLowerCase().includes(q) ||
              item.keywords.toLowerCase().includes(q)
            );
          });
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommandItem>({
        editor: this.editor,
        ...this.options.suggestion,
      }),
    ];
  },
});
