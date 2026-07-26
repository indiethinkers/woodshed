import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { TwitterEmbed } from "./twitter-embed";

export function TwitterView({ node }: NodeViewProps) {
  const url = node.attrs.url as string | null;
  const tweetId = node.attrs.tweetId as string | null;
  const handle = node.attrs.handle as string | null;

  return (
    <NodeViewWrapper
      data-tweet-id={tweetId ?? ""}
      data-tweet-url={url ?? ""}
      data-drag-handle=""
    >
      <TwitterEmbed tweetId={tweetId} url={url} handle={handle} />
    </NodeViewWrapper>
  );
}
