# Local HN Brief Data Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private once-daily HN briefing pipeline that runs with Podman, retains complete source and inference artifacts, and atomically publishes agent-readable JSON to a host filesystem.

**Architecture:** A one-shot Bun CLI orchestrates existing shared HN and summarization functions. Optional trace events added at the shared LLM boundary feed a filesystem artifact sink; local storage helpers own run manifests, locking, atomic publication, indexes, and pruning. An OCI image runs the CLI through Podman while host cron/systemd or `launchd` owns scheduling.

**Tech Stack:** Bun 1.x, strict TypeScript, Bun test, OpenAI-compatible HTTP API, Podman 5.x, Podman Compose, JSON/Markdown filesystem artifacts.

**Spec:** `docs/superpowers/specs/2026-09-08-local-data-pipeline-design.md`

## Global Constraints

- Run once daily around 07:00 in `America/New_York`; scheduling stays outside the container.
- Use `http://lunarbeacon.newyork.nicklange.family:11434/v1/chat/completions` with model `qwen3.8` initially, configured only through environment variables.
- Never persist API keys or authorization headers.
- Retain every intermediate run until an operator confirms an explicit cutoff-based prune.
- Publish `daily/*`, `archive.json`, and `latest.json` only after a valid complete run.
- Preserve all existing Worker behavior and avoid additional Cloudflare subrequests when tracing is absent.
- Do not fetch external article bodies in this change.
- Do not add automatic retention, website hosting, GitHub publishing, or model benchmarking.
- Keep the output directory bind-mounted at `/data` in the container and configurable for native execution.

## File Map

- Modify `shared/summarizer-core.ts`: define trace event contracts and emit redacted request, raw response, parsed result, timing, usage, and error events.
- Create `scripts/pipeline/types.ts`: local manifest, final record, configuration, and dependency types.
- Create `scripts/pipeline/storage.ts`: run IDs, lock ownership, JSON writes, atomic final publication, indexes, and safe path validation.
- Create `scripts/pipeline/trace.ts`: map shared trace events to per-story and digest run artifacts.
- Create `scripts/pipeline/generate.ts`: orchestrate one retained generation run with dependency injection for tests.
- Create `scripts/pipeline/prune.ts`: preview and confirm cutoff-based deletion under `data/runs` only.
- Create `scripts/pipeline/cli.ts`: parse `generate`, `prune`, and help before loading model configuration.
- Modify `scripts/summarizer.ts`: make existing `--help` work without LLM credentials.
- Modify `package.json`: add the `pipeline` script.
- Create `tests/llm-tracing.test.ts`: shared trace contract and redaction tests.
- Create `tests/pipeline-storage.test.ts`: lock, atomic publication, final pointers, and path safety tests.
- Create `tests/pipeline-generate.test.ts`: fixture-backed successful and failed run tests.
- Create `tests/pipeline-prune.test.ts`: dry-run, cutoff, and final-data protection tests.
- Create `tests/pipeline-cli.test.ts`: help-without-credentials and argument validation tests.
- Create `Containerfile`: Bun OCI image and pipeline entry point.
- Create `.containerignore`: exclude Git history, dependencies, credentials, existing summaries, and local data.
- Create `compose.yaml`: Podman Compose service with `/data` bind mount and `.env.pipeline` configuration.
- Create `.env.pipeline.example`: non-secret Lunar Beacon defaults.
- Modify `.gitignore`: ignore `.env.pipeline` and `/data/`.
- Create `docs/local-data-pipeline.md`: Podman, scheduling, data consumption, diagnostics, and pruning guide.
- Archive `openspec/changes/local-data-pipeline.md` to `openspec/specs/local-data-pipeline.md` after implementation verifies successfully.

---

### Task 1: Shared LLM Trace Contract

**Files:**
- Modify: `shared/summarizer-core.ts:24-95, 392-449, 1454-1639, 1780-1848`
- Create: `tests/llm-tracing.test.ts`

**Interfaces:**
- Consumes: existing `summarizeStory`, `generateDigest`, `processStoriesWithRateLimit`, and `fetchCompletionWithMeta` flows.
- Produces:
  - `LLMTraceScope = { operation: 'story'; storyId: string } | { operation: 'digest' }`
  - `LLMTraceEvent` discriminated union for `request`, `response`, `parsed`, and `error`.
  - `LLMTraceSink = (event: LLMTraceEvent) => void | Promise<void>`.
  - Optional `trace` in `processStoriesWithRateLimit` options and optional final `trace` arguments for `summarizeStory` and `generateDigest`.

- [ ] **Step 1: Write failing trace tests**

Create `tests/llm-tracing.test.ts` with an asymmetric story fixture and fake response that includes server-specific usage and timing fields:

