import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPrune, pruneRuns } from "../scripts/pipeline/prune";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function makeDataRoot(): Promise<string> {
  const dataRoot = await mkdtemp(join(tmpdir(), "hn-brief-prune-"));
  roots.push(dataRoot);
  const runNames = [
    "2026-09-07T070000-0400", // older than cutoff: candidate
    "2026-09-07T230000-0400", // late on the day before cutoff: candidate
    "2026-09-08T070000-0400", // day before cutoff: candidate
    "2026-09-09T070000-0400", // on the cutoff date: must survive
    "2026-09-10T070000-0400", // newer: must survive
    "2026-09-08T070000Z", // UTC-form name older than cutoff: candidate
    "not-a-run" // nonconforming: must survive
  ];
  for (const name of runNames) {
    await mkdir(join(dataRoot, "runs", name), { recursive: true });
    await writeFile(join(dataRoot, "runs", name, "manifest.json"), "{}");
  }
  await mkdir(join(dataRoot, "daily", "2026", "09"), { recursive: true });
  await writeFile(join(dataRoot, "daily", "2026", "09", "08.json"), "{}");
  await writeFile(join(dataRoot, "archive.json"), "[]");
  await writeFile(join(dataRoot, "latest.json"), "{}");
  return dataRoot;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

const CANDIDATES = [
  "runs/2026-09-07T070000-0400",
  "runs/2026-09-07T230000-0400",
  "runs/2026-09-08T070000-0400",
  "runs/2026-09-08T070000Z"
];

test("planPrune lists only run directories strictly older than the cutoff date", async () => {
  const dataRoot = await makeDataRoot();
  expect(await planPrune(dataRoot, "2026-09-09")).toEqual(CANDIDATES);
});

test("dry run deletes nothing", async () => {
  const dataRoot = await makeDataRoot();
  const result = await pruneRuns(dataRoot, "2026-09-09", false);
  expect(result).toEqual({ candidates: CANDIDATES, deleted: [] });
  for (const candidate of CANDIDATES) expect(await exists(join(dataRoot, candidate))).toBe(true);
});

test("confirm deletes only the candidate runs and leaves final data and nonconforming paths", async () => {
  const dataRoot = await makeDataRoot();
  const result = await pruneRuns(dataRoot, "2026-09-09", true);
  expect(result).toEqual({ candidates: CANDIDATES, deleted: CANDIDATES });
  for (const candidate of CANDIDATES) expect(await exists(join(dataRoot, candidate))).toBe(false);
  expect(await exists(join(dataRoot, "runs/2026-09-09T070000-0400"))).toBe(true);
  expect(await exists(join(dataRoot, "runs/2026-09-10T070000-0400"))).toBe(true);
  expect(await exists(join(dataRoot, "runs/not-a-run"))).toBe(true);
  expect(await exists(join(dataRoot, "daily/2026/09/08.json"))).toBe(true);
  expect(await exists(join(dataRoot, "archive.json"))).toBe(true);
  expect(await exists(join(dataRoot, "latest.json"))).toBe(true);
});

test("a missing runs directory yields no candidates", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "hn-brief-prune-empty-"));
  roots.push(dataRoot);
  expect(await pruneRuns(dataRoot, "2026-09-09", true)).toEqual({ candidates: [], deleted: [] });
});

test("regular files named like runs are not candidates", async () => {
  const dataRoot = await makeDataRoot();
  await writeFile(join(dataRoot, "runs", "2026-09-01T070000-0400"), "not a directory");
  expect(await planPrune(dataRoot, "2026-09-09")).toEqual(CANDIDATES);
});

test("malformed cutoffs are rejected before any filesystem traversal", async () => {
  const dataRoot = await makeDataRoot();
  for (const before of ["2026-9-8", "2026-13-45", "2026-02-30", "../../etc", "", "2026-09-08T070000-0400"]) {
    await expect(planPrune(dataRoot, before)).rejects.toThrow(/YYYY-MM-DD/);
    await expect(pruneRuns(dataRoot, before, true)).rejects.toThrow(/YYYY-MM-DD/);
  }
  expect(await exists(join(dataRoot, "runs/2026-09-07T070000-0400"))).toBe(true);
});

test("unsafe data roots are rejected", async () => {
  await expect(planPrune("", "2026-09-09")).rejects.toThrow(/data root/);
  await expect(planPrune("/", "2026-09-09")).rejects.toThrow(/data root/);
});
