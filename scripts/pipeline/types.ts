import type { LLMConfig, ProcessedStory, TopComment } from "../../shared/summarizer-core";

export interface PipelineQuality {
  storyFailures: number;
  storyCount: number;
  digestValid: boolean;
}

/** Whether the summary was written from the linked page: fetched, or why not. */
export type ArticleSource = "fetched" | "pdf_skipped" | "fetch_failed" | "self_post" | "disabled";

/** A published story: its summaries, whether the linked page was read, and the comments the summary was written from. */
export type BriefingStory = ProcessedStory & { articleSource: ArticleSource; topComments: TopComment[] };

export interface DailyBriefing {
  schemaVersion: 1;
  date: string;
  generatedAt: string;
  runId: string;
  source: { kind: "hacker-news"; query: "last-24-hours"; windowStart: string; windowEnd: string };
  model: { provider: string; endpoint: string; name: string };
  digest: string;
  stories: BriefingStory[];
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
  stages: Partial<Record<"fetch" | "articles" | "summarize" | "digest" | "publish", StageTiming>>;
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
  /** Firecrawl key for fetching linked pages; without it, stories are summarized from title and comments only. */
  firecrawlApiKey?: string;
  /** Apify token for reading Reddit post links, which Firecrawl and anonymous requests cannot fetch. */
  apifyToken?: string;
}
