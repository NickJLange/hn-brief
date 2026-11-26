import { expect, test } from "bun:test";
import type { AlgoliaHit } from "../shared/summarizer-core";
import { createArticleFetcher } from "../scripts/pipeline/article";

const hit = (url?: string): AlgoliaHit => ({ objectID: "1", title: "T", url, points: 1, num_comments: 0, created_at_i: 0 });

function firecrawl(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, fetcher };
}

test("fetches a web page as Markdown, asking Firecrawl not to parse PDFs", async () => {
  const fc = firecrawl(200, { success: true, data: { markdown: "  # Page\n\nBody  ", metadata: { statusCode: 200, contentType: "text/html" } } });
  const result = await createArticleFetcher("fc-key", fc.fetcher, 0)(hit("https://example.com/post"));
  expect(result).toEqual({ source: "fetched", markdown: "# Page\n\nBody" });
  expect(fc.calls).toHaveLength(1);
  expect(fc.calls[0]!.url).toBe("https://api.firecrawl.dev/v2/scrape");
  expect((fc.calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer fc-key");
  expect(JSON.parse(String(fc.calls[0]!.init.body))).toMatchObject({ url: "https://example.com/post", formats: ["markdown"], parsers: [] });
});

test("never calls Firecrawl for self-posts, .pdf links, or without a key", async () => {
  const fc = firecrawl(200, { success: true, data: { markdown: "x" } });
  const withKey = createArticleFetcher("fc-key", fc.fetcher, 0);
  expect(await withKey(hit())).toEqual({ source: "self_post" });
  expect(await withKey(hit("https://example.com/paper.PDF?download=1"))).toEqual({ source: "pdf_skipped" });
  expect(await createArticleFetcher(undefined, fc.fetcher, 0)(hit("https://example.com/post"))).toEqual({ source: "disabled" });
  expect(fc.calls).toHaveLength(0);
});

test("reports a PDF served from a non-.pdf URL as skipped, and failures as fetch_failed", async () => {
  const pdf = firecrawl(200, { success: true, data: { markdown: "", metadata: { statusCode: 200, contentType: "application/pdf" } } });
  expect(await createArticleFetcher("k", pdf.fetcher, 0)(hit("https://example.com/download"))).toEqual({ source: "pdf_skipped" });

  const outOfCredits = firecrawl(402, { success: false, error: "Insufficient credits" });
  expect(await createArticleFetcher("k", outOfCredits.fetcher, 0)(hit("https://example.com/a"))).toEqual({
    source: "fetch_failed",
    error: "Firecrawl HTTP 402: Insufficient credits"
  });

  const blocked = firecrawl(200, { success: true, data: { markdown: "Forbidden", metadata: { statusCode: 403 } } });
  expect(await createArticleFetcher("k", blocked.fetcher, 0)(hit("https://example.com/a"))).toEqual({
    source: "fetch_failed",
    error: "Page returned HTTP 403"
  });

  const down = createArticleFetcher("k", async () => { throw new Error("network down"); }, 0);
  expect(await down(hit("https://example.com/a"))).toEqual({ source: "fetch_failed", error: "network down" });
});
