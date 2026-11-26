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
  expect(await withKey(hit("https://arxiv.org/pdf/2611.01234v2"))).toEqual({ source: "pdf_skipped" });
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

test("reports empty, non-JSON, and unsuccessful responses with a reason", async () => {
  const empty = firecrawl(200, { success: true, data: { markdown: "  ", metadata: { statusCode: 200 } } });
  expect(await createArticleFetcher("k", empty.fetcher, 0)(hit("https://example.com/a"))).toEqual({ source: "fetch_failed", error: "Page had no text" });

  const html = createArticleFetcher("k", async () => new Response("<html>oops</html>", { status: 200 }), 0);
  expect(await html(hit("https://example.com/a"))).toEqual({ source: "fetch_failed", error: "Firecrawl HTTP 200: response was not JSON" });

  const nullBody = firecrawl(200, null);
  expect(await createArticleFetcher("k", nullBody.fetcher, 0)(hit("https://example.com/a"))).toEqual({ source: "fetch_failed", error: "Firecrawl HTTP 200" });

  const refused = firecrawl(200, { success: false, error: "Scrape timed out" });
  expect(await createArticleFetcher("k", refused.fetcher, 0)(hit("https://example.com/a"))).toEqual({
    source: "fetch_failed",
    error: "Firecrawl HTTP 200: Scrape timed out"
  });
});

test("spaces consecutive Firecrawl calls by the minimum interval, but not skipped stories", async () => {
  const times: number[] = [];
  const fetchArticle = createArticleFetcher("k", async () => {
    times.push(Date.now());
    return new Response(JSON.stringify({ success: true, data: { markdown: "x" } }), { status: 200 });
  }, 80);
  await fetchArticle(hit("https://example.com/1"));
  const beforeSkip = Date.now();
  await fetchArticle(hit());
  expect(Date.now() - beforeSkip).toBeLessThan(40);
  await fetchArticle(hit("https://example.com/2"));
  expect(times).toHaveLength(2);
  expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(75);
});

test("reads Reddit post links through Apify, never through Firecrawl", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([
      { type: "post", title: "Rumor", subreddit: "singularity", author: "op", isSelf: true, selfText: "Body & more" },
      { type: "comment", author: "first", body: "Unscored but first", score: 0, depth: 0 },
      { type: "comment", author: "reply", body: "Nested reply", score: 500, depth: 1 },
      { type: "comment", author: "high", body: "Insightful", score: 50, depth: 0 },
      { type: "comment", author: "gone", body: "[deleted]", score: 99, depth: 0 }
    ]), { status: 201 });
  };
  const fetchArticle = createArticleFetcher("fc-key", fetcher, 0, "apify-token");
  const result = await fetchArticle(hit("https://www.reddit.com/r/singularity/comments/1y59ef1/rumor_that/"));
  await fetchArticle(hit("https://redd.it/abc123"));

  expect(result.source).toBe("fetched");
  const md = result.markdown!;
  expect(md).toContain("# Rumor");
  expect(md).toContain("Body & more");
  expect(md).toContain("u/high");
  expect(md).toContain("u/first");
  expect(md.indexOf("u/high")).toBeLessThan(md.indexOf("u/first"));
  expect(md).not.toContain("Nested reply");
  expect(md).not.toContain("[deleted]");
  expect(calls).toHaveLength(2);
  expect(calls.every(c => c.url.startsWith("https://api.apify.com/v2/acts/automation-lab~reddit-scraper/run-sync-get-dataset-items"))).toBe(true);
  expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer apify-token");
  expect(JSON.parse(String(calls[1]!.init!.body)).urls).toEqual(["https://www.reddit.com/comments/abc123/"]);
});

test("Reddit links without a token are not sent to Firecrawl, and Apify failures are reported", async () => {
  const fc = firecrawl(200, { success: true, data: { markdown: "x" } });
  expect(await createArticleFetcher("fc-key", fc.fetcher, 0)(hit("https://old.reddit.com/r/x/comments/abc/t/"))).toEqual({ source: "disabled" });
  expect(await createArticleFetcher("fc-key", fc.fetcher, 0)(hit("https://www.reddit.com/r/programming/"))).toEqual({
    source: "fetch_failed",
    error: "Not a Reddit post link"
  });
  expect(await createArticleFetcher("fc-key", fc.fetcher, 0)(hit("https://i.redd.it/abc.png"))).toEqual({
    source: "fetch_failed",
    error: "Not a Reddit post link"
  });
  expect(fc.calls).toHaveLength(0);

  const notArray = createArticleFetcher(undefined, async () => new Response("{}", { status: 201 }), 0, "t");
  expect(await notArray(hit("https://www.reddit.com/r/x/comments/abc/t/"))).toEqual({ source: "fetch_failed", error: "Apify returned no dataset items" });

  const many = createArticleFetcher(undefined, async () => new Response(JSON.stringify([
    { type: "post", title: "Busy", subreddit: "x", author: "op", isSelf: true, selfText: "" },
    ...Array.from({ length: 15 }, (_, i) => ({ type: "comment", author: `c${i}`, body: `comment ${i}`, score: 0, depth: 0 }))
  ]), { status: 201 }), 0, "t");
  const busy = await many(hit("https://www.reddit.com/r/x/comments/abc/t/"));
  expect(busy.markdown!.match(/^u\//gm)).toHaveLength(10);

  const unauthorized = createArticleFetcher(undefined, async () => new Response("{}", { status: 401 }), 0, "bad");
  expect(await unauthorized(hit("https://www.reddit.com/r/x/comments/abc/t/"))).toEqual({ source: "fetch_failed", error: "Apify HTTP 401" });

  const removed = createArticleFetcher(undefined, async () => new Response(JSON.stringify([
    { type: "post", title: "Gone", subreddit: "x", author: "op", isSelf: true, selfText: "[removed]" }
  ]), { status: 201 }), 0, "t");
  const gone = await removed(hit("https://www.reddit.com/r/x/comments/a1/t/"));
  expect(gone.source).toBe("fetched");
  expect(gone.markdown).not.toContain("[removed]");

  const empty = createArticleFetcher(undefined, async () => new Response("[]", { status: 201 }), 0, "t");
  expect(await empty(hit("https://www.reddit.com/r/x/comments/a1/t/"))).toEqual({ source: "fetch_failed", error: "Reddit post not found" });
});