```ts
import { describe, expect, mock, test } from "bun:test";
import {
  generateDigest,
  summarizeStory,
  type AlgoliaHit,
  type LLMConfig,
  type LLMTraceEvent
} from "../shared/summarizer-core";

const config: LLMConfig = {
  apiKey: "must-not-appear",
  apiUrl: "http://llm.test/v1/chat/completions",
  model: "small-model",
  provider: "openai-compatible",
  thinking: false
};

test("story tracing records request, raw response, parsed output, and timing without credentials", async () => {
  const events: LLMTraceEvent[] = [];
  const hit: AlgoliaHit = {
    objectID: "42",
    title: "Asymmetric fixture",
    url: "https://example.test/story",
    points: 91,
    num_comments: 17,
    created_at_i: 1
  };
  const raw = {
    choices: [{ finish_reason: "stop", message: { content: "<Content Summary>Specific result.</Content Summary><Discussion Summary>Distinct discussion.</Discussion Summary>" } }],
    usage: { prompt_tokens: 111, completion_tokens: 37, total_tokens: 148 },
    timings: { prompt_ms: 20, predicted_ms: 40 }
  };
  const fetcher = mock(async () => new Response(JSON.stringify(raw), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));

  const result = await summarizeStory(hit, [], config, fetcher, undefined, async event => events.push(event));

  expect(result.summary).toBe("Specific result.");
  expect(events.map(event => event.type)).toEqual(["request", "response", "parsed"]);
  expect(events[0]).toMatchObject({ type: "request", scope: { operation: "story", storyId: "42" } });
  expect(events[1]).toMatchObject({ type: "response", body: raw });
  expect(JSON.stringify(events)).not.toContain("must-not-appear");
  expect((events[1] as Extract<LLMTraceEvent, { type: "response" }>).elapsedMs).toBeGreaterThanOrEqual(0);
});

test("digest tracing uses digest scope and retains provider errors", async () => {
  const events: LLMTraceEvent[] = [];
  const fetcher = mock(async () => new Response(JSON.stringify({ error: { message: "model unavailable" } }), {
    status: 503,
    headers: { "content-type": "application/json" }
  }));

  const result = await generateDigest([], config, fetcher, async event => events.push(event));

  expect(result).toContain("failed");
  expect(events[0]).toMatchObject({ type: "request", scope: { operation: "digest" } });
  expect(events[1]).toMatchObject({ type: "error", scope: { operation: "digest" }, status: 503 });
});
```

- [ ] **Step 2: Run the focused tests and confirm the contract is absent**

Run: `bun test tests/llm-tracing.test.ts`

Expected: TypeScript/import failures because `LLMTraceEvent` and trace arguments do not exist.

- [ ] **Step 3: Add trace types and transport metadata**

Add the following public types near `LLMLogger`:

```ts
export type LLMTraceScope =
  | { operation: 'story'; storyId: string }
  | { operation: 'digest' };

export type LLMTraceEvent =
  | { type: 'request'; scope: LLMTraceScope; body: Record<string, unknown>; recordedAt: string }
  | { type: 'response'; scope: LLMTraceScope; body: unknown; elapsedMs: number; recordedAt: string }
  | { type: 'parsed'; scope: LLMTraceScope; body: unknown; qualityFailure: boolean; recordedAt: string }
  | { type: 'error'; scope: LLMTraceScope; message: string; status?: number; body?: unknown; elapsedMs: number; recordedAt: string };

export type LLMTraceSink = (event: LLMTraceEvent) => void | Promise<void>;
```

Change `fetchCompletionWithMeta` to accept `scope` and `trace` in its options, capture `startedAt = Date.now()`, emit the request body before fetch, parse the response from text so the raw JSON can be emitted, and return the existing content/finish fields. Do not include URL, headers, or `apiKey` in any event. For non-2xx responses, parse JSON when possible, emit an `error` event containing status/body/elapsed time, then throw the same bounded error message used today.

Use a helper so every event is awaited and trace failures fail the local traced run instead of silently losing evidence:

```ts
async function emitTrace(trace: LLMTraceSink | undefined, event: LLMTraceEvent): Promise<void> {
  if (trace) await trace(event);
}
```

- [ ] **Step 4: Thread trace scopes through story, digest, and batch processing**

Append `trace?: LLMTraceSink` to `summarizeStory` and `generateDigest`. Add `trace?: LLMTraceSink` to `processStoriesWithRateLimit` options and pass it to every `summarizeStory` call. Use `{ operation: 'story', storyId: story.objectID }` and `{ operation: 'digest' }` for transport events. Emit `parsed` after `parseSummaryResponse` and after successful digest content retrieval:

```ts
await emitTrace(trace, {
  type: 'parsed',
  scope,
  body: { summary: parsed.summary, discussion: parsed.discussion },
  qualityFailure: isStorySummaryLowQuality({
    summary: parsed.summary,
    discussion_summary: parsed.discussion
  }),
  recordedAt: new Date().toISOString()
});
```

