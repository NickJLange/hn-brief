import type { AlgoliaHit, FetchLike } from "../../shared/summarizer-core";
import type { ArticleSource } from "./types";

export interface ArticleResult {
  source: ArticleSource;
  markdown?: string;
  error?: string;
}

const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";
const PAGE_TIMEOUT_MS = 30_000;
// Firecrawl's free plan allows 10 scrapes a minute.
const MIN_INTERVAL_MS = 6_500;

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
}

const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API = "https://oauth.reddit.com";
const REDDIT_USER_AGENT = "linux:hn-brief:1.0 (personal daily digest)";
const REDDIT_TOP_COMMENTS = 10;

function isRedditHost(url: string): boolean {
  try {
    return /(^|\.)reddit\.com$|^redd\.it$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** The post ID of a reddit.com /comments/<id> or redd.it/<id> link, or undefined for any other URL. */
export function redditPostId(url: string): string | undefined {
  try {
    const { hostname, pathname } = new URL(url);
    if (/(^|\.)reddit\.com$/i.test(hostname)) return /\/comments\/([a-z0-9]+)/i.exec(pathname)?.[1];
    if (/^redd\.it$/i.test(hostname)) return /^\/([a-z0-9]+)\/?$/i.exec(pathname)?.[1];
  } catch {}
  return undefined;
}

interface RedditThing { kind: string; data: Record<string, any> }

function formatRedditPost(listings: Array<{ data: { children: RedditThing[] } }>): string | undefined {
  const post = listings[0]?.data.children[0]?.data;
  if (!post) return undefined;
  const lines = [`# ${post.title}`, "", `Posted in r/${post.subreddit} by u/${post.author} (score ${post.score}).`];
  if (!post.is_self && post.url) lines.push(`Linked URL: ${post.url}`);
  if (post.selftext?.trim()) lines.push("", post.selftext.trim());
  const comments = (listings[1]?.data.children ?? [])
    .filter(c => c.kind === "t1" && c.data.body && c.data.body !== "[deleted]" && c.data.body !== "[removed]")
    .sort((a, b) => b.data.score - a.data.score)
    .slice(0, REDDIT_TOP_COMMENTS);
  if (comments.length) {
    lines.push("", "## Top Reddit comments");
    for (const c of comments) lines.push("", `u/${c.data.author} (score ${c.data.score}):`, c.data.body.trim());
  }
  return lines.join("\n");
}

/** Reads a Reddit post and its top comments through the official API, with an app-only token reused until it expires. */
function createRedditReader(credentials: RedditCredentials, fetcher: FetchLike) {
  let token: { value: string; expiresAt: number } | undefined;
  const getToken = async () => {
    if (token && Date.now() < token.expiresAt) return token.value;
    const response = await fetcher(REDDIT_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": REDDIT_USER_AGENT
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
    });
    const body = (await response.json().catch(() => undefined)) as { access_token?: string; expires_in?: number } | undefined;
    if (!response.ok || !body?.access_token) throw new Error(`Reddit token HTTP ${response.status}`);
    // Renew a minute early so a token never expires mid-request.
    token = { value: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
    return token.value;
  };
  return async (postId: string): Promise<ArticleResult> => {
    try {
      const response = await fetcher(`${REDDIT_API}/comments/${postId}?raw_json=1&sort=top&depth=1&limit=${REDDIT_TOP_COMMENTS * 3}`, {
        headers: { Authorization: `Bearer ${await getToken()}`, "User-Agent": REDDIT_USER_AGENT },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS)
      });
      if (!response.ok) return { source: "fetch_failed", error: `Reddit HTTP ${response.status}` };
      const markdown = formatRedditPost(await response.json());
      return markdown ? { source: "fetched", markdown } : { source: "fetch_failed", error: "Reddit post not found" };
    } catch (error) {
      return { source: "fetch_failed", error: error instanceof Error ? error.message : String(error) };
    }
  };
}

export function isPdfUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    const path = pathname.toLowerCase();
    // arXiv serves PDFs from extensionless /pdf/<id> paths.
    return path.endsWith(".pdf") || (/(^|\.)arxiv\.org$/i.test(hostname) && path.startsWith("/pdf/"));
  } catch {
    return false;
  }
}

/**
 * Returns a function that fetches a story's linked page as Markdown: Reddit posts through the Reddit API,
 * everything else through Firecrawl, one call at a time. Self-posts and PDFs are never sent; without a key
 * for the matching service nothing is fetched.
 */
export function createArticleFetcher(
  apiKey: string | undefined,
  fetcher: FetchLike = fetch,
  minIntervalMs = MIN_INTERVAL_MS,
  reddit?: RedditCredentials
): (hit: AlgoliaHit) => Promise<ArticleResult> {
  let lastCallAt = -Infinity;
  const readReddit = reddit ? createRedditReader(reddit, fetcher) : undefined;
  return async hit => {
    if (!hit.url) return { source: "self_post" };
    if (isPdfUrl(hit.url)) return { source: "pdf_skipped" };
    // Reddit blocks Firecrawl and anonymous requests, so its links only go through the API.
    if (isRedditHost(hit.url)) {
      const postId = redditPostId(hit.url);
      if (!postId) return { source: "fetch_failed", error: "Not a Reddit post link" };
      return readReddit ? readReddit(postId) : { source: "disabled" };
    }
    if (!apiKey) return { source: "disabled" };

    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastCallAt = Date.now();

    try {
      const response = await fetcher(FIRECRAWL_SCRAPE_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // parsers: [] stops Firecrawl from parsing a PDF it lands on, which would cost a credit per page.
        body: JSON.stringify({ url: hit.url, formats: ["markdown"], onlyMainContent: true, timeout: PAGE_TIMEOUT_MS, parsers: [] }),
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS + 15_000)
      });
      const NOT_JSON = Symbol("not JSON");
      // An aborted or timed-out body read is rethrown so the outer handler records the real reason.
      const parsed: unknown = await response.json().catch(error => {
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
        return NOT_JSON;
      });
      if (parsed === NOT_JSON) {
        return { source: "fetch_failed", error: `Firecrawl HTTP ${response.status}: response was not JSON` };
      }
      const body = parsed as
        | { success?: boolean; error?: string; data?: { markdown?: string; metadata?: { statusCode?: number; contentType?: string } } }
        | undefined;
      if (!response.ok || !body?.success) {
        return { source: "fetch_failed", error: `Firecrawl HTTP ${response.status}${body?.error ? `: ${body.error}` : ""}` };
      }
      const metadata = body.data?.metadata ?? {};
      if (metadata.contentType?.toLowerCase().includes("pdf")) return { source: "pdf_skipped" };
      if (metadata.statusCode !== undefined && metadata.statusCode >= 400) {
        return { source: "fetch_failed", error: `Page returned HTTP ${metadata.statusCode}` };
      }
      const markdown = body.data?.markdown?.trim();
      if (!markdown) return { source: "fetch_failed", error: "Page had no text" };
      return { source: "fetched", markdown };
    } catch (error) {
      return { source: "fetch_failed", error: error instanceof Error ? error.message : String(error) };
    }
  };
}
