import { openExternalUrl } from "@/lib/open-external";

interface TwitterEmbedProps {
  tweetId: string | null;
  url: string | null;
  handle?: string | null;
}

async function openTweetUrl(url: string) {
  await openExternalUrl(url);
}

export function TwitterEmbed({ tweetId, url, handle }: TwitterEmbedProps) {
  if (!tweetId || !url) {
    return (
      <div className="twitter-embed-fallback">
        <span>Invalid X post URL</span>
      </div>
    );
  }

  return (
    <div className="twitter-embed-shell" contentEditable={false}>
      <TwitterFallback url={url} handle={handle} />
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
  url,
  handle,
}: {
  url: string;
  handle?: string | null;
}) {
  return (
    <div className="twitter-embed-fallback">
      <span className="twitter-embed-fallback__mark">X</span>
      <span className="twitter-embed-fallback__body">
        <span className="twitter-embed-fallback__title">View post on X</span>
        {handle && (
          <span className="twitter-embed-fallback__meta">@{handle}</span>
        )}
      </span>
    </div>
  );
}
