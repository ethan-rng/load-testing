// Checks that .env (plus anything set in the shell) is complete and sensible
// before you run a load test.
//
//   npm run check:env                 # checks .env and the shell
//   npm run check:env -- --online     # also tries the target and the app map
//   npm run check:env -- --file=path  # check a different env file
//
// Exits 1 if anything is wrong, 0 otherwise (warnings don't fail it).
// Never prints DOCS_TOKEN or TEST_PASSWORD.
//
// The rules mirror src/lib/config.ts. If you change one, change the other.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const online = args.includes("--online");
const fileArg = args.find((a) => a.startsWith("--file="));
const envPath = resolve(root, fileArg ? fileArg.slice("--file=".length) : ".env");

const BLOCKED_HOSTS = ["hackwestern.com", "www.hackwestern.com"];
const MODES = ["naive", "realistic"];
const PHASES = ["before", "during", "after"];
const DURATION = /^\d+(ms|s|m|h)$/;

// ---- load values: the shell beats the file, same as run.sh ----
const out = { errors: 0, warnings: 0 };
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => (out.warnings++, console.log(`  ! ${m}`));
const bad = (m) => (out.errors++, console.log(`  ✗ ${m}`));

console.log("Environment check\n");

let fileVals = {};
if (existsSync(envPath)) {
  try {
    fileVals = parseEnv(readFileSync(envPath, "utf8"));
    ok(`read ${envPath.replace(root + "/", "")}`);
  } catch (err) {
    bad(`could not parse ${envPath}: ${err.message}`);
  }
} else {
  warn(`no ${envPath.replace(root + "/", "")} file. Using shell variables and defaults only (copy .env.example to .env).`);
}

const get = (name, fallback = "") => {
  const shell = process.env[name];
  if (shell !== undefined && shell !== "") return shell;
  const f = fileVals[name];
  return f !== undefined && f !== "" ? f : fallback;
};

const parseUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
};

const unknown = Object.keys(fileVals).filter(
  (k) =>
    ![
      "TARGET", "MODE", "PHASE", "ALLOWED_HOSTS", "VUS", "DURATION", "RAMP_UP",
      "ALLOW_MUTATIONS", "TEST_EMAIL", "TEST_PASSWORD", "DOCS_ROOT", "DOCS_TOKEN",
    ].includes(k),
);
if (unknown.length) warn(`unknown setting(s) in the env file, probably typos: ${unknown.join(", ")}`);

// ---- target ----
console.log("\nTarget");
const target = get("TARGET", "http://localhost:3000").replace(/\/+$/, "");
const targetUrl = parseUrl(target);
const allowedHosts = get("ALLOWED_HOSTS", "dev.hackwestern.com")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

if (!targetUrl) {
  bad(`TARGET "${target}" is not a valid http(s) URL`);
} else {
  const host = targetUrl.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1";
  if (BLOCKED_HOSTS.includes(host)) {
    bad(`TARGET is ${host}, which is production. The run will be refused.`);
  } else if (!local && !allowedHosts.includes(host)) {
    bad(`TARGET host ${host} is not in ALLOWED_HOSTS (${allowedHosts.join(", ") || "empty"}). The run will be refused.`);
  } else {
    ok(`TARGET ${target}`);
  }
}
const prodAllowed = allowedHosts.filter((h) => BLOCKED_HOSTS.includes(h));
if (prodAllowed.length) bad(`ALLOWED_HOSTS contains production host(s): ${prodAllowed.join(", ")}`);

// ---- mode and phase ----
console.log("\nMode");
const mode = get("MODE", "naive");
if (!MODES.includes(mode)) bad(`MODE "${mode}" must be one of: ${MODES.join(", ")}`);
else if (mode === "realistic") warn("MODE=realistic is not built yet. The run will stop at setup.");
else ok(`MODE ${mode}`);

const phase = get("PHASE", "during");
if (!PHASES.includes(phase)) bad(`PHASE "${phase}" must be one of: ${PHASES.join(", ")}`);
else ok(`PHASE ${phase}${mode === "naive" ? " (ignored in naive mode)" : ""}`);

