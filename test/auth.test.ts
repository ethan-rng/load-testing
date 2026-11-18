import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startFakeGithub } from "./fake-github.ts";
import { sign, verify, loadAuthConfig } from "../server/auth.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SECRET = "x".repeat(40);
const PORT = 18400 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
let fake: Awaited<ReturnType<typeof startFakeGithub>>;
let server: ChildProcess;

const baseEnv = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "", AUTH_MODE: "github", PORT: String(PORT), PUBLIC_URL: BASE,
  GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", GITHUB_ORG: "hackwestern", LAUNCH_TEAM: "hw13-web",
  SESSION_SECRET: SECRET, ALLOWED_TARGETS: "http://localhost:3999",
  RUNS_FILE: join(mkdtempSync(join(tmpdir(), "lt-")), "runs.json"),
  GITHUB_WEB_URL: fake?.url ?? "", GITHUB_API_URL: fake?.url ?? "", ...extra,
});

before(async () => {
  fake = await startFakeGithub();
  server = spawn("node", ["server/index.ts"], { cwd: ROOT, env: baseEnv(), stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
});
after(() => { server?.kill(); fake?.close(); });

const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`));

/** Full sign-in as `who`. Returns the session cookie, or the callback response if refused. */
async function signIn(who: string): Promise<{ cookie?: string; res: Response }> {
  fake.setUser(who);
  const start = await fetch(`${BASE}/auth/login`, { redirect: "manual" });
  const stateCookie = cookieOf(start, "lt_oauth_state")!;
  const gh = await fetch(start.headers.get("location")!, { redirect: "manual" });
  const res = await fetch(gh.headers.get("location")!, { redirect: "manual", headers: { cookie: stateCookie } });
  return { cookie: cookieOf(res, "lt_session"), res };
}
const api = (path: string, cookie?: string, init: RequestInit = {}) =>
  fetch(BASE + path, { redirect: "manual", ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as object) } });
const post = (path: string, cookie: string, body: unknown, extra: Record<string, string> = {}) =>
  api(path, cookie, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-requested-with": "runs-ui", ...extra } });

test("without a session: page redirects to sign-in, API says 401, health is open", async () => {
  const page = await api("/");
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/auth/login");
  assert.equal((await api("/api/runs")).status, 401);
  assert.equal((await api("/api/config")).status, 401);
  assert.equal((await api("/healthz")).status, 200);
});

test("org member in the launch team can sign in and launch", async () => {
  const { cookie } = await signIn("alice");
  assert.ok(cookie, "got a session cookie");
  const cfg = await (await api("/api/config", cookie)).json();
  assert.deepEqual(cfg.user, { login: "alice", canLaunch: true });
  // An invalid body gets 400 (validation), not 403, so launching is permitted.
  assert.equal((await post("/api/runs", cookie!, { target: "https://hackwestern.com" })).status, 400);
});

test("org member outside the team is view-only", async () => {
  const { cookie } = await signIn("bob");
  const cfg = await (await api("/api/config", cookie)).json();
  assert.deepEqual(cfg.user, { login: "bob", canLaunch: false });
  assert.equal((await api("/api/runs", cookie)).status, 200);
  assert.equal((await post("/api/runs", cookie!, { target: "http://localhost:3999" })).status, 403);
});

test("non-members and pending invites are refused with no session", async () => {
  for (const who of ["mallory", "carol"]) {
    const { cookie, res } = await signIn(who);
    assert.equal(res.status, 403, who);
    assert.equal(cookie, undefined, who);
  }
});

test("forged, tampered and expired sessions are rejected", async () => {
  const forged = sign("y".repeat(40), { login: "alice", canLaunch: true, exp: Date.now() + 1e6 });
  assert.equal((await api("/api/config", `lt_session=${forged}`)).status, 401);
  const { cookie } = await signIn("bob");
  const [body, sig] = cookie!.replace("lt_session=", "").split(".");
  const upgraded = Buffer.from(JSON.stringify({ login: "bob", canLaunch: true, exp: Date.now() + 1e6 })).toString("base64url");
  assert.equal((await api("/api/config", `lt_session=${upgraded}.${sig}`)).status, 401, "edited payload");
  assert.equal((await api("/api/config", `lt_session=${body}`)).status, 401, "missing signature");
  const expired = sign(SECRET, { login: "alice", canLaunch: true, exp: Date.now() - 1000 });
  assert.equal((await api("/api/config", `lt_session=${expired}`)).status, 401, "expired");
});

test("callback rejects a wrong or missing state", async () => {
  fake.setUser("alice");
  const start = await fetch(`${BASE}/auth/login`, { redirect: "manual" });
  const stateCookie = cookieOf(start, "lt_oauth_state")!;
  const wrong = await fetch(`${BASE}/auth/callback?code=alice&state=nope`, { redirect: "manual", headers: { cookie: stateCookie } });
  assert.equal(wrong.status, 400);
  const noCookie = await fetch(`${BASE}/auth/callback?code=alice&state=abc`, { redirect: "manual" });
  assert.equal(noCookie.status, 400);
});

test("cross-site and header-less POSTs are refused even when signed in", async () => {
  const { cookie } = await signIn("alice");
  const body = { target: "http://localhost:3999" };
  assert.equal((await post("/api/runs", cookie!, body, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/runs", cookie!, body, { origin: "null" })).status, 403);
  const noHeader = await api("/api/runs", cookie, { method: "POST", body: JSON.stringify(body) });
  assert.equal(noHeader.status, 403);
});

test("sign out clears the cookie", async () => {
  const { cookie } = await signIn("alice");
  const out = await post("/auth/logout", cookie!, {});
  assert.equal(out.status, 200);
  assert.match(out.headers.getSetCookie().join(";"), /lt_session=;.*Max-Age=0/);
});

test("signed values round-trip and reject other secrets", () => {
  const v = sign("a".repeat(32), { n: 1 });
  assert.deepEqual(verify("a".repeat(32), v), { n: 1 });
  assert.equal(verify("b".repeat(32), v), null);
  assert.equal(verify("a".repeat(32), undefined), null);
});

test("config refuses unsafe or incomplete settings", () => {
  const good = { GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s", GITHUB_ORG: "o", LAUNCH_TEAM: "t", SESSION_SECRET: SECRET, PUBLIC_URL: "https://lt.example.com" };
  assert.doesNotThrow(() => loadAuthConfig(good));
  assert.throws(() => loadAuthConfig({ ...good, LAUNCH_TEAM: "" }), /LAUNCH_TEAM/);
  assert.throws(() => loadAuthConfig({ ...good, SESSION_SECRET: "short" }), /SESSION_SECRET/);
  assert.throws(() => loadAuthConfig({ ...good, PUBLIC_URL: "http://lt.example.com" }), /https/);
  assert.doesNotThrow(() => loadAuthConfig({ ...good, PUBLIC_URL: "http://localhost:8080" }));
});

test("server won't start with missing team or no auth mode", () => {
  const run = (extra: Record<string, string>, drop: string[] = []) => {
    const env = baseEnv(extra) as Record<string, string>;
    for (const k of drop) delete env[k];
    return spawnSync("node", ["server/index.ts"], { cwd: ROOT, env, encoding: "utf8", timeout: 5000 });
  };
  const noTeam = run({ PORT: String(PORT + 1) }, ["LAUNCH_TEAM"]);
  assert.notEqual(noTeam.status, 0);
  assert.match(noTeam.stderr, /LAUNCH_TEAM/);
  const noMode = run({ PORT: String(PORT + 1) }, ["AUTH_MODE"]);
  assert.notEqual(noMode.status, 0);
  assert.match(noMode.stderr, /AUTH_MODE/);
});
