import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeSampleD1 } from "../scripts/make-sample-d1.ts";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 18900 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "papi-"));
const DATA = join(tmp, "data"), IMPORTS = join(tmp, "imports");
let server: ChildProcess;

before(async () => {
  server = spawn("node", ["server/index.ts"], { cwd: ROOT, stdio: "ignore", env: {
    PATH: process.env.PATH ?? "", AUTH_MODE: "none", PORT: String(PORT), ALLOWED_TARGETS: "http://localhost:3999",
    RUNS_FILE: join(tmp, "runs.json"), PROFILES_DB: join(tmp, "p.db"), IMPORTS_DIR: IMPORTS, DATA_DIR: DATA } });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not start");
});
after(() => server?.kill());

const H = { "x-requested-with": "runs-ui" };
const j = (path: string, method = "GET", body?: unknown) =>
  fetch(BASE + path, { method, headers: { ...H, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
// TypeScript's DOM types don't accept Uint8Array as a body even though fetch does.
const asBody = (d: Uint8Array | string) => d as unknown as BodyInit;
const upload = (name: string, data: Uint8Array | string) =>
  fetch(BASE + "/api/imports", { method: "POST", headers: { ...H, "x-filename": name, "content-type": "application/octet-stream" }, body: asBody(data) });

let sampleBytes: Uint8Array;
test("upload: accepts a D1-shaped SQLite file and rejects everything else", async () => {
  const f = join(tmp, "sample.db");
  makeSampleD1(f, 80, 11);
  sampleBytes = new Uint8Array(readFileSync(f));
  const ok = await upload("d1-export.db", sampleBytes);
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.name, "d1-export.db");
  assert.ok(body.summary.rows > 0);

  assert.equal((await upload("notes.db", "just some text")).status, 400, "not sqlite");
  for (const bad of ["../escape.db", "..%2Fescape.db", "a/b.db", "noext", "x.txt", ".hidden.db", "a b.db", "x".repeat(80) + ".db", "x.db\0"]) {
    const r = await fetch(BASE + "/api/imports", { method: "POST", headers: { ...H, "x-filename": bad }, body: asBody(sampleBytes) }).catch(() => null);
    assert.ok(!r || r.status === 400, `file name ${JSON.stringify(bad)} should be refused, got ${r?.status}`);
  }
  assert.ok(!existsSync(join(tmp, "escape.db")) && !existsSync(join(IMPORTS, "..", "escape.db")), "nothing written outside the imports folder");
  assert.ok(!readdirSync(IMPORTS).some((f) => f.startsWith(".upload-")), "temp files are cleaned up");
  assert.deepEqual(readdirSync(IMPORTS), ["d1-export.db"]);
});

test("a second upload with the same name doesn't overwrite", async () => {
  const r = await upload("d1-export.db", sampleBytes);
  assert.equal(r.status, 201);
  const name = (await r.json()).name;
  assert.notEqual(name, "d1-export.db");
  assert.equal((await j(`/api/imports/${name}`, "DELETE")).status, 200);
  const list = await (await j("/api/imports")).json();
  assert.deepEqual(list.map((f: { name: string }) => f.name), ["d1-export.db"]);
});

test("import names can't be used to reach other files", async () => {
  for (const n of ["..%2F..%2Fetc%2Fpasswd", "%2E%2E%2Fp.db", "p.db%00", "d1-export.db%2F..%2F..%2Fx.db"]) {
    assert.equal((await j(`/api/imports/${n}/summary`)).status, 404, n);
    assert.equal((await j(`/api/imports/${n}`, "DELETE")).status, 404, n);
  }
  const s = await j("/api/imports/d1-export.db/summary");
  assert.equal(s.status, 200);
  assert.ok((await s.json()).phases.length > 0);
});

test("generate: validates input, then builds profiles", async () => {
  const gen = (b: unknown) => j("/api/profiles/generate", "POST", b);
  assert.equal((await gen({ phase: "during" })).status, 400, "file required");
  assert.equal((await gen({ file: "../../etc/passwd", phase: "during" })).status, 400);
  assert.equal((await gen({ file: "missing.db", phase: "during" })).status, 400);
  assert.equal((await gen({ file: "d1-export.db", phase: "soon" })).status, 400);
  assert.equal((await gen({ file: "d1-export.db", phase: "during", path: "/etc/passwd" })).status, 400, "unknown field");
  assert.equal((await gen({ file: "d1-export.db", phase: "during", limit: 99999 })).status, 400);

  const r = await gen({ file: "d1-export.db", phase: "during", limit: 25 });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.ok(out.created > 0 && out.created <= 25, JSON.stringify(out));
  const list = await (await j("/api/profiles?phase=during")).json();
  assert.equal(list.total, out.created);
  assert.ok(list.items.every((p: { source: string; phase: string }) => p.source === "d1:d1-export.db" && p.phase === "during"));
});

test("edit a profile over HTTP", async () => {
  const list = await (await j("/api/profiles")).json();
  const id = list.items[0].id;
  const before = await (await j(`/api/profiles/${id}`)).json();
  const patched = await (await j(`/api/profiles/${id}`, "PATCH", { name: "Edited", weight: 4, steps: [...before.steps, { procedure: "teams.getTeam", type: "query", gapMs: 3000 }] })).json();
  assert.equal(patched.name, "Edited");
  assert.equal(patched.weight, 4);
  assert.equal(patched.steps.length, before.steps.length + 1);

  assert.equal((await j(`/api/profiles/${id}`, "PATCH", { steps: [{ procedure: "auth.create", type: "mutation", gapMs: 0 }] })).status, 400, "never-call list");
  assert.equal((await j(`/api/profiles/${id}`, "PATCH", { weight: -5 })).status, 400);
  assert.equal((await j(`/api/profiles/${id}`, "PATCH", { phase: "never" })).status, 400);
  assert.equal((await j(`/api/profiles/999999`)).status, 404);
  assert.equal((await j(`/api/profiles/abc`)).status, 404);

  const dup = await j(`/api/profiles/${id}/duplicate`, "POST");
  assert.equal(dup.status, 201);
  const dupId = (await dup.json()).id;
  assert.equal((await j("/api/profiles/bulk", "POST", { action: "disable", ids: [dupId] })).status, 200);
  assert.equal((await (await j(`/api/profiles/${dupId}`)).json()).enabled, false);
  assert.equal((await j(`/api/profiles/${dupId}`, "DELETE")).status, 200);
  assert.equal((await j(`/api/profiles/${dupId}`)).status, 404);
});

test("stats", async () => {
  const s = await (await j("/api/profiles/stats?phase=during")).json();
  assert.ok(s.mix.length > 0 && s.mix.every((m: { share: number }) => m.share > 0 && m.share <= 1));
  assert.ok(s.procedures.includes("teams.getTeam"));
  assert.ok(!s.procedures.includes("auth.create"), "never-call procedures aren't imported");
});

test("publish writes the file k6 reads, and refuses when there's nothing to publish", async () => {
  assert.equal((await j("/api/profiles/publish", "POST", { phase: "before" })).status, 400, "no 'before' profiles");
  assert.equal((await j("/api/profiles/publish", "POST", { phase: "../../x" })).status, 400);
  const r = await j("/api/profiles/publish", "POST", { phase: "during" });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.file, "data/profile.during.json");
  const file = JSON.parse(readFileSync(join(DATA, "profile.during.json"), "utf8"));
  assert.equal(file.version, 1);
  assert.equal(file.profiles.length, out.profiles);
  assert.ok(file.profiles.every((p: { steps: { t: string }[] }) => p.steps.every((s) => s.t === "q" || s.t === "m")));
  assert.ok(!readdirSync(DATA).some((f) => f.endsWith(".tmp")), "no temp file left behind");
});