Update internal retries to preserve the same scope and trace sink. Existing callers compile unchanged because every new parameter is optional.

- [ ] **Step 5: Verify focused and regression tests**

Run: `bun test tests/llm-tracing.test.ts tests/summarizer-core.test.ts tests/worker-summarizer-safeguards.test.ts`

Expected: all tests pass, and Worker safeguard tests make no trace calls.

- [ ] **Step 6: Commit the trace boundary**

```bash
git add shared/summarizer-core.ts tests/llm-tracing.test.ts
git commit -m "feat: add optional LLM trace events"
```

---

### Task 2: Filesystem Types, Locking, and Atomic Publication

**Files:**
- Create: `scripts/pipeline/types.ts`
- Create: `scripts/pipeline/storage.ts`
- Create: `tests/pipeline-storage.test.ts`

**Interfaces:**
- Consumes: `ProcessedStory`, `LLMConfig`, and Markdown formatters from `shared/summarizer-core.ts`.
- Produces:
  - `PipelineManifest`, `DailyBriefing`, `ArchiveEntry`, and `PipelineQuality` types.
  - `formatRunId(now: Date, timeZone: string): string`.
  - `acquireDataLock(dataRoot: string, now?: Date): Promise<() => Promise<void>>`.
  - `createRunStore(dataRoot: string, runId: string): Promise<RunStore>`.
  - `publishDaily(store: RunStore, record: DailyBriefing, markdown: { articles: string; digest: string }): Promise<PublishedPaths>`.

- [ ] **Step 1: Define failing storage tests using an isolated temporary directory**

Create `tests/pipeline-storage.test.ts` using `mkdtemp`, `tmpdir`, and `rm`. Cover these competing failure modes: a second process acquiring the same lock, a stale lock older than 24 hours, an index update accidentally dropping an older date, and a partially written temporary file becoming visible.

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDataLock,
  createRunStore,
  formatRunId,
  publishDaily
} from "../scripts/pipeline/storage";
import type { DailyBriefing } from "../scripts/pipeline/types";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "hn-brief-pipeline-"));
  roots.push(value);
  return value;
}

test("lock excludes overlap and can be released", async () => {
  const dataRoot = await root();
  const release = await acquireDataLock(dataRoot, new Date("2026-09-08T11:00:00Z"));
  await expect(acquireDataLock(dataRoot, new Date("2026-09-08T11:01:00Z"))).rejects.toThrow("already running");
  await release();
  const releaseAgain = await acquireDataLock(dataRoot, new Date("2026-09-08T11:02:00Z"));
  await releaseAgain();
});

