# Local HN Brief Data Pipeline

## Goal

Replace the failed hosted publishing path with a private, once-daily, Podman-operated pipeline that writes durable, agent-readable briefing data and retained inference traces to a filesystem directory.

## Proposed Changes

- Add optional LLM tracing to `shared/summarizer-core.ts` without changing Cloudflare Worker behavior.
- Add a local pipeline CLI under `scripts/pipeline/` for generation and confirmed pruning.
- Persist raw HN inputs, model requests/responses, parsed results, manifests, daily JSON, Markdown, archive, and latest pointers.
- Publish final records atomically and prevent overlapping generation runs.
- Add a `Containerfile` and Podman Compose configuration for Linux and macOS.
- Document rootless Linux scheduling, macOS `launchd`, downstream-agent discovery, failure inspection, and pruning.
- Correct the existing summarizer help path so it does not require LLM credentials.

The approved detailed design is `docs/superpowers/specs/2026-09-08-local-data-pipeline-design.md`.

## Verification

- Run targeted Bun tests for tracing, storage, generation, CLI behavior, and pruning.
- Run the complete `bun test` suite and `bunx tsc --noEmit`.
- Build and inspect the OCI image with Podman.
- Run fixture-backed generation into a temporary bind mount.
- Run a minimal live `qwen3.8` compatibility probe without performing a full 20-story generation.

## Verification Results

Recorded on 2026-09-08 (local time, America/New_York) on macOS arm64 with Podman 5.8.2.

- `bun test`: 80 pass, 0 fail, 8 files.
- `bunx tsc --noEmit`: does not exit 0. It reports 298 errors, nearly all for missing Bun/Node ambient types (for example `Cannot find name 'process'` and `'node:path'`). `@types/bun` is a devDependency but `tsconfig.json` does not load it for this check, and the base branch shows the same kinds of errors in the existing code (233 before this branch). Not fixed in this change.
- `git diff --check`: no output, exit 0.
- `podman build -f Containerfile -t localhost/hn-brief-pipeline:local .`: succeeded. `podman compose build` failed on this machine because `docker-credential-desktop` is not installed; the direct Podman build was used.
- In-container fixture test, `podman run --rm --entrypoint bun -v "$PWD:/src:ro,Z" -w /src localhost/hn-brief-pipeline:local test tests/pipeline-generate.test.ts`: 5 pass, 0 fail. The read-only mount did not block Bun.
- Live compatibility probe: one eight-token request to `lunarbeacon.newyork.nicklange.family:11434` for model `qwen3.8`. HTTP 200, assistant content `OK`, no API key sent.
- Full 20-story generation: not run. It is operator-triggered.
