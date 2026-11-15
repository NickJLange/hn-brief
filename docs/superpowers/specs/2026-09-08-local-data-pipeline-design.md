# Local HN Brief Data Pipeline Design

## Context

HN Brief stopped publishing after the Cloudflare Worker's successful 2026-07-16 16:00 UTC run. The repository had no code or configuration change near the outage, the commits produced by the final run passed GitHub Actions, and the Hacker News Algolia API remains available. The next scheduled Worker run produced no repository activity. The exact Cloudflare-side failure cannot be recovered without access to the original account's Worker logs, but the evidence places the outage at the Worker or one of its credentials rather than in the checked-in application.

The replacement will not depend on the original site, Cloudflare, GitHub publishing, or a paid hosted LLM. It will produce a private, filesystem-based dataset that downstream agents can transform into other formats.

## Goals

- Generate one Hacker News briefing per day on Linux or macOS.
- Use the OpenAI-compatible model server at `lunarbeacon.newyork.nicklange.family:11434`, initially with `qwen3.8`.
- Preserve raw inputs, exact model requests, raw model responses, parsed results, timings, usage, and failures for model evaluation and debugging.
- Publish complete daily data as stable JSON files for downstream agents.
- Retain the existing Markdown representations as optional human-readable artifacts.
- Run portably as a one-shot Podman container with durable bind-mounted storage.
- Allow explicit, safe removal of intermediate run bundles after model behavior is accepted.

## Non-goals

- Hosting a website or exposing an HTTP API.
- Publishing data to GitHub, GitHub Pages, or Cloudflare.
- Automatically deleting retained runs.
- Building a model-comparison or benchmarking framework in the first version.
- Fetching and extracting external article bodies. The existing pipeline summarizes the HN title, self-post text, and selected comments; preserving that behavior keeps this change focused.
- Recovering summaries for dates when no capture was made. Algolia's historical search can support manual backfills, but those results are not guaranteed to reproduce the top stories as observed at the original time.

## Architecture

The deployment unit is a one-shot OCI container run with Podman. Each invocation fetches source data, performs inference, writes a retained run bundle incrementally, publishes final data only after successful completion, and exits. Scheduling remains a host responsibility:

- Linux can use rootless Podman with cron or a systemd user timer.
- macOS can use a Podman machine with `launchd`.
- Both platforms invoke the same container command and mount the same `/data` contract.

The default operational cadence is once per day around 07:00 in the host's local timezone. The scheduler configuration will document `America/New_York` explicitly where the scheduler supports a timezone setting.

The model is configured through environment variables rather than baked into the image:

```env
OPENAI_API_KEY=local
LLM_API_URL=http://lunarbeacon.newyork.nicklange.family:11434/v1/chat/completions
LLM_MODEL=qwen3.8
```

`OPENAI_API_KEY` is a non-secret compatibility value for the current server. The data pipeline must never persist authorization headers or API keys in trace artifacts.

## Execution Flow

1. Create a unique run directory and a manifest with status `running`.
2. Fetch the top Hacker News candidates and persist the returned records.
3. Fetch each story's details and comment tree, persisting each response independently.
4. Select and format comments using the existing shared algorithm.
5. Build each story request, persist its redacted request body, call the configured model, and persist the complete response and timing metadata.
6. Parse and assess each response, persisting the parsed result and quality outcome.
7. Build and retain the digest request and response.
8. Construct the final daily JSON and optional Markdown files in temporary paths.
9. Atomically rename completed final files into the published dataset and update `archive.json` and `latest.json`.
10. Mark the run manifest `complete` and exit successfully.

If any required stage prevents a valid final briefing, the run is marked `failed`, all captured intermediate artifacts are retained, finalized pointers remain unchanged, and the process exits nonzero. A process terminated before its error handler runs can leave status `running`; its timestamps and incomplete artifacts make the interruption visible without pretending the run succeeded.

## Filesystem Contract

```text
data/
├── runs/
│   └── 2026-09-08T070000-0400/
│       ├── manifest.json
│       ├── hn/
│       │   ├── top-stories.json
│       │   └── stories/
│       │       └── <story-id>.json
│       └── llm/
│           ├── stories/
│           │   └── <story-id>/
│           │       ├── request.json
│           │       ├── response.json
│           │       └── parsed.json
│           └── digest/
│               ├── request.json
│               └── response.json
├── daily/
│   └── 2026/09/
│       ├── 08.json
│       ├── 08.md
│       └── 08-digest.md
├── archive.json
└── latest.json
```

Run directory names include the numeric UTC offset to remain unambiguous across daylight-saving transitions. Story IDs are used as filenames only after validating that they match `^[0-9]+$` in full.

### Run Manifest

The manifest contains:

- Schema version and run ID.
- Status: `running`, `complete`, or `failed`.
- Start, completion, and per-stage timestamps.
- Source query and observation window.
- Provider, endpoint, model, and non-secret generation parameters.
- Story counts and quality/failure counts.
- Aggregate elapsed time and token usage when the server reports it.
- A structured error when the run fails.
- Relative paths to the final artifacts when complete.

### Daily JSON

The finalized daily record contains:

- Schema version.
- Briefing date and generation timestamp.
- Source window and originating run ID.
- Model identity and non-secret generation parameters.
- Digest text.
- An ordered array of stories using the existing `ProcessedStory` fields: HN ID, title, URL, points, comment count, post type, content summary, and discussion summary.
- Quality metadata sufficient for a downstream agent to decide whether to publish or flag the briefing.

