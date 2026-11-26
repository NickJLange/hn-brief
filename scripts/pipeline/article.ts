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

const APIFY_REDDIT_ACTOR = "automation-lab~reddit-scraper";
const APIFY_RUN_TIMEOUT_S = 120;
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

interface ApifyRedditItem { type?: string; [field: string]: any }

const isRemoved = (text: unknown) => text === "[deleted]" || text === "[removed]";

/** Reads a JSON body, returning `fallback` when it does not parse; aborted or timed-out reads are rethrown. */
async function readJson<T>(response: Response, fallback: T): Promise<unknown | T> {
  return response.json().catch(error => {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    return fallback;
  });
}

function formatRedditPost(items: ApifyRedditItem[]): string | undefined {
  const post = items.find(item => item.type === "post");
  if (!post?.title) return undefined;
  const lines = [`# ${post.title}`, "", `Posted in r/${post.subreddit} by u/${post.author}.`];
  if (!post.isSelf && post.link) lines.push(`Linked URL: ${post.link}`);
  const body = String(post.selfText ?? "").trim();
  if (body && !isRemoved(body)) lines.push("", body);
  // Scores are best-effort (often 0), so keep the scraper's order and only lift known higher scores.
  const comments = items
    .filter(item => item.type === "comment" && item.body && !isRemoved(item.body) && (item.depth ?? 0) <= 0)
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (b.item.score ?? 0) - (a.item.score ?? 0) || a.index - b.index)
    .slice(0, REDDIT_TOP_COMMENTS);
  if (comments.length) {
    lines.push("", "## Top Reddit comments");
    for (const { item } of comments) lines.push("", `u/${item.author}:`, String(item.body).trim());
  }
  return lines.join("\n");
}

/** Reads a Reddit post and its top-level comments through Apify's Reddit scraper, which gets past Reddit's block. */
function createRedditReader(apifyToken: string, fetcher: FetchLike) {
  return async (postId: string): Promise<ArticleResult> => {
    try {
      const response = await fetcher(
        `https://api.apify.com/v2/acts/${APIFY_REDDIT_ACTOR}/run-sync-get-dataset-items?timeout=${APIFY_RUN_TIMEOUT_S}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apifyToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            urls: [`https://www.reddit.com/comments/${postId}/`],
            includeComments: true,
            maxCommentsPerPost: REDDIT_TOP_COMMENTS * 3,
            commentDepth: 1
          }),
          signal: AbortSignal.timeout((APIFY_RUN_TIMEOUT_S + 30) * 1000)
        }
      );
      const items = await readJson(response, undefined);
      if (!response.ok || !Array.isArray(items)) return { source: "fetch_failed", error: `Apify HTTP ${response.status}` };
      const markdown = formatRedditPost(items as ApifyRedditItem[]);
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
 * Returns a function that fetches a story's linked page as Markdown: Reddit posts through Apify's Reddit scraper,
 * everything else through Firecrawl, one call at a time. Self-posts and PDFs are never sent; without a key
 * for the matching service nothing is fetched.
 */
export function createArticleFetcher(
  apiKey: string | undefined,
  fetcher: FetchLike = fetch,
  minIntervalMs = MIN_INTERVAL_MS,
  apifyToken?: string
): (hit: AlgoliaHit) => Promise<ArticleResult> {
  let lastCallAt = -Infinity;
  const readReddit = apifyToken ? createRedditReader(apifyToken, fetcher) : undefined;
  return async hit => {
    if (!hit.url) return { source: "self_post" };
    if (isPdfUrl(hit.url)) return { source: "pdf_skipped" };
    // Reddit blocks Firecrawl and anonymous requests, so its links only go through Apify.
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
      const parsed = await readJson(response, NOT_JSON);
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
