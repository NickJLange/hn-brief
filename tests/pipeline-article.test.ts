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

test("reads Reddit links through the API with one reused token, never through Firecrawl", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/access_token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 86400 }), { status: 200 });
    return new Response(JSON.stringify([
      { data: { children: [{ kind: "t3", data: { title: "Rumor", subreddit: "singularity", author: "op", score: 900, is_self: true, selftext: "Body & more" } }] } },
      { data: { children: [
        { kind: "t1", data: { author: "low", score: 3, body: "meh" } },
        { kind: "t1", data: { author: "high", score: 50, body: "Insightful" } },
        { kind: "t1", data: { author: "gone", score: 99, body: "[deleted]" } },
        { kind: "more", data: {} }
      ] } }
    ]), { status: 200 });
  };
  const fetchArticle = createArticleFetcher("fc-key", fetcher, 0, { clientId: "id", clientSecret: "secret" });
  const result = await fetchArticle(hit("https://www.reddit.com/r/singularity/comments/1y59ef1/rumor_that/"));
  await fetchArticle(hit("https://redd.it/abc123"));

  expect(result.source).toBe("fetched");
  expect(result.markdown).toContain("# Rumor");
  expect(result.markdown).toContain("Body & more");
  expect(result.markdown).toContain("u/high");
  expect(result.markdown).toContain("u/low");
  expect(result.markdown!.indexOf("u/high")).toBeLessThan(result.markdown!.indexOf("u/low"));
  expect(result.markdown).not.toContain("[deleted]");
  expect(calls.map(c => c.url.split("?")[0])).toEqual([
    "https://www.reddit.com/api/v1/access_token",
    "https://oauth.reddit.com/comments/1y59ef1",
    "https://oauth.reddit.com/comments/abc123"
  ]);
  expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("id:secret")}`);
  expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  expect(calls.some(c => c.url.includes("firecrawl"))).toBe(false);
});

test("Reddit links without credentials are not sent to Firecrawl, and API errors are reported", async () => {
  const fc = firecrawl(200, { success: true, data: { markdown: "x" } });
  expect(await createArticleFetcher("fc-key", fc.fetcher, 0)(hit("https://old.reddit.com/r/x/comments/abc/t/"))).toEqual({ source: "disabled" });
  expect(await createArticleFetcher("fc-key", fc.fetcher, 0)(hit("https://www.reddit.com/r/programming/"))).toEqual({
    source: "fetch_failed",
    error: "Not a Reddit post link"
  });
  expect(fc.calls).toHaveLength(0);

  const badToken = createArticleFetcher(undefined, async () => new Response("{}", { status: 401 }), 0, { clientId: "id", clientSecret: "bad" });
  expect(await badToken(hit("https://www.reddit.com/r/x/comments/abc/t/"))).toEqual({ source: "fetch_failed", error: "Reddit token HTTP 401" });
});

test("renews an expired Reddit token and drops a removed post body", async () => {
  const tokenCalls: number[] = [];
  const fetcher = async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/access_token")) {
      tokenCalls.push(tokenCalls.length);
      // 60 s is inside the one-minute early-renewal margin, so the token counts as expired at once.
      return new Response(JSON.stringify({ access_token: `tok${tokenCalls.length}`, expires_in: 60 }), { status: 200 });
    }
    return new Response(JSON.stringify([
      { data: { children: [{ kind: "t3", data: { title: "Gone", subreddit: "x", author: "op", score: 1, is_self: true, selftext: "[removed]" } }] } },
      { data: { children: [] } }
    ]), { status: 200 });
  };
  const fetchArticle = createArticleFetcher(undefined, fetcher, 0, { clientId: "id", clientSecret: "s" });
  const first = await fetchArticle(hit("https://www.reddit.com/r/x/comments/a1/t/"));
  await fetchArticle(hit("https://www.reddit.com/r/x/comments/b2/t/"));
  expect(tokenCalls).toHaveLength(2);
  expect(first.markdown).not.toContain("[removed]");
});
