export const TWEET_URL_RE =
  /https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/([^/\s]+)\/status(?:es)?\/(\d+)(?:\?\S*)?/i;

export function tweetUrlParts(url: string): {
  handle: string;
  tweetId: string;
} | null {
  const match = url.match(TWEET_URL_RE);
  if (!match || match[0] !== url.trim()) return null;
  return {
    handle: match[1],
    tweetId: match[2],
  };
}
