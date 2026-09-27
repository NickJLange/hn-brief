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
