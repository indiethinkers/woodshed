import { openExternalUrl } from "@/lib/open-external";
import { useAllResources, useResourceMutations } from "@/lib/hooks/use-resources";

interface TwitterEmbedProps {
  tweetId: string | null;
  url: string | null;
  handle?: string | null;
}

async function openTweetUrl(url: string) {
  await openExternalUrl(url);
}

export function TwitterEmbed({ tweetId, url, handle }: TwitterEmbedProps) {
  // Tweet rendering stays local: resource capture fetches oEmbed only when
  // the user pastes the URL, then this card reads that durable metadata from
  // the vault. That gives an embed its actual post text without loading X
  // scripts, frames, or trackers every time a note opens.
  const { data: resources = [] } = useAllResources();
  const { capture } = useResourceMutations();
  const resource = url ? resources.find((entry) => entry.url === url) : undefined;
  const preview = resource?.title;
  const canRefreshPreview = Boolean(
    resource && preview && /(?:…|\.\.\.)\s*$/.test(preview),
  );
  if (!tweetId || !url) {
    return (
      <div className="twitter-embed-fallback">
        <span>Invalid X post URL</span>
      </div>
    );
  }

  return (
    <div className="twitter-embed-shell" contentEditable={false}>
      <TwitterFallback preview={preview} url={url} handle={handle} />
      {canRefreshPreview && (
        <button
          type="button"
          className="twitter-embed-refresh"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            capture.mutate({
              url,
              tags: ["twitter"],
              skipDailyLog: true,
              refresh: true,
            });
          }}
        >
          {capture.isPending ? "Refreshing…" : "Refresh full preview"}
        </button>
      )}
      <button
        type="button"
        className="twitter-embed-hit-target"
        aria-label={`Open X post${handle ? ` by @${handle}` : ""}`}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void openTweetUrl(url).catch((err) => {
            console.error("Failed to open X post", url, err);
          });
        }}
      />
    </div>
  );
}

function TwitterFallback({
  preview,
  url,
  handle,
}: {
  preview?: string;
  url: string;
  handle?: string | null;
}) {
  return (
    <div className="twitter-embed-fallback">
      <span className="twitter-embed-fallback__mark">X</span>
      <span className="twitter-embed-fallback__body">
        <span className="twitter-embed-fallback__title">
          {preview || "View post on X"}
        </span>
        {handle && (
          <span className="twitter-embed-fallback__meta">@{handle}</span>
        )}
      </span>
    </div>
  );
}
