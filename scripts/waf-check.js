// Tests whether Vercel's firewall lets this machine through at load-test rates.
//
// It sends GET requests to one path in steps of rising speed, and records
// status codes, Vercel's mitigation headers, and latency for each step.
//
//   npm run check:waf                                 # from the allowlisted machine
//   npm run check:waf -- --expect=blocked             # from a machine that is NOT allowlisted
//   npm run check:waf -- --steps=5,20,50 --seconds=8
//
// Options (all optional):
//   --target=URL        defaults to TARGET from .env / the shell
//   --path=/api/...     defaults to /api/auth/csrf (cheap, public, no database)
//   --steps=10,25,50    requests per second for each step
//   --seconds=5         how long each step lasts
//   --expect=allowed    allowed (default): pass if nothing is challenged or blocked
//                       blocked: pass if the firewall does step in (proves the rule matters)
//   --force             lets a step go above 200 requests per second
//
// Exit code 0 means the result matched what you expected, 1 means it didn't.
// Same host rules as the load tests: production and unlisted hosts are refused.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BLOCKED_HOSTS = ["hackwestern.com", "www.hackwestern.com"];

// ---- settings: the shell beats .env, same as run.sh ----
const envFile = resolve(root, ".env");
const fileVals = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
const setting = (name, fallback = "") =>
  process.env[name] || fileVals[name] || fallback;

const flags = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"];
    }),
);

const target = (flags.target || setting("TARGET", "http://localhost:3000")).replace(/\/+$/, "");
const path = flags.path || "/api/auth/csrf";
const steps = (flags.steps || "5,20,50").split(",").map(Number);
const seconds = Number(flags.seconds || 5);
const expect = flags.expect || "allowed";
const allowedHosts = setting("ALLOWED_HOSTS", "dev.hackwestern.com")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

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
if (steps.some((n) => !Number.isFinite(n) || n < 1)) fail(`--steps must be whole numbers like 5,20,50.`);
if (!Number.isFinite(seconds) || seconds < 1) fail(`--seconds must be 1 or more.`);
if (Math.max(...steps) > 200 && flags.force !== "true") {
  fail(`A step above 200 requests per second needs --force.`);
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

async function runStep(rps) {
  const results = [];
  const pending = [];
  const t0 = performance.now();
  const total = rps * seconds;
  for (let i = 0; i < total; i++) {
    const due = t0 + (i * 1000) / rps;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
    pending.push(hit().then((r) => results.push(r)));
  }
  await Promise.all(pending);
  return results;
}

// ---- run ----
console.log(`WAF check against ${target}${path}`);
console.log(`Expecting: ${expect === "allowed" ? "no challenges or blocks (this machine is allowlisted)" : "the firewall steps in (this machine is not allowlisted)"}\n`);

const first = await hit();
if (first.status === 0) fail(`Could not reach ${target}${path} (${first.error}).`);
console.log(`First request: ${first.status}, server: ${first.server ?? "?"}, x-vercel-id: ${first.vercelId ?? "none"}`);
if (!first.vercelId && !local) {
  console.log("  ! No x-vercel-id header. This may not be going through Vercel, so the firewall isn't involved.");
}
console.log("");

const all = [];
let firstMitigationAt = null;
let sent = 0;
console.log("step   rps   sent   status codes            mitigated   p50 ms   p95 ms");
for (const rps of steps) {
  const results = await runStep(rps);
  const codes = {};
  for (const r of results) codes[r.status || "err"] = (codes[r.status || "err"] || 0) + 1;
  const mitigated = results.filter((r) => r.mitigated || r.status === 429).length;
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  if (mitigated && firstMitigationAt === null) firstMitigationAt = { rps, afterRequests: sent + results.findIndex((r) => r.mitigated || r.status === 429) };
  sent += results.length;
  all.push(...results);
  const codeText = Object.entries(codes).map(([c, n]) => `${c}:${n}`).join(" ");
  console.log(
    `${String(steps.indexOf(rps) + 1).padEnd(6)} ${String(rps).padEnd(5)} ${String(results.length).padEnd(6)} ${codeText.padEnd(23)} ${String(mitigated).padEnd(11)} ${String(Math.round(pct(times, 50))).padEnd(8)} ${Math.round(pct(times, 95))}`,
  );
  await sleep(1500); // let any rate-limit window settle between steps
}

// ---- verdict ----
const mitigatedAll = all.filter((r) => r.mitigated);
const rateLimited = all.filter((r) => r.status === 429);
const errors = all.filter((r) => r.status === 0);
const stepped = mitigatedAll.length > 0 || rateLimited.length > 0;

console.log("");
if (mitigatedAll.length) {
  const kinds = [...new Set(mitigatedAll.map((r) => r.mitigated))].join(", ");
  console.log(`Firewall action seen on ${mitigatedAll.length} request(s): ${kinds}`);
}
if (rateLimited.length) console.log(`${rateLimited.length} request(s) got 429 (rate limited).`);
if (errors.length) console.log(`${errors.length} request(s) failed to connect or timed out.`);
if (stepped && firstMitigationAt) {
  console.log(`First action at the ${firstMitigationAt.rps} rps step, around request #${firstMitigationAt.afterRequests + 1}.`);
}

let pass;
if (expect === "allowed") {
  pass = !stepped;
  console.log(
    pass
      ? `PASS: ${all.length} requests up to ${Math.max(...steps)} rps went through with no firewall action.\n` +
          "  Note: this shows you weren't blocked. To confirm the rule is why, run again from a\n" +
          "  non-allowlisted network with --expect=blocked."
      : "FAIL: the firewall acted on this machine, so the allow rule is not working for it.\n" +
          "  Check that the rule matches this machine's public IP, is published (not a draft),\n" +
          "  and that no other rule (e.g. a rate limit) sits above it.",
  );
} else {
  pass = stepped;
  console.log(
    pass
      ? "PASS: the firewall acted on this machine, so the rules are doing something."
      : "INCONCLUSIVE: nothing was blocked. Either this machine is allowlisted too, or the rate\n" +
          "  never reached a limit. Try higher --steps (needs --force above 200 rps).",
  );
}
process.exit(pass ? 0 : 1);
