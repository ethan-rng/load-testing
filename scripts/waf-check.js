// Tests Vercel's firewall / DDoS mitigation from this machine.
//
// It sends GET requests to one path at a rising rate, then holds the full rate,
// and stops as soon as Vercel starts refusing. That gives you "the load that
// gets us refused", which you can then re-run after opening the firewall.
//
// The workflow:
//   1. From the machine that is NOT yet allowlisted, find the refusal point:
//        npm run check:waf -- --preset=poll-500 --expect=blocked
//   2. Allow that machine's IP in Vercel (system bypass rule).
//   3. Run the same load again and confirm nothing is refused:
//        npm run check:waf -- --preset=poll-500
//
// Presets (a "user" polls once every `interval` seconds, like a live widget):
//   light            100 users, every 5s  =  20 req/s, 2 min
//   poll-500        500 users, every 2s  = 250 req/s, 5 min
//   poll-500-fast   500 users, every 1s  = 500 req/s, 5 min
//   burst            500 users, every 0.5s = 1000 req/s, 1 min
//
// Or set the shape yourself:
//   --users=500 --interval=2 --hold=300     (rate = users / interval)
//   --steps=5,20,50 --seconds=5             (plain rate steps, no ramp)
//
// Other options:
//   --target=URL     defaults to TARGET from .env / the shell
//   --path=/api/...  defaults to /api/auth/csrf (cheap, public, no database).
//                    Another public choice: /api/schedule (check it returns 200).
//   --expect=allowed (default) pass if nothing is refused
//   --expect=blocked pass if Vercel does refuse
//   --keep-going     don't stop at the first refusal
//   --force          allow rates above 200 req/s (presets above 200 set this for you)
//
// Exit code: 0 result matched what you expected, 1 it didn't, 2 setup/guard error.
// Same host rules as the load tests: production and unlisted hosts are refused.
// Dev targets only. This is real load, so keep --path on something cheap.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BLOCKED_HOSTS = ["hackwestern.com", "www.hackwestern.com"];
const WINDOW = 10; // seconds per reported row

const PRESETS = {
  light: { users: 100, interval: 5, hold: 120 },
  "poll-500": { users: 500, interval: 2, hold: 300 },
  "poll-500-fast": { users: 500, interval: 1, hold: 300 },
  burst: { users: 500, interval: 0.5, hold: 60 },
};

// ---- settings: the shell beats .env, same as run.sh ----
const envFile = resolve(root, ".env");
const fileVals = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
const setting = (name, fallback = "") => process.env[name] || fileVals[name] || fallback;

const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"];
    }),
);

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

if (flags.preset && !PRESETS[flags.preset]) {
  fail(`Unknown preset "${flags.preset}". Choose one of: ${Object.keys(PRESETS).join(", ")}`);
}
const preset = flags.preset ? PRESETS[flags.preset] : {};

const target = (flags.target || setting("TARGET", "http://localhost:3000")).replace(/\/+$/, "");
const path = flags.path || "/api/auth/csrf";
const expect = flags.expect || "allowed";
const keepGoing = flags["keep-going"] === "true";
const users = Number(flags.users ?? preset.users ?? 0);
const interval = Number(flags.interval ?? preset.interval ?? 2);
const hold = Number(flags.hold ?? preset.hold ?? 300);
const steps = (flags.steps || "5,20,50").split(",").map(Number);
const seconds = Number(flags.seconds || 5);
const allowedHosts = setting("ALLOWED_HOSTS", "dev.hackwestern.com")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

let url;
try {
  url = new URL(target);
} catch {
  fail(`TARGET "${target}" is not a valid URL.`);
}
const host = url.hostname.toLowerCase();
const local = host === "localhost" || host === "127.0.0.1";
if (BLOCKED_HOSTS.includes(host)) fail(`Refusing to test ${host}: that is production.`);
if (!local && !allowedHosts.includes(host)) {
  fail(`Host ${host} is not in ALLOWED_HOSTS (${allowedHosts.join(", ")}).`);
}
if (!["allowed", "blocked"].includes(expect)) fail(`--expect must be allowed or blocked.`);

// ---- build the plan: a list of windows, each { rps, secs, phase } ----
let plan = [];
if (users > 0) {
  if (!(interval > 0) || !(hold >= 1)) fail(`--interval must be above 0 and --hold at least 1.`);
  const full = Math.max(1, Math.round(users / interval));
  // ramp up so you can see roughly where it starts, then hold the full rate
  for (const f of [0.1, 0.25, 0.5, 0.75]) plan.push({ rps: Math.max(1, Math.round(full * f)), secs: WINDOW, phase: "ramp" });
  for (let left = hold; left > 0; left -= WINDOW) plan.push({ rps: full, secs: Math.min(WINDOW, left), phase: "hold" });
} else {
  if (steps.some((n) => !Number.isFinite(n) || n < 1)) fail(`--steps must be whole numbers like 5,20,50.`);
  if (!Number.isFinite(seconds) || seconds < 1) fail(`--seconds must be 1 or more.`);
  plan = steps.map((rps) => ({ rps, secs: seconds, phase: "step" }));
}
const peak = Math.max(...plan.map((p) => p.rps));
if (peak > 200 && flags.force !== "true" && !flags.preset) {
  fail(`A rate above 200 requests per second needs --force (this plan peaks at ${peak}).`);
}

// ---- helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

