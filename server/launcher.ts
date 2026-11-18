import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import { ROOT, RESULTS_DIR, addRun, getRun, runningRun, updateRun, type Run } from "./store.ts";
import type { RunParams } from "./validate.ts";

export interface Progress { pct: number; vus: number; maxVus: number }

interface Live {
  child: ChildProcess;
  progress: Progress | null;
  lines: string[];
  events: EventEmitter;
  stopping: boolean;
}
const live = new Map<string, Live>();
const MAX_LINES = 5000;

// Only these variables reach k6. Server secrets (OAuth, etc.) never do.
const PASS_THROUGH = ["PATH", "HOME", "DOCS_ROOT", "DOCS_TOKEN", "TEST_EMAIL", "TEST_PASSWORD", "ALLOWED_HOSTS"];

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const clean = (s: string) => s.replace(ANSI, "");

// k6 repeats a progress bar and a status line every second, and starts with a
// logo. The UI shows progress as a bar, so none of that goes in the log.
const PROGRESS = /^\s*\w+\s+\S?\s*\[\s*(\d+)%\s*\]\s+(\d+)\/(\d+)\s+VUs/;
const NOISE = [
  /^running \(\d+m[\d.]+s\)/,
  /^\s*\w+\s+\S?\s*\[\s*\d+%\s*\]/,
  /^[\s/\\|_()‾`.,'-]*(Grafana)?[\s/\\|_()‾`.,'-]*$/,
];
function parseProgress(line: string): Progress | null {
  const m = PROGRESS.exec(line);
  return m ? { pct: Number(m[1]), vus: Number(m[2]), maxVus: Number(m[3]) } : null;
}

function newId(p: RunParams): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${stamp}_${p.mode}_${p.phase}_${p.vus}vu_${randomBytes(2).toString("hex")}`;
}

export type StartResult = { ok: true; run: Run } | { ok: false; error: string };

export function startRun(params: RunParams, user: string): StartResult {
  if (runningRun()) return { ok: false, error: "A run is already in progress. Wait for it to finish or stop it." };

  const id = newId(params);
  const env: Record<string, string> = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  Object.assign(env, {
    TEST_ID: id,
    TARGET: params.target,
    MODE: params.mode,
    PHASE: params.phase,
    VUS: String(params.vus),
    DURATION: params.duration,
    RAMP_UP: params.rampUp,
    ALLOW_MUTATIONS: "false",
    NO_COLOR: "true",
    K6_NO_COLOR: "true",
  });

  const run: Run = {
    id, status: "running", params, launchedBy: user,
    createdAt: new Date().toISOString(), finishedAt: null,
    exitCode: null, summary: null, hasReport: false, pid: null,
  };

  const log = createWriteStream(resolve(RESULTS_DIR, `${id}.log`));
  // detached gives the child its own process group, so Stop can signal k6 too.
  const child = spawn(resolve(ROOT, "run.sh"), [], { cwd: ROOT, env, detached: true });
  const state: Live = { child, progress: null, lines: [], events: new EventEmitter(), stopping: false };
  live.set(id, state);
  run.pid = child.pid ?? null;
  addRun(run);

  const push = (chunk: Buffer) => {
    log.write(chunk);
    for (const line of clean(chunk.toString()).split(/\r?\n|\r/)) {
      if (!line.trim()) continue;
      const p = parseProgress(line);
      if (p) { state.progress = p; state.events.emit("progress", p); continue; }
      if (NOISE.some((re) => re.test(line))) continue;
      if (state.lines.length < MAX_LINES) state.lines.push(line);
      state.events.emit("line", line);
    }
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);

  child.on("error", (err) => push(Buffer.from(`Could not start run.sh: ${err.message}\n`)));
  child.on("close", (code) => {
    log.end();
    run.exitCode = code;
    run.pid = null;
    run.finishedAt = new Date().toISOString();
    run.status = state.stopping ? "stopped" : code === 0 ? "succeeded" : "failed";
    run.summary = readSummary(id);
    run.hasReport = existsSync(resolve(RESULTS_DIR, `${id}.html`));
    updateRun(run);
    state.events.emit("end");
    live.delete(id);
  });

  return { ok: true, run };
}

export function stopRun(id: string): boolean {
  const s = live.get(id);
  if (!s || !s.child.pid) return false;
  s.stopping = true;
  try { process.kill(-s.child.pid, "SIGINT"); } catch { /* already gone */ }
  // k6 usually exits on SIGINT; make sure it can't linger.
  setTimeout(() => { try { process.kill(-s.child.pid!, "SIGKILL"); } catch { /* exited */ } }, 15000).unref();
  return true;
}

/** Lines so far, plus a way to follow new ones. Works for finished runs too. */
export function followLogs(
  id: string, onLine: (l: string) => void, onEnd: () => void, onProgress: (p: Progress) => void = () => {},
): (() => void) | null {
  const s = live.get(id);
  if (s) {
    for (const l of s.lines) onLine(l);
    if (s.progress) onProgress(s.progress);
    s.events.on("line", onLine);
    s.events.on("progress", onProgress);
    s.events.once("end", onEnd);
    return () => { s.events.off("line", onLine); s.events.off("progress", onProgress); s.events.off("end", onEnd); };
  }
  if (!getRun(id)) return null;
  const f = resolve(RESULTS_DIR, `${id}.log`);
  if (existsSync(f)) {
    for (const line of clean(readFileSync(f, "utf8")).split(/\r?\n|\r/)) {
      if (line.trim() && !parseProgress(line) && !NOISE.some((re) => re.test(line))) onLine(line);
    }
  }
  onEnd();
  return () => {};
}

function readSummary(id: string): Run["summary"] {
  const f = resolve(RESULTS_DIR, `${id}.json`);
  if (!existsSync(f)) return null;
  try {
    const m = JSON.parse(readFileSync(f, "utf8")).metrics ?? {};
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    return {
      p95Ms: num(m.http_req_duration?.["p(95)"]),
      errorRate: num(m.http_req_failed?.value),
      requests: num(m.http_reqs?.count),
    };
  } catch {
    return null;
  }
}

export const activeRunId = (): string | null => runningRun()?.id ?? null;

const alive = (pid: number): boolean => {
  try { process.kill(-pid, 0); return true; } catch { return false; }
};

/** After a crash or restart: stop any k6 the previous server left running. */
export function reapOrphans(runs: Run[]): void {
  for (const r of runs) {
    if (r.status !== "interrupted" || !r.pid) continue;
    const pid = r.pid;
    if (alive(pid)) {
      console.warn(`stopping orphaned run ${r.id} (process group ${pid})`);
      try { process.kill(-pid, "SIGINT"); } catch { /* gone */ }
      setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* exited */ } }, 15000).unref();
    }
    r.pid = null;
    updateRun(r);
  }
}

/** On server shutdown: stop the active run so no load is left running. */
export async function stopAll(timeoutMs = 20000): Promise<void> {
  const ids = [...live.keys()];
  for (const id of ids) stopRun(id);
  const t0 = Date.now();
  while (live.size > 0 && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 200));
}
