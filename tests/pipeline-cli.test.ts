import { expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

async function run(args: string[]) {
  const proc = Bun.spawn(["bun", "run", ...args], {
    cwd: repoRoot,
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

test("pipeline --help and prune --help exit 0 without LLM configuration", async () => {
  const help = await run(["scripts/pipeline/cli.ts", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("prune --before YYYY-MM-DD");
  expect(help.stderr).not.toContain("No LLM API key");

  const pruneHelp = await run(["scripts/pipeline/cli.ts", "prune", "--help"]);
  expect(pruneHelp.code).toBe(0);
  expect(pruneHelp.stdout).toContain("--confirm");
});

test("prune without --before exits nonzero with a usage error", async () => {
  const result = await run(["scripts/pipeline/cli.ts", "prune"]);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("--before YYYY-MM-DD");
});

test("prune rejects a malformed cutoff with a clear error", async () => {
  const result = await run(["scripts/pipeline/cli.ts", "prune", "--before", "2026-9-8"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("YYYY-MM-DD");
});

test("summarizer --help exits 0 without API keys", async () => {
  const result = await run(["scripts/summarizer.ts", "--help"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("HN-Brief Summarizer");
  expect(result.stderr).not.toContain("No LLM API key");
});
