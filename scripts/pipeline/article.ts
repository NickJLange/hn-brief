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
 * Returns a function that fetches a story's linked page as Markdown through Firecrawl, one call at a time.
 * Self-posts and PDFs are never sent; without an API key nothing is fetched.
 */
export function createArticleFetcher(
  apiKey: string | undefined,
  fetcher: FetchLike = fetch,
  minIntervalMs = MIN_INTERVAL_MS
): (hit: AlgoliaHit) => Promise<ArticleResult> {
  let lastCallAt = -Infinity;
  return async hit => {
    if (!hit.url) return { source: "self_post" };
    if (isPdfUrl(hit.url)) return { source: "pdf_skipped" };
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
      const parsed: unknown = await response.json().catch(() => NOT_JSON);
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
