import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunParams } from "./validate.ts";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RESULTS_DIR = resolve(ROOT, "results");
const FILE = resolve(ROOT, process.env.RUNS_FILE ?? "data/runs.json");

export type Status = "running" | "succeeded" | "failed" | "stopped" | "interrupted";

export interface Run {
  id: string;
  status: Status;
  params: RunParams;
  launchedBy: string;
  createdAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  summary: { p95Ms: number | null; errorRate: number | null; requests: number | null } | null;
  hasReport: boolean;
  /** Process group of the running run.sh, so it can be cleaned up after a crash. */
  pid: number | null;
}

let runs: Run[] = [];

export function loadStore(): void {
  mkdirSync(dirname(FILE), { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  runs = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Run[]) : [];
  // Anything still "running" when the server starts was cut off by a restart.
  let changed = false;
  for (const r of runs) {
    if (r.status === "running") {
      r.status = "interrupted";
      r.finishedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) save();
}

function save(): void {
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(runs, null, 2));
  renameSync(tmp, FILE); // atomic, so a crash can't leave half a file
}

export const listRuns = (): Run[] => [...runs].reverse();
export const getRun = (id: string): Run | undefined => runs.find((r) => r.id === id);
export const runningRun = (): Run | undefined => runs.find((r) => r.status === "running");

export function addRun(r: Run): void {
  runs.push(r);
  save();
}
export function updateRun(r: Run): void {
  save();
}
