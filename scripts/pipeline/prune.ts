import { readdir, rm } from "node:fs/promises";
import { parse, resolve } from "node:path";

const RUN_NAME = /^(\d{4}-\d{2}-\d{2})T\d{6}(?:Z|[+-]\d{4})$/;

function assertCutoff(before: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(before);
  const [year, month, day] = [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
  const valid = match !== null && new Date(Date.UTC(year, month - 1, day)).toISOString().startsWith(before);
  if (!valid) throw new Error(`Cutoff must be a valid YYYY-MM-DD date: ${before}`);
}

function assertDataRoot(dataRoot: string): string {
  const root = resolve(dataRoot);
  if (dataRoot.trim() === "" || root === parse(root).root) throw new Error(`Unsafe data root: "${dataRoot}"`);
  return root;
}

/** Lists `runs/<name>` directories directly under `dataRoot/runs` whose run date is strictly before `before`. */
export async function planPrune(dataRoot: string, before: string): Promise<string[]> {
  assertCutoff(before);
  const root = assertDataRoot(dataRoot);
  let entries;
  try {
    entries = await readdir(resolve(root, "runs"), { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(entry => entry.isDirectory())
    .flatMap(entry => {
      const date = RUN_NAME.exec(entry.name)?.[1];
      return date !== undefined && date < before ? [entry.name] : [];
    })
    .sort()
    .map(name => `runs/${name}`);
}

/** Previews pruning candidates; deletes them only when `confirm` is true. */
export async function pruneRuns(
  dataRoot: string,
  before: string,
  confirm: boolean
): Promise<{ candidates: string[]; deleted: string[] }> {
  const candidates = await planPrune(dataRoot, before);
  if (!confirm) return { candidates, deleted: [] };
  const root = resolve(dataRoot);
  for (const candidate of candidates) await rm(resolve(root, candidate), { recursive: true });
  return { candidates, deleted: candidates };
}
