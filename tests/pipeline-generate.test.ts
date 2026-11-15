import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AlgoliaHit, ProcessedStory, StoryDetails } from "../shared/summarizer-core";
import { runGeneration } from "../scripts/pipeline/generate";
import type { GenerateConfig } from "../scripts/pipeline/types";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeConfig(): Promise<GenerateConfig> {
  const dataRoot = await mkdtemp(join(tmpdir(), "hn-brief-generate-"));
  roots.push(dataRoot);
  return {
    dataRoot,
    timeZone: "America/New_York",
    providerName: "OpenAI-compatible",
    llm: { apiKey: "secret-key", apiUrl: "http://localhost:9/v1/chat/completions", model: "qwen3.8" }
  };
}

const hitA: AlgoliaHit = { objectID: "101", title: "Alpha story", url: "https://a.example", points: 321, num_comments: 45, created_at_i: 1 };
const hitB: AlgoliaHit = { objectID: "202", title: "Beta story", url: "https://b.example", points: 87, num_comments: 9, created_at_i: 2 };
const detailsA: StoryDetails = { id: "101", title: "Alpha story", points: 321, children: [{ id: "c1" }] };
const detailsB: StoryDetails = { id: "202", title: "Beta story", points: 87, children: [] };

function processed(hit: AlgoliaHit): ProcessedStory {
  return {
    id: hit.objectID,
    title: hit.title,
    url: hit.url ?? "",
    points: hit.points,
    num_comments: hit.num_comments,
    summary: `A substantive summary of ${hit.title} covering its main claims and evidence in some detail.`,
    discussion_summary: `Commenters on ${hit.title} debated the trade-offs and offered concrete experiences.`,
    postType: "article"
  };
}

// 02:30 UTC is still the previous evening in New York, so the date differs between UTC/London and New York.
const startedAt = new Date("2026-09-09T02:30:00.000Z");

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