test("publication writes final files and preserves older archive entries", async () => {
  const dataRoot = await root();
  await writeFile(join(dataRoot, "archive.json"), JSON.stringify([{ date: "2026-09-07", path: "daily/2026/09/07.json", runId: "old", storyCount: 19 }]));
  const store = await createRunStore(dataRoot, "2026-09-08T070000-0400");
  const record = {
    schemaVersion: 1,
    date: "2026-09-08",
    generatedAt: "2026-09-08T11:30:00.000Z",
    runId: store.runId,
    source: { kind: "hacker-news", query: "last-24-hours", windowStart: "2026-09-07T11:00:00.000Z", windowEnd: "2026-09-08T11:00:00.000Z" },
    model: { provider: "openai-compatible", endpoint: "http://llm.test/v1/chat/completions", name: "small-model" },
    digest: "Daily digest",
    stories: [],
    quality: { storyFailures: 0, storyCount: 0, digestValid: true }
  } satisfies DailyBriefing;

  const paths = await publishDaily(store, record, { articles: "# Articles", digest: "# Digest" });

  expect(paths.json).toBe("daily/2026/09/08.json");
  expect(JSON.parse(await readFile(join(dataRoot, "latest.json"), "utf8"))).toMatchObject({ date: "2026-09-08", path: paths.json });
  const archive = JSON.parse(await readFile(join(dataRoot, "archive.json"), "utf8"));
  expect(archive.map((entry: { date: string }) => entry.date)).toEqual(["2026-09-08", "2026-09-07"]);
  await expect(stat(join(dataRoot, "daily/2026/09/08.json"))).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run the focused test and observe missing modules**

Run: `bun test tests/pipeline-storage.test.ts`

Expected: FAIL because pipeline storage and type modules do not exist.

- [ ] **Step 3: Add explicit dataset types**

In `scripts/pipeline/types.ts`, define the stable JSON contract:

```ts
import type { LLMConfig, ProcessedStory } from "../../shared/summarizer-core";

export interface PipelineQuality {
  storyFailures: number;
  storyCount: number;
  digestValid: boolean;
}

export interface DailyBriefing {
  schemaVersion: 1;
  date: string;
  generatedAt: string;
  runId: string;
  source: { kind: "hacker-news"; query: "last-24-hours"; windowStart: string; windowEnd: string };
  model: { provider: string; endpoint: string; name: string };
  digest: string;
  stories: ProcessedStory[];
  quality: PipelineQuality;
}

export interface ArchiveEntry {
  date: string;
  path: string;
  runId: string;
  storyCount: number;
}

export interface StageTiming {
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
}

export interface InferenceStats {
  requestCount: number;
  elapsedMs: number;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface PipelineManifest {
  schemaVersion: 1;
  runId: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  completedAt?: string;
  source: { query: "last-24-hours"; windowStart: string; windowEnd: string };
  model: { provider: string; endpoint: string; name: string };
  stages: Partial<Record<"fetch" | "summarize" | "digest" | "publish", StageTiming>>;
  inference: InferenceStats;
  quality?: PipelineQuality;
  error?: { name: string; message: string };
  finalPaths?: { json: string; articles: string; digest: string };
}

export interface GenerateConfig {
  dataRoot: string;
  timeZone: string;
  llm: LLMConfig;
  providerName: string;
}
```

- [ ] **Step 4: Implement focused storage primitives**

In `scripts/pipeline/storage.ts`, use `node:fs/promises`, `node:path`, and `crypto.randomUUID`. Implement:

```ts
export interface RunStore {
  dataRoot: string;
  runId: string;
  runDir: string;
  writeJson(relativePath: string, value: unknown): Promise<void>;
  writeManifest(value: PipelineManifest): Promise<void>;
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
```

Validate every run-relative path with `resolve(runDir, relativePath)` and require it to start with `${resolve(runDir)}${sep}`. Implement the lock as `dataRoot/.generate.lock/owner.json` created through atomic `mkdir`. If its owner timestamp is at least 24 hours old, remove and acquire it once; otherwise throw `Generation already running`. The release callback removes only `.generate.lock`.

`publishDaily` must write the three daily files first, then write `archive.json`, and write `latest.json` last. All JSON writes and the two Markdown writes use temporary files plus rename. Upsert the date in archive rather than discarding old entries, sort descending, and return relative POSIX paths.

- [ ] **Step 5: Add stale-lock and path-escape assertions, then run tests**

Add tests that seed `.generate.lock/owner.json` 25 hours old and expect acquisition to recover it, and call `store.writeJson("../outside.json", {})` expecting rejection. Run:

`bun test tests/pipeline-storage.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the storage boundary**

```bash
git add scripts/pipeline/types.ts scripts/pipeline/storage.ts tests/pipeline-storage.test.ts
git commit -m "feat: add atomic pipeline storage"
```

---

### Task 3: Filesystem Trace Sink

**Files:**
- Create: `scripts/pipeline/trace.ts`
- Create: `tests/pipeline-trace.test.ts`

**Interfaces:**
- Consumes: `LLMTraceEvent`, `LLMTraceSink`, and `RunStore` from Tasks 1 and 2.
- Produces:
  - `FilesystemTraceRecorder = { sink: LLMTraceSink; snapshot(): InferenceStats }`.
  - `createFilesystemTraceRecorder(store: RunStore): FilesystemTraceRecorder`.

- [ ] **Step 1: Write a failing mapping and retry-preservation test**

Create `tests/pipeline-trace.test.ts`. Use a temporary `RunStore`, send two request/response attempts for story `42`, then a parsed event. Assert the first call uses the spec's base filenames and the retry uses numbered filenames:

```ts
const recorder = createFilesystemTraceRecorder(store);
await recorder.sink({ type: "request", scope: { operation: "story", storyId: "42" }, body: { model: "a" }, recordedAt: "2026-09-08T11:00:00.000Z" });
await recorder.sink({ type: "response", scope: { operation: "story", storyId: "42" }, body: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }, elapsedMs: 10, recordedAt: "2026-09-08T11:00:00.010Z" });
await recorder.sink({ type: "request", scope: { operation: "story", storyId: "42" }, body: { model: "b" }, recordedAt: "2026-09-08T11:00:01.000Z" });
await recorder.sink({ type: "response", scope: { operation: "story", storyId: "42" }, body: { choices: [{ index: 0 }], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }, elapsedMs: 12, recordedAt: "2026-09-08T11:00:01.012Z" });
await recorder.sink({ type: "parsed", scope: { operation: "story", storyId: "42" }, body: { summary: "ok" }, qualityFailure: false, recordedAt: "2026-09-08T11:00:01.013Z" });

expect(await Bun.file(join(store.runDir, "llm/stories/42/request.json")).json()).toMatchObject({ model: "a" });
expect(await Bun.file(join(store.runDir, "llm/stories/42/attempt-02-request.json")).json()).toMatchObject({ model: "b" });
expect(await Bun.file(join(store.runDir, "llm/stories/42/parsed.json")).json()).toMatchObject({ qualityFailure: false });
expect(recorder.snapshot()).toEqual({
  requestCount: 2,
  elapsedMs: 22,
  usage: { promptTokens: 21, completionTokens: 5, totalTokens: 26 }
});
```

Also send a story ID containing `/` and assert the sink rejects it rather than creating nested paths.

- [ ] **Step 2: Run the focused test and observe the missing sink**

Run: `bun test tests/pipeline-trace.test.ts`

Expected: FAIL because `createFilesystemTraceRecorder` does not exist.

- [ ] **Step 3: Implement event-to-artifact mapping**

Keep an in-memory attempt counter keyed by `story:<id>` or `digest`. Validate story IDs with `/^\d+$/`. Use these locations:

```ts
function scopeDir(event: LLMTraceEvent): string {
  return event.scope.operation === "digest"
    ? "llm/digest"
    : `llm/stories/${event.scope.storyId}`;
}
```

Persist attempt 1 as `request.json`, `response.json`, or `error.json`; persist later attempts as `attempt-0N-request.json`, `attempt-0N-response.json`, or `attempt-0N-error.json`; persist parsed output as `parsed.json`. Each response is `{ recordedAt, elapsedMs, body }`, each error is `{ recordedAt, elapsedMs, status, message, body }`, and each parsed event is `{ recordedAt, qualityFailure, body }`. Increment request count on request events, elapsed time on response/error events, and token totals from `body.usage` when those numeric fields exist. `snapshot()` returns a copy of the accumulated values. Since trace events never contain headers or keys, the recorder needs no secret-bearing configuration.

- [ ] **Step 4: Verify the focused tests**

Run: `bun test tests/pipeline-trace.test.ts tests/llm-tracing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the filesystem trace sink**

```bash
git add scripts/pipeline/trace.ts tests/pipeline-trace.test.ts
git commit -m "feat: persist model trace artifacts"
```

---

### Task 4: Retained Daily Generation Orchestrator

**Files:**
- Create: `scripts/pipeline/generate.ts`
- Create: `tests/pipeline-generate.test.ts`

**Interfaces:**
- Consumes: `GenerateConfig`, storage functions, trace sink, and existing core HN/LLM/formatter functions.
- Produces: `runGeneration(config: GenerateConfig, overrides?: Partial<GenerationDependencies>): Promise<DailyBriefing>`.
- Produces internal `GenerationDependencies` with injectable `now`, source fetches, story processing, and digest generation for deterministic tests.

- [ ] **Step 1: Write a failing successful-run test with unequal story values**

Create `tests/pipeline-generate.test.ts` with a temporary data root, two HN hits whose points/comments differ, distinct detail trees, and deterministic processed summaries. Inject all network/model dependencies. Assert raw HN files, final ordering, model identity, source window, manifest status, and latest pointer values rather than only checking file existence.

```ts
const daily = await runGeneration(config, {
  now: () => new Date("2026-09-08T11:00:00.000Z"),
  fetchTopStories: async () => [hitA, hitB],
  fetchStoryDetails: async id => id === "101" ? detailsA : detailsB,
  processStories: async entries => entries.map(({ hit }) => hit.objectID === "101" ? processedA : processedB),
  generateDigest: async stories => `Digest for ${stories[0]?.title} then ${stories[1]?.title}`
});

expect(daily.date).toBe("2026-09-08");
expect(daily.stories.map(story => story.id)).toEqual(["101", "202"]);
expect(daily.model).toEqual({ provider: "OpenAI-compatible", endpoint: config.llm.apiUrl, name: "qwen3.8" });
expect(await Bun.file(join(dataRoot, "runs", daily.runId, "hn/top-stories.json")).json()).toEqual([hitA, hitB]);
expect(await Bun.file(join(dataRoot, "latest.json")).json()).toMatchObject({ date: daily.date, runId: daily.runId });
```

- [ ] **Step 2: Add a failing-run test that distinguishes retained evidence from final publication**

Inject a digest failure after story artifacts exist. Assert `runGeneration` rejects, the run manifest is `failed` with the exact error, `hn/top-stories.json` remains, and neither `latest.json` nor the daily JSON exists. This catches the plausible wrong implementation that publishes story data before digest validation.

- [ ] **Step 3: Run focused tests and observe the missing orchestrator**

Run: `bun test tests/pipeline-generate.test.ts`

Expected: FAIL because `runGeneration` and `GenerationDependencies` do not exist.

- [ ] **Step 4: Implement dependency defaults and timezone helpers**

Use these dependency signatures so production calls existing shared functions while tests remain offline:

```ts
export interface GenerationDependencies {
  now(): Date;
  fetchTopStories(): Promise<AlgoliaHit[]>;
  fetchStoryDetails(id: string): Promise<StoryDetails>;
  processStories(
    entries: { hit: AlgoliaHit; details: StoryDetails }[],
    config: LLMConfig,
    trace: LLMTraceSink
  ): Promise<ProcessedStory[]>;
  generateDigest(stories: ProcessedStory[], config: LLMConfig, trace: LLMTraceSink): Promise<string>;
}
```

Format the briefing date with `Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })`. Set `windowEnd` to the captured run start and `windowStart` to exactly 24 hours earlier, matching the current live query.

- [ ] **Step 5: Implement the generation state machine**

The implementation order must be:

```ts
const release = await acquireDataLock(config.dataRoot, startedAt);
let store: RunStore | undefined;
let manifest: PipelineManifest | undefined;
let recorder: FilesystemTraceRecorder | undefined;
try {
  const runId = formatRunId(startedAt, config.timeZone);
  store = await createRunStore(config.dataRoot, runId);
  recorder = createFilesystemTraceRecorder(store);
  manifest = createRunningManifest(config, runId, startedAt);
  await store.writeManifest(manifest);

  const entries = await runStage(manifest, store, "fetch", deps.now, async () => {
    const hits = await deps.fetchTopStories();
    await store!.writeJson("hn/top-stories.json", hits);
    return Promise.all(hits.map(async hit => {
      if (!/^\d+$/.test(hit.objectID)) throw new Error(`Invalid HN story ID: ${hit.objectID}`);
      const details = await deps.fetchStoryDetails(hit.objectID);
      await store!.writeJson(`hn/stories/${hit.objectID}.json`, details);
      return { hit, details };
    }));
  });

  const stories = await runStage(manifest, store, "summarize", deps.now, () =>
    deps.processStories(entries, config.llm, recorder!.sink)
  );
  const storyFailures = stories.filter(needsStoryRepair).length;
  if (storyFailures > 12) throw new Error(`Too many story failures: ${storyFailures}/${stories.length}`);

  const digest = await runStage(manifest, store, "digest", deps.now, () =>
    deps.generateDigest(stories, config.llm, recorder!.sink)
  );
  if (isDigestFailureText(digest)) throw new Error(digest);

  const daily = createDailyBriefing(config, runId, startedAt, deps.now(), stories, digest);
  const paths = await runStage(manifest, store, "publish", deps.now, () => publishDaily(
    store!,
    daily,
    {
      articles: formatArticleMarkdown(stories, daily.date),
      digest: formatDigestMarkdown(digest, daily.date, stories.length)
    }
  ));
  manifest = {
    ...manifest,
    status: "complete",
    completedAt: deps.now().toISOString(),
    quality: daily.quality,
    inference: recorder.snapshot(),
    finalPaths: paths
  };
  await store.writeManifest(manifest);
  return daily;
} catch (error) {
  if (store && manifest) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    await store.writeManifest({
      ...manifest,
      status: "failed",
      completedAt: deps.now().toISOString(),
      inference: recorder?.snapshot() ?? emptyInferenceStats(),
      error: { name: normalized.name, message: normalized.message },
      finalPaths: undefined
    });
  }
  throw error;
} finally {
  await release();
}
```

Define `runStage` to record `startedAt`, `completedAt`, and `elapsedMs` in `manifest.stages`, writing the manifest after every stage whether that stage succeeds or throws. `createRunningManifest` initializes `source.query`, both source timestamps, empty stages, and `emptyInferenceStats()`. `createDailyBriefing` includes the same source query/window and quality counts. The manifest endpoint is acceptable metadata, but no key is copied from `LLMConfig`.

- [ ] **Step 6: Run orchestrator and shared regressions**

Run: `bun test tests/pipeline-generate.test.ts tests/pipeline-storage.test.ts tests/pipeline-trace.test.ts tests/summarizer-core.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the retained generator**

```bash
git add scripts/pipeline/generate.ts tests/pipeline-generate.test.ts
git commit -m "feat: generate retained daily datasets"
```

---

### Task 5: Pruning and CLI Dispatch

**Files:**
- Create: `scripts/pipeline/prune.ts`
- Create: `scripts/pipeline/cli.ts`
- Create: `tests/pipeline-prune.test.ts`
- Create: `tests/pipeline-cli.test.ts`
- Modify: `scripts/summarizer.ts:29-63, 448-485`
- Modify: `package.json:7-11`

**Interfaces:**
- Consumes: `runGeneration`, `createLLMConfig`, and filesystem run naming from earlier tasks.
- Produces:
  - `planPrune(dataRoot: string, before: string): Promise<string[]>`.
  - `pruneRuns(dataRoot: string, before: string, confirm: boolean): Promise<{ candidates: string[]; deleted: string[] }>`.
  - CLI commands `generate`, `prune --before YYYY-MM-DD [--confirm]`, and `--help`.

- [ ] **Step 1: Write cutoff and boundary tests before pruning code**

Create run directories for September 7, 8, and 9 plus `runs/not-a-run`, `daily/2026/09`, `archive.json`, and `latest.json`. Test `before=2026-09-09` returns only September 7 and 8; dry-run deletes nothing; `confirm=true` deletes only those two run directories. Assert all final data and `not-a-run` survive.

Also test malformed cutoffs such as `2026-9-8` and `../../etc` reject before filesystem traversal.

- [ ] **Step 2: Run pruning tests and observe the missing functions**

Run: `bun test tests/pipeline-prune.test.ts`

Expected: FAIL because the pruning module does not exist.

- [ ] **Step 3: Implement strict preview-first pruning**

Use `/^\d{4}-\d{2}-\d{2}$/` plus round-trip UTC date validation for the cutoff. Only list direct children of `resolve(dataRoot, "runs")`; accept names matching `/^(\d{4}-\d{2}-\d{2})T\d{6}(?:Z|[+-]\d{4})$/`; compare the captured date lexically to the cutoff. Sort candidates, return relative `runs/<name>` paths, and call `rm(path, { recursive: true })` only when `confirm` is true.

- [ ] **Step 4: Write CLI tests before CLI implementation**

Use `Bun.spawn` against `scripts/pipeline/cli.ts` with an empty environment except `PATH`. Assert `--help` and `prune --help` exit 0 without contacting a model. Assert `prune` without `--before` exits nonzero with a specific usage error. Add a separate subprocess test for `scripts/summarizer.ts --help` without API keys.

```ts
async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "run", ...args], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text()
  };
}
```

- [ ] **Step 5: Implement parse-first CLI dispatch**

Parse arguments synchronously before constructing `llmEnv` or calling `createLLMConfig`. Resolve:

```ts
const dataRoot = resolve(process.env.DATA_DIR || "data");
const timeZone = process.env.TZ || "America/New_York";
```

For `generate`, call `createLLMConfig(llmEnv)` and pass its `{ config, provider }` to `runGeneration`. For `prune`, do not load LLM configuration. Print candidates in dry-run mode and require `--confirm` to delete. The top-level catch prints `error.message` and sets `process.exitCode = 1`.

In `scripts/summarizer.ts`, call `parseCliArgs()` and return help before the existing top-level `resolveLLMConfigWithFallback`; move LLM candidate/config initialization behind the help check without changing generation behavior.

Add to `package.json`:

```json
"pipeline": "bun run scripts/pipeline/cli.ts"
```

- [ ] **Step 6: Run all CLI and pruning tests**

Run: `bun test tests/pipeline-prune.test.ts tests/pipeline-cli.test.ts`

Expected: PASS, including help with no LLM variables.

- [ ] **Step 7: Commit CLI and pruning**

```bash
git add scripts/pipeline/prune.ts scripts/pipeline/cli.ts scripts/summarizer.ts tests/pipeline-prune.test.ts tests/pipeline-cli.test.ts package.json
git commit -m "feat: add pipeline CLI and safe pruning"
```

---

### Task 6: Podman Packaging

**Files:**
- Create: `Containerfile`
- Create: `.containerignore`
- Create: `compose.yaml`
- Create: `.env.pipeline.example`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `bun run pipeline -- <command>` from Task 5.
- Produces: image `localhost/hn-brief-pipeline:local`, Compose service `hn-brief`, `/data` bind mount, and environment-only model configuration.

- [ ] **Step 1: Add ignored local-state boundaries**

Append these exact entries to `.gitignore`:

```gitignore
# Local data pipeline
.env.pipeline
/data/
```

Create `.containerignore`:

```text
.git
.amp
node_modules
data
summaries
.env
.env.*
!.env.example
!.env.pipeline.example
```

- [ ] **Step 2: Add the OCI build**

Create `Containerfile`:

```dockerfile
FROM docker.io/oven/bun:1.3.14-alpine

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY shared ./shared
COPY scripts ./scripts
COPY tsconfig.json ./