// ---- load shape ----
console.log("\nLoad");
const vusRaw = get("VUS", "10");
const vus = Number(vusRaw);
if (!Number.isInteger(vus) || vus < 1) bad(`VUS "${vusRaw}" must be a whole number of 1 or more`);
else {
  ok(`VUS ${vus}`);
  if (vus > 500) warn(`VUS ${vus} is above 500. A single machine may not generate that reliably.`);
}
for (const [name, def] of [["DURATION", "30s"], ["RAMP_UP", "10s"]]) {
  const v = get(name, def);
  if (!DURATION.test(v)) bad(`${name} "${v}" must look like 30s, 2m, or 1h`);
  else ok(`${name} ${v}`);
}
const mutations = get("ALLOW_MUTATIONS", "false");
if (!["true", "false"].includes(mutations)) bad(`ALLOW_MUTATIONS "${mutations}" must be true or false`);
else if (mutations === "true") warn("ALLOW_MUTATIONS=true. POST calls will be sent to the target.");
else ok("ALLOW_MUTATIONS false (read-only)");

// ---- login ----
console.log("\nLogin");
const email = get("TEST_EMAIL");
const password = get("TEST_PASSWORD");
const hasUsersFile = existsSync(resolve(root, "data/users.json"));
if (hasUsersFile) ok("data/users.json found, so seeded users will be used");
if (email && !password) bad("TEST_EMAIL is set but TEST_PASSWORD is not");
else if (!email && password) bad("TEST_PASSWORD is set but TEST_EMAIL is not");
else if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad(`TEST_EMAIL "${email}" doesn't look like an email`);
else if (email) ok(`TEST_EMAIL ${email}, TEST_PASSWORD set`);
else if (!hasUsersFile) warn("no TEST_EMAIL/TEST_PASSWORD and no data/users.json. Only anonymous routes will be called.");

// ---- app map ----
console.log("\nApp map");
const docsRootRaw = get("DOCS_ROOT", target);
const docsRoot = docsRootRaw.replace(/\/+$/, "");
const token = get("DOCS_TOKEN");
const hasFallback = existsSync(resolve(root, "data/app.json"));
if (!parseUrl(docsRoot)) bad(`DOCS_ROOT "${docsRootRaw}" is not a valid http(s) URL`);
else ok(`DOCS_ROOT ${docsRoot}${get("DOCS_ROOT") ? "" : " (defaults to TARGET)"}`);
if (token) ok("DOCS_TOKEN set");
else warn("DOCS_TOKEN not set, so the app map can't be fetched at runtime.");
if (hasFallback) ok("data/app.json fallback found");
else if (!token) warn("no DOCS_TOKEN and no data/app.json. The route check will be skipped.");
else warn("no data/app.json fallback (run npm run fetch:app-map to make one)");

// ---- optional: try the real servers ----
if (online) {
  console.log("\nOnline checks");
  const probe = async (label, url, init) => {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
      return { label, res };
    } catch (err) {
      bad(`${label}: could not reach ${url} (${err.cause?.code || err.message})`);
      return null;
    }
  };
  if (targetUrl) {
    const r = await probe("target", `${target}/api/auth/csrf`);
    if (r) r.res.ok ? ok(`target answers (${r.res.status})`) : bad(`target returned ${r.res.status} for /api/auth/csrf`);
  }
  if (token && parseUrl(docsRoot)) {
    const r = await probe("app map", `${docsRoot}/api/docs/app`, { headers: { authorization: `Bearer ${token}` } });
    if (r) {
      if (r.res.status === 200) ok("app map fetch works with DOCS_TOKEN");
      else if (r.res.status === 401) bad("app map returned 401: DOCS_TOKEN is wrong");
      else if (r.res.status === 503) bad("app map returned 503: docs are not configured on that server");
      else bad(`app map returned ${r.res.status}`);
    }
  }
  if (targetUrl && email && password) {
    const csrfRes = await probe("login", `${target}/api/auth/csrf`);
    if (csrfRes?.res.ok) {
      const setCookie = csrfRes.res.headers.getSetCookie?.() ?? [];
      const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
      const { csrfToken } = await csrfRes.res.json();
      const form = new URLSearchParams({ username: email, password, csrfToken, json: "true" });
      const login = await probe("login", `${target}/api/auth/callback/credentials`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: form,
        redirect: "manual",
      });
      if (login) {
        const sessionCookies = (login.res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
        const all = [cookie, ...sessionCookies].filter(Boolean).join("; ");
        const session = await probe("login", `${target}/api/auth/session`, { headers: { cookie: all } });
        const body = session ? await session.res.json().catch(() => null) : null;
        if (body?.user) ok("test account can log in");
        else if (session) bad("test account could not log in (wrong email/password, or the user doesn't exist on that target)");
      }
    }
  }
}

// ---- result ----
console.log(
  `\n${out.errors ? "✗" : "✓"} ${out.errors} error(s), ${out.warnings} warning(s)` +
    (out.errors ? "  Fix the errors before running." : "  Ready to run."),
);
process.exit(out.errors ? 1 : 0);