// Vercel sets x-vercel-mitigated when its firewall acts on a request (value
// such as "challenge" or "deny"). Challenge pages are also recognisable by
// their body text, so check both.
async function hit() {
  const started = performance.now();
  try {
    const res = await fetch(target + path, { signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    const mitigated = res.headers.get("x-vercel-mitigated");
    const challengePage = /Vercel Security Checkpoint|Attack Challenge|Verifying your browser/i.test(text.slice(0, 4000));
    return {
      status: res.status,
      ms: performance.now() - started,
      mitigated: mitigated || (challengePage ? "challenge-page" : null),
      server: res.headers.get("server"),
      vercelId: res.headers.get("x-vercel-id"),
    };
  } catch (err) {
    return { status: 0, ms: performance.now() - started, error: err.cause?.code || err.name };
  }
}

// Open loop: requests go out on schedule whether or not earlier ones finished.
async function runWindow(rps, secs) {
  const results = [];
  const pending = [];
  const t0 = performance.now();
  const total = Math.round(rps * secs);
  for (let i = 0; i < total; i++) {
    const wait = t0 + (i * 1000) / rps - performance.now();
    if (wait > 0) await sleep(wait);
    pending.push(hit().then((r) => results.push(r)));
  }
  await Promise.all(pending);
  return results;
}

const isRefused = (r) => !!r.mitigated || r.status === 429;

// ---- run ----
const totalSecs = plan.reduce((a, p) => a + p.secs, 0);
console.log(`WAF check against ${target}${path}`);
if (users > 0) console.log(`Load: ${users} users polling every ${interval}s = up to ${peak} req/s, about ${Math.round(totalSecs / 60 * 10) / 10} min`);
else console.log(`Load: steps of ${steps.join(", ")} req/s, ${seconds}s each`);
console.log(`Expecting: ${expect === "allowed" ? "no refusals (this machine should be allowlisted)" : "Vercel refuses at some point (this machine is not allowlisted yet)"}\n`);

const first = await hit();
if (first.status === 0) fail(`Could not reach ${target}${path} (${first.error}).`);
console.log(`First request: ${first.status}, server: ${first.server ?? "?"}, x-vercel-id: ${first.vercelId ?? "none"}`);
if (first.status < 200 || first.status >= 300) {
  console.log(`  ! ${path} returned ${first.status}, so the numbers below describe that response, not a working page.`);
}
if (!first.vercelId && !local) {
  console.log("  ! No x-vercel-id header. This may not be going through Vercel, so the firewall isn't involved.");
}
console.log("\n elapsed   rps   sent   status codes            refused   p50 ms   p95 ms");

const all = [];
let elapsed = 0;
let refusal = null;
for (const w of plan) {
  const results = await runWindow(w.rps, w.secs);
  elapsed += w.secs;
  all.push(...results);
  const codes = {};
  for (const r of results) codes[r.status || "err"] = (codes[r.status || "err"] || 0) + 1;
  const refused = results.filter(isRefused);
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const codeText = Object.entries(codes).map(([c, n]) => `${c}:${n}`).join(" ");
  console.log(
    ` ${String(elapsed + "s").padEnd(9)} ${String(w.rps).padEnd(5)} ${String(results.length).padEnd(6)} ${codeText.padEnd(23)} ${String(refused.length).padEnd(9)} ${String(Math.round(pct(times, 50))).padEnd(8)} ${Math.round(pct(times, 95))}`,
  );
  // A header or challenge page is definite. Bare 429s count once they are 5% of a window.
  const definite = refused.some((r) => r.mitigated);
  const many = refused.length >= Math.max(1, results.length * 0.05);
  if (!refusal && (definite || many)) {
    refusal = { rps: w.rps, at: elapsed, phase: w.phase, sentBefore: all.length - results.length };
    if (!keepGoing) {
      console.log(`\n  Refused during this window, stopping so we don't keep hammering. (--keep-going to continue)`);
      break;
    }
  }
  await sleep(500);
}

// ---- verdict ----
const refusedAll = all.filter(isRefused);
const errors = all.filter((r) => r.status === 0);
const kinds = [...new Set(refusedAll.map((r) => r.mitigated || `HTTP ${r.status}`))].join(", ");

console.log("");
console.log(`Sent ${all.length} requests. ${refusedAll.length} refused${kinds ? ` (${kinds})` : ""}.${errors.length ? ` ${errors.length} failed to connect or timed out.` : ""}`);
if (refusal) {
  console.log(`First refusal: in the window ending ${refusal.at}s, at ${refusal.rps} req/s (${refusal.phase} phase), after about ${refusal.sentBefore} requests.`);
}

let pass;
if (expect === "allowed") {
  pass = !refusal;
  console.log(
    pass
      ? `PASS: ${all.length} requests up to ${peak} req/s went through with nothing refused.\n` +
          "  This shows you weren't blocked. To prove the allow rule is why, run it once before\n" +
          "  adding the rule with --expect=blocked and see it refuse."
      : "FAIL: Vercel refused this machine, so the allow rule is not working for it.\n" +
          "  Check that the rule matches this machine's public IP, is published (not a draft),\n" +
          "  and that no other rule sits above it. A block from earlier may also still be in effect.",
  );
} else {
  pass = !!refusal;
  console.log(
    pass
      ? `PASS: Vercel refused at about ${refusal.rps} req/s. That is your trigger point.\n` +
          "  Next: allow this machine's IP in Vercel, wait for it to publish, then run the same\n" +
          `  command without --expect=blocked${flags.preset ? ` (--preset=${flags.preset})` : ""} and it should pass.\n` +
          "  Note: after being refused, this IP may stay blocked for a while, so a first re-run\n" +
          "  right after adding the rule can still fail until the block clears."
      : "INCONCLUSIVE: nothing was refused. Vercel's automatic protection may need more load or\n" +
          "  more time than this, or a rule you expect to trigger isn't active. Try a heavier\n" +
          "  preset (poll-500-fast, then burst) or a longer --hold.",
  );
}
process.exit(pass ? 0 : 1);