ENV DATA_DIR=/data \
    TZ=America/New_York

VOLUME ["/data"]
ENTRYPOINT ["bun", "run", "pipeline", "--"]
CMD ["generate"]
```

Pinning Bun to the locally verified 1.3.14 avoids unreviewed runtime drift.

- [ ] **Step 3: Add Podman Compose and non-secret defaults**

Create `compose.yaml`:

```yaml
services:
  hn-brief:
    build:
      context: .
      dockerfile: Containerfile
    image: localhost/hn-brief-pipeline:local
    env_file:
      - .env.pipeline
    environment:
      DATA_DIR: /data
      TZ: America/New_York
    volumes:
      - ${HN_BRIEF_DATA_DIR:-./data}:/data:Z
```

Create `.env.pipeline.example`:

```env
OPENAI_API_KEY=local
LLM_API_URL=http://lunarbeacon.newyork.nicklange.family:11434/v1/chat/completions
LLM_MODEL=qwen3.8
HN_BRIEF_DATA_DIR=./data
TZ=America/New_York
```

- [ ] **Step 4: Validate configuration without starting generation**

Run:

```bash
cp .env.pipeline.example .env.pipeline
podman compose --env-file .env.pipeline config
podman build -t localhost/hn-brief-pipeline:local -f Containerfile .
podman run --rm localhost/hn-brief-pipeline:local --help
```

Expected: Compose renders one service, image builds, and help exits 0 without model traffic. If the macOS Podman machine is stopped, start it with `podman machine start` and rerun these validation commands; do not run `generate` yet.

- [ ] **Step 5: Commit packaging**

```bash
git add Containerfile .containerignore compose.yaml .env.pipeline.example .gitignore
git commit -m "build: package pipeline for Podman"
```

---

### Task 7: Operations Documentation and End-to-End Verification

**Files:**
- Create: `docs/local-data-pipeline.md`
- Modify: `README.md:24-130`
- Move after verification: `openspec/changes/local-data-pipeline.md` to `openspec/specs/local-data-pipeline.md`

**Interfaces:**
- Consumes: all prior CLI, filesystem, and Podman contracts.
- Produces: operator instructions and an archived living specification.

- [ ] **Step 1: Write the operations guide with executable commands**

Document these sections in `docs/local-data-pipeline.md`:

1. Prerequisites: Podman 5.x, running Podman machine on macOS, access to Lunar Beacon.
2. Setup: copy `.env.pipeline.example`, choose an absolute `HN_BRIEF_DATA_DIR`, build with `podman compose --env-file .env.pipeline build`.
3. Manual run: `podman compose --env-file .env.pipeline run --rm hn-brief generate`.
4. Agent handoff: read `latest.json`, resolve its relative `path`, and ignore `runs/*` unless diagnosing.
5. Failed runs: inspect newest `runs/*/manifest.json`, HN inputs, and `llm/*/{request,response,error,parsed}.json`.
6. Pruning: preview and confirmed commands, explicitly stating daily data is never removed.
7. Linux scheduling using a rootless systemd user service and timer.
8. macOS scheduling using a `launchd` property list that invokes an executable wrapper with absolute paths.
9. Security: keep Lunar Beacon on trusted LAN/VPN or add authentication/firewalling.

Use a Linux oneshot service that runs:

```ini
ExecStart=/usr/bin/podman compose --env-file /absolute/path/to/hn-brief/.env.pipeline --project-directory /absolute/path/to/hn-brief run --rm hn-brief generate
```

and a timer with:

```ini
OnCalendar=*-*-* 07:00:00 America/New_York
Persistent=true
```

For macOS, explain that the Podman machine and host must be awake; `launchd` cannot make a sleeping host perform a long model run reliably.

- [ ] **Step 2: Link the private pipeline from README**

Add a concise “Private local data pipeline” section after Quick Start linking to `docs/local-data-pipeline.md`, describing retained JSON/traces and Podman. Do not replace the existing upstream Cloudflare documentation because that architecture remains supported by the repository.

- [ ] **Step 3: Run static and complete automated verification**

Run:

```bash
bunx tsc --noEmit
bun test
git diff --check
```

Expected: TypeScript exits 0, every test passes, and diff check prints nothing.

- [ ] **Step 4: Run fixture-backed container verification**

Expose the fixture-backed mode only through test injection, not a production CLI flag. Run the pipeline integration test inside the built image:

```bash
podman run --rm --entrypoint bun -v "$PWD:/src:ro,Z" -w /src \
  localhost/hn-brief-pipeline:local test tests/pipeline-generate.test.ts
```

Expected: generation tests pass against a temporary directory inside the container.

- [ ] **Step 5: Run a minimal live Lunar Beacon compatibility probe**

Use one eight-token request, not a full feed:

```bash
curl --fail --show-error --max-time 60 \
  http://lunarbeacon.newyork.nicklange.family:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":8,"temperature":0}'
```

Expected: HTTP 200 and assistant content `OK`. Do not print or pass any real API key.

- [ ] **Step 6: Archive the approved OpenSpec change**

After all checks pass:

```bash
mkdir -p openspec/specs
git mv openspec/changes/local-data-pipeline.md openspec/specs/local-data-pipeline.md
```

Edit the archived document to add a `## Verification Results` section containing the actual commands and observed pass counts from Step 3 plus Podman build/probe outcomes. Do not record a full live generation as complete unless it was actually run.

- [ ] **Step 7: Commit documentation and archive**

```bash
git add README.md docs/local-data-pipeline.md openspec/specs/local-data-pipeline.md
git commit -m "docs: add local pipeline operations guide"
```

- [ ] **Step 8: Stop before the first full generation**

Report the image build, test evidence, live probe result, local commit state, and the exact command for the first full run. A full 20-story run is deliberately operator-triggered because it may take 30–90 minutes on `qwen3.8` and creates the first durable dataset.
