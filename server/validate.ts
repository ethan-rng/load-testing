// Server-side checks for a launch request. The browser is never trusted: every
// value is checked here, with the same rules as src/lib/config.ts plus caps.

export const LIMITS = { maxVus: 500, maxDurationSec: 600, maxRampSec: 120 };
export const MODES = ["naive"] as const; // realistic is not built yet
export const PHASES = ["before", "during", "after"] as const;
const BLOCKED_HOSTS = ["hackwestern.com", "www.hackwestern.com"];

export interface RunParams {
  target: string;
  mode: (typeof MODES)[number];
  phase: (typeof PHASES)[number];
  vus: number;
  duration: string;
  rampUp: string;
}

type Env = Record<string, string | undefined>;
type Result = { ok: true; params: RunParams } | { ok: false; error: string };

const clean = (u: string) => u.trim().replace(/\/+$/, "");

/** Base URLs a run may target, from ALLOWED_TARGETS (comma separated). */
export function allowedTargets(env: Env = process.env): string[] {
  return (env.ALLOWED_TARGETS ?? "https://dev.hackwestern.com")
    .split(",")
    .map(clean)
    .filter(Boolean);
}

/** Throws at startup if the allowed list could ever include production. */
export function assertConfig(env: Env = process.env): void {
  for (const t of allowedTargets(env)) {
    let host: string;
    try {
      host = new URL(t).hostname.toLowerCase();
    } catch {
      throw new Error(`ALLOWED_TARGETS entry "${t}" is not a valid URL`);
    }
    if (BLOCKED_HOSTS.includes(host)) {
      throw new Error(`ALLOWED_TARGETS contains production (${host}). Refusing to start.`);
    }
  }
}

/** "30s" or "2m" to seconds, or null if it isn't one of those. */
export function parseDuration(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,4})(s|m)$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === "m" ? n * 60 : n;
}

const KNOWN = new Set(["target", "mode", "phase", "vus", "duration", "rampUp"]);

export function validateParams(input: unknown, env: Env = process.env): Result {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const o = input as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !KNOWN.has(k));
  if (extra.length) return { ok: false, error: `Unknown field(s): ${extra.join(", ")}` };

  const target = typeof o.target === "string" ? clean(o.target) : "";
  if (!allowedTargets(env).includes(target)) {
    return { ok: false, error: "target is not one of the allowed targets." };
  }

  const mode = o.mode ?? "naive";
  if (!(MODES as readonly unknown[]).includes(mode)) {
    return { ok: false, error: `mode must be one of: ${MODES.join(", ")}` };
  }
  const phase = o.phase ?? "during";
  if (!(PHASES as readonly unknown[]).includes(phase)) {
    return { ok: false, error: `phase must be one of: ${PHASES.join(", ")}` };
  }

  const vus = o.vus ?? 10;
  if (typeof vus !== "number" || !Number.isInteger(vus) || vus < 1 || vus > LIMITS.maxVus) {
    return { ok: false, error: `vus must be a whole number from 1 to ${LIMITS.maxVus}.` };
  }

  const duration = o.duration ?? "30s";
  const d = parseDuration(duration);
  if (d === null || d < 1 || d > LIMITS.maxDurationSec) {
    return { ok: false, error: `duration must look like 30s or 5m, at most ${LIMITS.maxDurationSec / 60} minutes.` };
  }
  const rampUp = o.rampUp ?? "10s";
  const r = parseDuration(rampUp);
  if (r === null || r < 0 || r > LIMITS.maxRampSec) {
    return { ok: false, error: `rampUp must look like 10s or 2m, at most ${LIMITS.maxRampSec / 60} minutes.` };
  }

  return {
    ok: true,
    params: {
      target,
      mode: mode as RunParams["mode"],
      phase: phase as RunParams["phase"],
      vus,
      duration: duration as string,
      rampUp: rampUp as string,
    },
  };
}