`latest.json` is a small pointer containing the latest completed date, run ID, and relative daily JSON path. `archive.json` is ordered newest first and lists completed daily records. Downstream agents should use these two stable files rather than inspect in-progress run directories.

## Trace Capture

Trace capture belongs at shared inference boundaries so local execution does not duplicate prompt, parsing, or request-building logic. Shared summarization functions will accept an optional trace sink. The default remains no-op, preserving Worker behavior and avoiding Cloudflare subrequests.

The local runner supplies a filesystem trace sink that records:

- Exact system and user messages.
- Model, temperature, token limit, stop sequences, and other request parameters.
- Raw JSON response, including provider usage and timing extensions when present.
- Parsed summaries, finish reason, elapsed time, and quality flags.
- API and parsing errors in structured form.

Trace records exclude the API key and request headers. Capturing raw HN comment trees and prompts is acceptable because their source is public, but the directory remains private by design.

Retained prompts make future model comparisons reproducible without refetching Hacker News. A replay or benchmark command can be added separately after the first dataset reveals which comparisons are useful.

## Container Interface

The repository will include a Containerfile and Podman Compose configuration for a service that mounts a host directory at `/data`. The default command performs one live daily run. LLM settings are supplied through an ignored local environment file (`.env.pipeline`). The data directory is not set there: export `HN_BRIEF_DATA_DIR` in the shell, and always pass `--project-directory` rather than `--env-file`.

Representative commands:

```bash
export HN_BRIEF_DATA_DIR="$HOME/hn-brief-data"

# Run one briefing now
podman compose --project-directory "$PWD" run --rm hn-brief generate

# Show configuration/help without requiring a model request
podman compose --project-directory "$PWD" run --rm hn-brief --help

# Preview removal of old intermediate runs
podman compose --project-directory "$PWD" run --rm hn-brief prune --before 2026-10-01

# Remove only the previewed intermediate runs
podman compose --project-directory "$PWD" run --rm hn-brief prune --before 2026-10-01 --confirm
```

Time zone: run IDs and the briefing date in `daily/YYYY/MM/DD.json` use `TZ`, which defaults to `America/New_York`. The `prune --before` cutoff is compared against the date in the run ID, so it uses the same time zone.

The CLI must parse `--help` before resolving or probing an LLM. This corrects the current behavior where help fails when no API key is present.

## Intermediate-Run Pruning

Pruning is manual and defaults to a dry run. It accepts an explicit `YYYY-MM-DD` cutoff and lists the run directories older than that cutoff. Deletion occurs only with `--confirm`.

The pruning boundary is strictly `data/runs/`. The command must reject unsafe or malformed data roots and must never delete:

- `data/daily/`
- `data/archive.json`
- `data/latest.json`
- The cutoff date or newer run directories
- Entries that do not match the run-directory naming contract

There is no automatic retention period in the first version.

## Failure and Concurrency Semantics

- A lock in the data directory prevents overlapping scheduled runs.
- A crashed run's lock is reclaimed once it is 12 hours old. Younger locks keep later runs out.
- Failure to acquire the lock exits nonzero without modifying either run.
- Each intermediate artifact is written as soon as its stage finishes.
- Stable daily files and indexes use write-to-temporary-file followed by same-filesystem rename.
- A failed model response is retained even when it prevents publication.
- The command exits nonzero if generation fails; scheduler logs therefore reflect the failure.
- Final data from a previous successful run is never replaced by an incomplete or invalid run.

## Security and Operations

The Lunar Beacon endpoint accepted an unauthenticated test request. It should be restricted to a trusted LAN or VPN, firewalled, or placed behind authentication before exposure to an untrusted network. The pipeline itself will not publish or proxy the endpoint.

Operational documentation will cover:

- Building and running the container with rootless Podman on Linux and a Podman machine on macOS.
- Creating the bind-mounted data directory and local environment file.
- Scheduling a daily run on Linux and macOS.
- Reading `latest.json` from another local agent.
- Inspecting failed manifests and model traces.
- Previewing and confirming intermediate-run pruning.

## Verification

Automated tests will verify:

- Daily JSON schema and deterministic serialization.
- Trace capture of prompts, raw responses, usage, timings, parsed output, and errors.
- Redaction of API keys and authorization headers.
- Failed runs retain intermediates but do not update finalized files.
- Successful runs atomically publish daily data and pointers.
- Concurrent-run lock behavior.
- Pruning cutoff and dry-run behavior.
- Protection of final datasets and nonconforming paths during pruning.
- `--help` works without LLM configuration.
- Existing shared and Worker tests remain green when no trace sink is supplied.

Integration verification will:

1. Build the OCI image with Podman.
2. Mount a temporary host data directory.
3. Run a small fixture-backed generation without external APIs to validate filesystem behavior.
4. Run a minimal live compatibility probe against Lunar Beacon's `qwen3.8` model.
5. Inspect the generated manifest, retained request/response, and final JSON.

A full 20-story live run is expected to be slow and will be performed only when the operator is ready to create the first real daily dataset.

## Acceptance Criteria

- The same image runs with rootless Podman on Linux and a Podman machine on macOS.
- One command produces a retained run bundle and a complete daily JSON dataset in a mounted host directory.
- A downstream agent can find and read the newest successful briefing using only `latest.json`.
- Every model call needed for the briefing can be inspected after the run without exposing credentials.
- A failed run is visible, debuggable, and cannot corrupt the latest successful briefing.
- Intermediate runs persist until an operator explicitly confirms a cutoff-based prune.
