// Simulated-user behaviour profiles, stored in SQLite.
//
// A profile is one recorded session: an ordered list of tRPC calls, each with the
// wait before it. Profiles are generated from a D1 export (which is itself SQLite),
// then can be edited, re-weighted, duplicated or deleted. The realistic k6 mode
// replays enabled profiles, picking each in proportion to its weight.
//
// Privacy: user_hash and timestamps from D1 are used to build sessions and are not
// stored. Only the order of calls and the gaps between them are kept.
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { DENY_LIST } from "../src/lib/denylist.ts";

export const PHASES = ["before", "during", "after", "unknown"] as const;
export type Phase = (typeof PHASES)[number];
export type StepType = "query" | "mutation";

export const LIMITS = { maxSteps: 500, maxGapMs: 600_000, maxName: 80, maxWeight: 1000, maxRows: 3_000_000 };

export interface Step { procedure: string; type: StepType; gapMs: number }
export interface ProfileSummary {
  id: number; name: string; phase: Phase; weight: number; enabled: boolean; source: string;
  createdAt: string; updatedAt: string; steps: number; durationMs: number;
}
export interface Profile extends Omit<ProfileSummary, "steps" | "durationMs"> { steps: Step[] }

// ---------- database ----------
export function openProfilesDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS profiles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      phase      TEXT    NOT NULL CHECK (phase IN ('before','during','after','unknown')),
      weight     REAL    NOT NULL DEFAULT 1 CHECK (weight >= 0),
      enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
      source     TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      updated_at TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile_steps (
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      idx        INTEGER NOT NULL,
      procedure  TEXT    NOT NULL,
      type       TEXT    NOT NULL CHECK (type IN ('query','mutation')),
      gap_ms     INTEGER NOT NULL DEFAULT 0 CHECK (gap_ms >= 0),
      PRIMARY KEY (profile_id, idx)
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_phase ON profiles (phase, enabled);
    CREATE INDEX IF NOT EXISTS idx_steps_proc ON profile_steps (procedure);
  `);
  return db;
}

const now = () => new Date().toISOString();
const PROC = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

type R = { ok: true } | { ok: false; error: string };
export function validateSteps(steps: unknown): { ok: true; steps: Step[] } | { ok: false; error: string } {
  if (!Array.isArray(steps)) return { ok: false, error: "steps must be a list." };
  if (steps.length > LIMITS.maxSteps) return { ok: false, error: `At most ${LIMITS.maxSteps} steps.` };
  const out: Step[] = [];
  for (const [i, raw] of steps.entries()) {
    const s = raw as Partial<Step> | null;
    const at = `Step ${i + 1}`;
    if (!s || typeof s !== "object") return { ok: false, error: `${at} is not an object.` };
    if (typeof s.procedure !== "string" || s.procedure.length > 100 || !PROC.test(s.procedure)) return { ok: false, error: `${at}: procedure must look like application.get.` };
    if (s.type !== "query" && s.type !== "mutation") return { ok: false, error: `${at}: type must be query or mutation.` };
    if (typeof s.gapMs !== "number" || !Number.isInteger(s.gapMs) || s.gapMs < 0 || s.gapMs > LIMITS.maxGapMs) return { ok: false, error: `${at}: wait must be 0 to ${LIMITS.maxGapMs / 1000} seconds.` };
    if (DENY_LIST.has(s.procedure)) return { ok: false, error: `${at}: ${s.procedure} is on the never-call list.` };
    out.push({ procedure: s.procedure, type: s.type, gapMs: s.gapMs });
  }
  return { ok: true, steps: out };
}

function checkName(name: unknown): R {
  if (typeof name !== "string" || !name.trim() || name.trim().length > LIMITS.maxName) return { ok: false, error: `Name is required, at most ${LIMITS.maxName} characters.` };
  return { ok: true };
}
const checkWeight = (w: unknown): R =>
  typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= LIMITS.maxWeight ? { ok: true } : { ok: false, error: `Weight must be 0 to ${LIMITS.maxWeight}.` };
const checkPhase = (p: unknown): R => ((PHASES as readonly unknown[]).includes(p) ? { ok: true } : { ok: false, error: `Phase must be one of: ${PHASES.join(", ")}.` });

function writeSteps(db: DatabaseSync, id: number, steps: Step[]): void {
  db.prepare("DELETE FROM profile_steps WHERE profile_id = ?").run(id);
  const ins = db.prepare("INSERT INTO profile_steps (profile_id, idx, procedure, type, gap_ms) VALUES (?,?,?,?,?)");
  steps.forEach((s, i) => ins.run(id, i, s.procedure, s.type, i === 0 ? 0 : s.gapMs));
}
// Transactions that can nest (generation wraps many createProfile calls, each of
// which is its own transaction). The outermost is BEGIN/COMMIT, inner ones are savepoints.
const depth = new WeakMap<DatabaseSync, number>();
function tx<T>(db: DatabaseSync, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  const name = `sp${d}`;
  db.exec(d === 0 ? "BEGIN" : `SAVEPOINT ${name}`);
  depth.set(db, d + 1);
  try {
    const v = fn();
    depth.set(db, d);
    db.exec(d === 0 ? "COMMIT" : `RELEASE ${name}`);
    return v;
  } catch (e) {
    depth.set(db, d);
    db.exec(d === 0 ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
    throw e;
  }
}

// ---------- reads ----------
const toSummary = (r: Record<string, unknown>): ProfileSummary => ({
  id: Number(r.id), name: String(r.name), phase: r.phase as Phase, weight: Number(r.weight), enabled: r.enabled === 1,
  source: String(r.source), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  steps: Number(r.steps ?? 0), durationMs: Number(r.dur ?? 0),
});

export interface ListQuery { phase?: string; q?: string; limit?: number; offset?: number }
export function listProfiles(db: DatabaseSync, q: ListQuery = {}): { total: number; items: ProfileSummary[] } {
  const phase = (PHASES as readonly string[]).includes(q.phase ?? "") ? q.phase! : null;
  const like = q.q ? `%${q.q.replace(/[%_\\]/g, "\\$&")}%` : null;
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  const where = "WHERE (?1 IS NULL OR p.phase = ?1) AND (?2 IS NULL OR p.name LIKE ?2 ESCAPE '\\')";
  const total = Number((db.prepare(`SELECT COUNT(*) n FROM profiles p ${where}`).get(phase, like) as { n: number }).n);
  const rows = db.prepare(`
    SELECT p.*, COUNT(s.idx) steps, COALESCE(SUM(s.gap_ms), 0) dur
    FROM profiles p LEFT JOIN profile_steps s ON s.profile_id = p.id ${where}
    GROUP BY p.id ORDER BY p.id DESC LIMIT ?3 OFFSET ?4`).all(phase, like, limit, offset) as Record<string, unknown>[];
  return { total, items: rows.map(toSummary) };
}

export function getProfile(db: DatabaseSync, id: number): Profile | null {
  const r = db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  const steps = (db.prepare("SELECT procedure, type, gap_ms FROM profile_steps WHERE profile_id = ? ORDER BY idx").all(id) as Record<string, unknown>[])
    .map((s) => ({ procedure: String(s.procedure), type: s.type as StepType, gapMs: Number(s.gap_ms) }));
  const { steps: _s, durationMs: _d, ...base } = toSummary(r);
  return { ...base, steps };
}

export interface Stats {
  phases: { phase: Phase; profiles: number; enabled: number }[];
  mix: { procedure: string; share: number }[];
  procedures: string[];
}
/** Counts per phase, and the share of calls each procedure gets once weights are applied. */
export function stats(db: DatabaseSync, phase?: string): Stats {
  const ph = (PHASES as readonly string[]).includes(phase ?? "") ? phase! : null;
  const phases = (db.prepare("SELECT phase, COUNT(*) n, SUM(enabled) e FROM profiles GROUP BY phase").all() as Record<string, unknown>[])
    .map((r) => ({ phase: r.phase as Phase, profiles: Number(r.n), enabled: Number(r.e ?? 0) }));
  const rows = db.prepare(`
    SELECT s.procedure, SUM(p.weight) w FROM profile_steps s JOIN profiles p ON p.id = s.profile_id
    WHERE p.enabled = 1 AND p.weight > 0 AND (?1 IS NULL OR p.phase = ?1)
    GROUP BY s.procedure ORDER BY w DESC`).all(ph) as { procedure: string; w: number }[];
  const total = rows.reduce((a, r) => a + r.w, 0) || 1;
  const procedures = (db.prepare("SELECT DISTINCT procedure FROM profile_steps ORDER BY procedure LIMIT 500").all() as { procedure: string }[]).map((r) => r.procedure);
  return { phases, mix: rows.slice(0, 12).map((r) => ({ procedure: r.procedure, share: r.w / total })), procedures };
}

// ---------- writes ----------
export function createProfile(db: DatabaseSync, input: { name?: unknown; phase?: unknown; weight?: unknown; steps?: unknown }, source = "manual"): { ok: true; id: number } | { ok: false; error: string } {
  const n = checkName(input.name); if (!n.ok) return n;
  const ph = checkPhase(input.phase ?? "during"); if (!ph.ok) return ph;
  const w = checkWeight(input.weight ?? 1); if (!w.ok) return w;
  const st = validateSteps(input.steps ?? []); if (!st.ok) return st;
  const phase = (input.phase ?? "during") as string;
  const weight = (input.weight ?? 1) as number;
  return tx(db, () => {
    const r = db.prepare("INSERT INTO profiles (name, phase, weight, enabled, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run((input.name as string).trim(), phase, weight, 1, source, now(), now());
    const id = Number(r.lastInsertRowid);
    writeSteps(db, id, st.steps);
    return { ok: true as const, id };
  });
}

export function updateProfile(db: DatabaseSync, id: number, patch: Record<string, unknown>): R {
  const allowed = new Set(["name", "phase", "weight", "enabled", "steps"]);
  const extra = Object.keys(patch).filter((k) => !allowed.has(k));
  if (extra.length) return { ok: false, error: `Unknown field(s): ${extra.join(", ")}` };
  if (!db.prepare("SELECT 1 FROM profiles WHERE id = ?").get(id)) return { ok: false, error: "No such profile." };
  let steps: Step[] | null = null;
  if ("name" in patch) { const r = checkName(patch.name); if (!r.ok) return r; }
  if ("phase" in patch) { const r = checkPhase(patch.phase); if (!r.ok) return r; }
  if ("weight" in patch) { const r = checkWeight(patch.weight); if (!r.ok) return r; }
  if ("enabled" in patch && typeof patch.enabled !== "boolean") return { ok: false, error: "enabled must be true or false." };
  if ("steps" in patch) { const r = validateSteps(patch.steps); if (!r.ok) return r; steps = r.steps; }
  tx(db, () => {
    if ("name" in patch) db.prepare("UPDATE profiles SET name = ? WHERE id = ?").run((patch.name as string).trim(), id);
    if ("phase" in patch) db.prepare("UPDATE profiles SET phase = ? WHERE id = ?").run(patch.phase as string, id);
    if ("weight" in patch) db.prepare("UPDATE profiles SET weight = ? WHERE id = ?").run(patch.weight as number, id);
    if ("enabled" in patch) db.prepare("UPDATE profiles SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, id);
    if (steps) writeSteps(db, id, steps);
    db.prepare("UPDATE profiles SET updated_at = ? WHERE id = ?").run(now(), id);
  });
  return { ok: true };
}

export function duplicateProfile(db: DatabaseSync, id: number): { ok: true; id: number } | { ok: false; error: string } {
  const p = getProfile(db, id);
  if (!p) return { ok: false, error: "No such profile." };
  return createProfile(db, { name: `${p.name} (copy)`.slice(0, LIMITS.maxName), phase: p.phase, weight: p.weight, steps: p.steps }, `copy:${id}`);
}

export function bulk(db: DatabaseSync, action: unknown, ids: unknown): { ok: true; changed: number } | { ok: false; error: string } {
  if (!["enable", "disable", "delete"].includes(action as string)) return { ok: false, error: "action must be enable, disable or delete." };
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 1000 || !ids.every((i) => Number.isInteger(i))) return { ok: false, error: "ids must be a list of 1 to 1000 whole numbers." };
  return tx(db, () => {
    let changed = 0;
    for (const id of ids as number[]) {
      const r = action === "delete" ? db.prepare("DELETE FROM profiles WHERE id = ?").run(id)
        : db.prepare("UPDATE profiles SET enabled = ?, updated_at = ? WHERE id = ?").run(action === "enable" ? 1 : 0, now(), id);
      changed += Number(r.changes);
    }
    return { ok: true as const, changed };
  });
}

// ---------- D1 import ----------
const NEED_COLS = ["ts", "procedure", "type", "status", "user_hash", "phase"];
export interface D1Summary { rows: number; phases: { phase: string; events: number; users: number }[] }

/** Cheap check that a file is a SQLite database with the D1 request_events table. */
export function inspectD1(path: string): { ok: true; summary: D1Summary } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: false, error: "File not found." };
  try {
    const fd = openSync(path, "r");
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    closeSync(fd);
    if (head.toString("latin1") !== "SQLite format 3\0") return { ok: false, error: "That isn't a SQLite database. Export D1 and convert it first (see the README)." };
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const cols = (db.prepare("PRAGMA table_info(request_events)").all() as { name: string }[]).map((c) => c.name);
      const missing = NEED_COLS.filter((c) => !cols.includes(c));
      if (!cols.length) return { ok: false, error: "No request_events table in that database." };
      if (missing.length) return { ok: false, error: `request_events is missing: ${missing.join(", ")}.` };
      const phases = (db.prepare("SELECT phase, COUNT(*) events, COUNT(DISTINCT user_hash) users FROM request_events GROUP BY phase ORDER BY events DESC").all() as Record<string, unknown>[])
        .map((r) => ({ phase: String(r.phase), events: Number(r.events), users: Number(r.users) }));
      return { ok: true, summary: { rows: phases.reduce((a, p) => a + p.events, 0), phases } };
    } finally { db.close(); }
  } catch (e) {
    return { ok: false, error: `Could not read that file: ${e instanceof Error ? e.message : "unknown error"}` };
  }
}

export interface GenOptions {
  phase: Phase;
  sessionGapMin: number;   // silence that ends a session
  minSteps: number;
  maxSteps: number;
  limit: number;           // how many profiles to create (random sample if there are more)
  maxGapSec: number;       // cap on any single wait, so replays stay short
  onlyOk: boolean;
  includeMutations: boolean;
  replace: boolean;        // delete earlier D1-generated profiles for this phase first
}
export const GEN_DEFAULTS: Omit<GenOptions, "phase"> = { sessionGapMin: 30, minSteps: 2, maxSteps: 100, limit: 200, maxGapSec: 120, onlyOk: true, includeMutations: false, replace: false };

export function parseGenOptions(raw: unknown): { ok: true; opts: GenOptions } | { ok: false; error: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const known = new Set(["file", "phase", "sessionGapMin", "minSteps", "maxSteps", "limit", "maxGapSec", "onlyOk", "includeMutations", "replace"]);
  const extra = Object.keys(o).filter((k) => !known.has(k));
  if (extra.length) return { ok: false, error: `Unknown field(s): ${extra.join(", ")}` };
  const num = (k: string, lo: number, hi: number, def: number): number | string => {
    const v = o[k] ?? def;
    return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : `${k} must be ${lo} to ${hi}.`;
  };
  const bool = (k: string, def: boolean): boolean | string => (o[k] === undefined ? def : typeof o[k] === "boolean" ? (o[k] as boolean) : `${k} must be true or false.`);
  const ph = checkPhase(o.phase); if (!ph.ok) return ph;
  const fields = {
    sessionGapMin: num("sessionGapMin", 1, 240, GEN_DEFAULTS.sessionGapMin), minSteps: num("minSteps", 1, 100, GEN_DEFAULTS.minSteps),
    maxSteps: num("maxSteps", 1, LIMITS.maxSteps, GEN_DEFAULTS.maxSteps), limit: num("limit", 1, 2000, GEN_DEFAULTS.limit),
    maxGapSec: num("maxGapSec", 1, LIMITS.maxGapMs / 1000, GEN_DEFAULTS.maxGapSec),
    onlyOk: bool("onlyOk", GEN_DEFAULTS.onlyOk), includeMutations: bool("includeMutations", GEN_DEFAULTS.includeMutations), replace: bool("replace", GEN_DEFAULTS.replace),
  };
  for (const v of Object.values(fields)) if (typeof v === "string") return { ok: false, error: v };
  const f = fields as unknown as Omit<GenOptions, "phase">;
  if (f.minSteps > f.maxSteps) return { ok: false, error: "minSteps can't be larger than maxSteps." };
  return { ok: true, opts: { phase: o.phase as Phase, ...f } };
}

export interface GenResult { sessions: number; created: number; tooShort: number; truncatedInput: boolean }

/** Builds profiles from a D1 export. `rand` is injectable so tests are deterministic. */
export function generateFromD1(db: DatabaseSync, srcPath: string, label: string, opts: GenOptions, rand: () => number = Math.random): GenResult {
  const check = inspectD1(srcPath);
  if (!check.ok) throw new Error(check.error);
  const src = new DatabaseSync(srcPath, { readOnly: true });
  const reservoir: Step[][] = [];
  let seen = 0, tooShort = 0, rows = 0, truncatedInput = false;
  try {
    const stmt = src.prepare(`
      SELECT ts, procedure, type, status, user_hash FROM request_events
      WHERE phase = ? AND user_hash IS NOT NULL ORDER BY user_hash, ts`);
    const gapMs = opts.sessionGapMin * 60_000;
    const capMs = opts.maxGapSec * 1000;
    let user: string | null = null, lastTs = 0, lastKept = 0;
    let cur: Step[] = [];
    const flush = () => {
      if (cur.length >= opts.minSteps) {
        seen++;
        const s = cur.slice(0, opts.maxSteps);
        if (reservoir.length < opts.limit) reservoir.push(s);
        else { const j = Math.floor(rand() * seen); if (j < opts.limit) reservoir[j] = s; }
      } else if (cur.length > 0) tooShort++;
      cur = [];
    };
    for (const r of stmt.iterate(opts.phase) as Iterable<Record<string, unknown>>) {
      if (++rows > LIMITS.maxRows) { truncatedInput = true; break; }
      const ts = Number(r.ts), uh = String(r.user_hash);
      if (uh !== user || ts - lastTs > gapMs) { flush(); user = uh; lastKept = 0; }
      lastTs = ts;
      const procedure = String(r.procedure), type = r.type === "mutation" ? "mutation" : "query";
      if (opts.onlyOk && r.status !== "OK") continue;
      if (type === "mutation" && !opts.includeMutations) continue;
      if (DENY_LIST.has(procedure) || !PROC.test(procedure)) continue;
      cur.push({ procedure, type, gapMs: cur.length === 0 ? 0 : Math.min(Math.max(ts - lastKept, 0), capMs) });
      lastKept = ts;
    }
    flush();
  } finally { src.close(); }

  tx(db, () => {
    if (opts.replace) db.prepare("DELETE FROM profiles WHERE phase = ? AND source LIKE 'd1:%'").run(opts.phase);
    reservoir.forEach((steps, i) => {
      const r = createProfile(db, { name: `${opts.phase} session ${i + 1}`, phase: opts.phase, weight: 1, steps }, `d1:${label}`);
      if (!r.ok) throw new Error(r.error);
    });
  });
  return { sessions: seen, created: reservoir.length, tooShort, truncatedInput };
}

// ---------- hand-off to k6 ----------
/** The file the realistic k6 mode reads. Compact on purpose: it is loaded once per VU. */
export function exportForK6(db: DatabaseSync, phase: Phase): { version: 1; phase: Phase; generatedAt: string; profiles: { id: number; name: string; weight: number; steps: { p: string; t: "q" | "m"; g: number }[] }[] } {
  const ids = db.prepare("SELECT id FROM profiles WHERE phase = ? AND enabled = 1 AND weight > 0 ORDER BY id").all(phase) as { id: number }[];
  const profiles = ids.map(({ id }) => {
    const p = getProfile(db, id)!;
    return { id: p.id, name: p.name, weight: p.weight, steps: p.steps.map((s) => ({ p: s.procedure, t: (s.type === "query" ? "q" : "m") as "q" | "m", g: s.gapMs })) };
  });
  return { version: 1, phase, generatedAt: now(), profiles };
}
