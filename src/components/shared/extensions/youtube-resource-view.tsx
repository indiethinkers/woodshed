import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { GripVertical, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { YoutubeFacade } from "./youtube-facade";

/// React NodeView for `youtubeResource`: a bare, responsive nocookie player.
/// The same player renders in the read-only `Markdown` path so the editor and
/// sidebar/mail views look identical.
///
/// No surrounding card chrome (title / tag pills) — the video stands on its
/// own. The `#resource #youtube` tags still live in the markdown source for
/// indexing; they're just not surfaced as decoration here.
export function YoutubeResourceView(props: NodeViewProps) {
  const { deleteNode, getPos, node, selected, view } = props;
  const url = node.attrs.url as string | null;
  const videoId = node.attrs.videoId as string | null;

  function handleSelect(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const pos = getPos();
    if (typeof pos !== "number") return;
    view.dispatch(
      view.state.tr
        .setSelection(NodeSelection.create(view.state.doc, pos))
        .scrollIntoView(),
    );
    view.focus();
  }

  function handleDelete(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    deleteNode();
  }

  if (!url || !videoId) {
    return (
      <NodeViewWrapper
        data-youtube-resource=""
        data-selected={selected ? "true" : undefined}
      >
        <div className="my-3 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
          Invalid YouTube URL
        </div>
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      data-youtube-resource=""
      data-selected={selected ? "true" : undefined}
      className={cn(
        "group/editor-youtube relative rounded-md",
        selected && "is-selected",
      )}
    >
      <YoutubeFacade
        url={url}
        videoId={videoId}
        controlsVisible={selected}
        controls={
          <>
            <button
              type="button"
              aria-label="Select YouTube embed"
              title="Select YouTube embed"
              onMouseDown={handleSelect}
              className="inline-flex size-7 items-center justify-center rounded-[5px] transition-colors hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/20"
            >
              <GripVertical className="size-3.5" strokeWidth={2} />
            </button>
            <button
              type="button"
              aria-label="Delete YouTube embed"
              title="Delete YouTube embed"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={handleDelete}
              className="inline-flex size-7 items-center justify-center rounded-[5px] transition-colors hover:bg-black/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-black/20"
            >
              <Trash2 className="size-3.5" strokeWidth={2} />
            </button>
          </>
        }
      />
    </NodeViewWrapper>
  );
}