test("publishes a retained run with ordered stories, New York date, window, and stage timings", async () => {
  const config = await makeConfig();
  let tick = 0;
  const daily = await runGeneration(config, {
    now: () => (tick++ === 0 ? startedAt : new Date(startedAt.getTime() + 5000)),
    fetchTopStories: async () => [hitA, hitB],
    fetchStoryDetails: async id => (id === "101" ? detailsA : detailsB),
    processStories: async entries => entries.map(({ hit }) => processed(hit)),
    generateDigest: async stories => `Digest for ${stories[0]?.title} then ${stories[1]?.title}`
  });

  expect(daily.date).toBe("2026-09-08");
  expect(daily.runId).toBe("2026-09-08T223000-0400");
  expect(daily.stories.map(story => story.id)).toEqual(["101", "202"]);
  expect(daily.digest).toBe("Digest for Alpha story then Beta story");
  expect(daily.model).toEqual({ provider: "OpenAI-compatible", endpoint: config.llm.apiUrl, name: "qwen3.8" });
  expect(daily.source).toEqual({
    kind: "hacker-news",
    query: "last-24-hours",
    windowStart: "2026-09-08T02:30:00.000Z",
    windowEnd: "2026-09-09T02:30:00.000Z"
  });
  expect(daily.quality).toEqual({ storyFailures: 0, storyCount: 2, digestValid: true });

  const runDir = join(config.dataRoot, "runs", daily.runId);
  expect(await Bun.file(join(runDir, "hn/top-stories.json")).json()).toEqual([hitA, hitB]);
  expect(await Bun.file(join(runDir, "hn/stories/101.json")).json()).toEqual(detailsA);
  expect(await Bun.file(join(runDir, "hn/stories/202.json")).json()).toEqual(detailsB);
  expect(await Bun.file(join(config.dataRoot, "latest.json")).json()).toEqual({
    date: "2026-09-08",
    runId: daily.runId,
    path: "daily/2026/09/08.json"
  });
  expect(await Bun.file(join(config.dataRoot, "daily/2026/09/08.json")).json()).toEqual(daily);
  expect(await readFile(join(config.dataRoot, "daily/2026/09/08.md"), "utf8")).toContain("## [Alpha story]");

  const manifest = await Bun.file(join(runDir, "manifest.json")).json();
  expect(manifest.status).toBe("complete");
  expect(Object.keys(manifest.stages).sort()).toEqual(["digest", "fetch", "publish", "summarize"]);
  expect(manifest.stages.fetch.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(manifest.finalPaths.json).toBe("daily/2026/09/08.json");
  expect(JSON.stringify(manifest)).not.toContain("secret-key");
  expect(await exists(join(config.dataRoot, ".generate.lock"))).toBe(false);
});

test("a digest failure keeps run evidence but publishes nothing and releases the lock", async () => {
  const config = await makeConfig();
  await expect(runGeneration(config, {
    now: () => startedAt,
    fetchTopStories: async () => [hitA, hitB],
    fetchStoryDetails: async id => (id === "101" ? detailsA : detailsB),
    processStories: async entries => entries.map(({ hit }) => processed(hit)),
    generateDigest: async () => {
      throw new Error("digest model exploded");
    }
  })).rejects.toThrow("digest model exploded");

  const runDir = join(config.dataRoot, "runs", "2026-09-08T223000-0400");
  const manifest = await Bun.file(join(runDir, "manifest.json")).json();
  expect(manifest.status).toBe("failed");
  expect(manifest.error).toEqual({ name: "Error", message: "digest model exploded" });
  expect(manifest.finalPaths).toBeUndefined();
  expect(Object.keys(manifest.stages).sort()).toEqual(["digest", "fetch", "summarize"]);
  expect(await Bun.file(join(runDir, "hn/top-stories.json")).json()).toEqual([hitA, hitB]);
  expect(await exists(join(config.dataRoot, "latest.json"))).toBe(false);
  expect(await exists(join(config.dataRoot, "archive.json"))).toBe(false);
  expect(await exists(join(config.dataRoot, "daily"))).toBe(false);
  expect(await exists(join(config.dataRoot, ".generate.lock"))).toBe(false);
});

test("a digest failure text is rejected before publication", async () => {
  const config = await makeConfig();
  await expect(runGeneration(config, {
    now: () => startedAt,
    fetchTopStories: async () => [hitA],
    fetchStoryDetails: async () => detailsA,
    processStories: async entries => entries.map(({ hit }) => processed(hit)),
    generateDigest: async () => "Digest generation failed: upstream 500"
  })).rejects.toThrow("Digest generation failed");
  expect(await exists(join(config.dataRoot, "latest.json"))).toBe(false);
});

test("waits for in-flight story work before writing the failed manifest and releasing the lock", async () => {
  const config = await makeConfig();
  let slowFinished = false;
  let lockHeldWhenSlowFinished = false;
  const manifestPath = join(config.dataRoot, "runs", "2026-09-08T223000-0400", "manifest.json");
  let manifestStatusWhenSlowFinished = "";

  await expect(runGeneration(config, {
    now: () => startedAt,
    fetchTopStories: async () => [hitA, hitB],
    fetchStoryDetails: async id => (id === "101" ? detailsA : detailsB),
    processStories: async entries => {
      const [fast, slow] = entries;
      const results = await Promise.allSettled([
        Promise.reject(new Error(`trace write failed for ${fast!.hit.objectID}`)),
        (async () => {
          await new Promise(resolve => setTimeout(resolve, 60));
          slowFinished = true;
          lockHeldWhenSlowFinished = await exists(join(config.dataRoot, ".generate.lock"));
          manifestStatusWhenSlowFinished = (await Bun.file(manifestPath).json()).status;
          return processed(slow!.hit);
        })()
      ]);
      const failed = results.find(r => r.status === "rejected") as PromiseRejectedResult;
      throw failed.reason;
    },
    generateDigest: async () => "unused"
  })).rejects.toThrow("trace write failed for 101");

  expect(slowFinished).toBe(true);
  expect(lockHeldWhenSlowFinished).toBe(true);
  expect(manifestStatusWhenSlowFinished).toBe("running");
  const manifest = await Bun.file(manifestPath).json();
  expect(manifest.status).toBe("failed");
  expect(manifest.error.message).toBe("trace write failed for 101");
  expect(await exists(join(config.dataRoot, ".generate.lock"))).toBe(false);
});

test("a failed detail fetch waits for sibling fetches to settle and records the failure", async () => {
  const config = await makeConfig();
  let siblingWritten = false;
  await expect(runGeneration(config, {
    now: () => startedAt,
    fetchTopStories: async () => [hitA, hitB],
    fetchStoryDetails: async id => {
      if (id === "101") throw new Error("details 101 down");
      await new Promise(resolve => setTimeout(resolve, 40));
      siblingWritten = true;
      return detailsB;
    }
  })).rejects.toThrow("details 101 down");
  expect(siblingWritten).toBe(true);
  const runDir = join(config.dataRoot, "runs", "2026-09-08T223000-0400");
  expect(await Bun.file(join(runDir, "hn/stories/202.json")).json()).toEqual(detailsB);
  expect((await Bun.file(join(runDir, "manifest.json")).json()).status).toBe("failed");
  expect(await exists(join(config.dataRoot, ".generate.lock"))).toBe(false);
});
