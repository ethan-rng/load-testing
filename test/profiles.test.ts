import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as P from "../server/profiles.ts";
import { makeSampleD1, mulberry32 } from "../scripts/make-sample-d1.ts";

const dir = mkdtempSync(join(tmpdir(), "prof-"));
const fresh = () => P.openProfilesDb(join(mkdtempSync(join(dir, "db-")), "p.db"));
const step = (procedure: string, gapMs = 1000, type: "query" | "mutation" = "query") => ({ procedure, type, gapMs });
const opts = (o: Partial<P.GenOptions> = {}): P.GenOptions => ({ phase: "during", ...P.GEN_DEFAULTS, ...o });

/** A tiny D1-shaped db with exact rows, for checking session splitting. */
function craft(rows: [number, string, string, string, string | null, string][]): string {
  const path = join(mkdtempSync(join(dir, "src-")), "d1.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE request_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, procedure TEXT, type TEXT, status TEXT, duration_ms INTEGER DEFAULT 1, user_hash TEXT, phase TEXT)");
  const ins = db.prepare("INSERT INTO request_events (ts, procedure, type, status, user_hash, phase) VALUES (?,?,?,?,?,?)");
  for (const r of rows) ins.run(...r);
  db.close();
  return path;
}

test("create, read, update, duplicate, delete", () => {
  const db = fresh();
  const c = P.createProfile(db, { name: "  Browser  ", phase: "during", steps: [step("application.get", 5000), step("teams.getTeam", 2000)] });
  assert.ok(c.ok);
  const id = (c as { id: number }).id;
  const p = P.getProfile(db, id)!;
  assert.equal(p.name, "Browser");
  assert.equal(p.steps[0].gapMs, 0, "first step never waits");
  assert.equal(p.steps[1].gapMs, 2000);

  assert.deepEqual(P.updateProfile(db, id, { name: "Renamed", weight: 3, enabled: false, steps: [step("teamFinder.list")] }), { ok: true });
  const u = P.getProfile(db, id)!;
  assert.deepEqual([u.name, u.weight, u.enabled, u.steps.length], ["Renamed", 3, false, 1]);

  const d = P.duplicateProfile(db, id) as { ok: true; id: number };
  assert.equal(P.getProfile(db, d.id)!.name, "Renamed (copy)");
  assert.equal(P.getProfile(db, d.id)!.source, `copy:${id}`);

  assert.deepEqual(P.bulk(db, "delete", [id, d.id]), { ok: true, changed: 2 });
  assert.equal(P.listProfiles(db).total, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM profile_steps").get() as { n: number }).n, 0, "steps are deleted with the profile");
});

test("rejects bad input", () => {
  const db = fresh();
  const bad = (x: Parameters<typeof P.createProfile>[1]) => assert.equal(P.createProfile(db, x).ok, false, JSON.stringify(x));
  bad({ name: "" }); bad({ name: "x".repeat(81) }); bad({ name: "a", phase: "later" }); bad({ name: "a", weight: -1 }); bad({ name: "a", weight: P.LIMITS.maxWeight + 1 });
  bad({ name: "a", steps: "no" });
  bad({ name: "a", steps: [step("bad name")] }); bad({ name: "a", steps: [step("a..b")] }); bad({ name: "a", steps: [step("x;DROP TABLE profiles")] });
  bad({ name: "a", steps: [step("a.b", -1)] }); bad({ name: "a", steps: [step("a.b", P.LIMITS.maxGapMs + 1)] }); bad({ name: "a", steps: [step("a.b", 1.5)] });
  bad({ name: "a", steps: [{ procedure: "a.b", type: "write", gapMs: 0 }] });
  bad({ name: "a", steps: Array.from({ length: P.LIMITS.maxSteps + 1 }, () => step("a.b")) });
  bad({ name: "a", steps: [step("auth.reset", 0, "mutation")] }); // never-call list
  const ok = P.createProfile(db, { name: "ok" }) as { id: number };
  assert.equal(P.updateProfile(db, ok.id, { hax: 1 }).ok, false);
  assert.equal(P.updateProfile(db, ok.id, { enabled: "yes" }).ok, false);
  assert.equal(P.updateProfile(db, 9999, { name: "x" }).ok, false);
  assert.equal(P.bulk(db, "drop", [1]).ok, false);
  assert.equal(P.bulk(db, "delete", []).ok, false);
  assert.equal(P.bulk(db, "delete", ["1"]).ok, false);
});

test("SQL in names is stored as text, not run", () => {
  const db = fresh();
  const evil = "x'); DROP TABLE profiles;--";
  const r = P.createProfile(db, { name: evil }) as { id: number };
  assert.equal(P.getProfile(db, r.id)!.name, evil);
  assert.equal(P.listProfiles(db, { q: "DROP" }).total, 1);
  assert.equal(P.listProfiles(db, { q: "%" }).total, 0, "% is not a wildcard in search");
});

test("inspectD1 accepts a real-shaped export and rejects other files", () => {
  const sample = join(dir, "sample.db");
  makeSampleD1(sample, 20);
  const ok = P.inspectD1(sample);
  assert.ok(ok.ok && ok.summary.rows > 0 && ok.summary.phases.length > 0);

  const text = join(dir, "notdb.db"); writeFileSync(text, "hello, not sqlite at all");
  assert.equal(P.inspectD1(text).ok, false);
  const empty = join(dir, "empty.db"); const e0 = new DatabaseSync(empty); e0.exec("CREATE TABLE other (a INTEGER)"); e0.close();
  assert.match((P.inspectD1(empty) as { error: string }).error, /request_events/);
  const missing = join(dir, "cols.db"); const m = new DatabaseSync(missing); m.exec("CREATE TABLE request_events (ts INTEGER, procedure TEXT)"); m.close();
  assert.match((P.inspectD1(missing) as { error: string }).error, /missing/);
  assert.equal(P.inspectD1(join(dir, "nope.db")).ok, false);
});

test("sessions split on silence, gaps are measured and capped", () => {
  const T = 1_000_000, MIN = 60_000;
  const src = craft([
    [T, "a.one", "query", "OK", "u1", "during"],
    [T + 10_000, "a.two", "query", "OK", "u1", "during"],
    [T + 10_000 + 20 * MIN, "a.three", "query", "OK", "u1", "during"],        // 20 min later: same session, gap capped
    [T + 10_000 + 20 * MIN + 31 * MIN, "b.one", "query", "OK", "u1", "during"], // 31 min of silence: new session...
    [T + 10_000 + 20 * MIN + 31 * MIN + 5_000, "b.two", "query", "OK", "u1", "during"],
    [T, "c.one", "query", "OK", "u2", "during"], [T + 1_000, "c.two", "query", "OK", "u2", "during"], // another user
    [T, "d.one", "query", "OK", "u3", "during"],                                  // single step: too short
    [T, "x.anon", "query", "OK", null, "during"], [T + 1, "x.anon", "query", "OK", null, "during"], // anonymous: ignored
    [T, "e.one", "query", "OK", "u4", "before"], [T + 1, "e.two", "query", "OK", "u4", "before"],     // other phase
  ]);
  const db = fresh();
  const r = P.generateFromD1(db, src, "crafted", opts({ maxGapSec: 120 }));
  assert.equal(r.sessions, 3);
  assert.equal(r.tooShort, 1);
  assert.equal(r.created, 3);
  const all = P.listProfiles(db).items.map((p) => P.getProfile(db, p.id)!);
  const procs = all.map((p) => p.steps.map((s) => s.procedure).join(","));
  assert.deepEqual(procs.sort(), ["a.one,a.two,a.three", "b.one,b.two", "c.one,c.two"].sort());
  const a = all.find((p) => p.steps[0].procedure === "a.one")!;
  assert.deepEqual(a.steps.map((s) => s.gapMs), [0, 10_000, 120_000], "20-minute wait is capped at 120s");
  assert.ok(all.every((p) => p.phase === "during" && p.source === "d1:crafted"));
});

test("filters: failed calls, writes and never-call procedures", () => {
  const T = 1_000_000;
  const src = craft([
    [T, "app.get", "query", "OK", "u", "during"], [T + 1000, "app.get", "query", "UNAUTHORIZED", "u", "during"],
    [T + 2000, "app.save", "mutation", "OK", "u", "during"], [T + 3000, "auth.reset", "mutation", "OK", "u", "during"],
    [T + 4000, "teams.getTeam", "query", "OK", "u", "during"],
  ]);
  const steps = (o: Partial<P.GenOptions>) => { const db = fresh(); P.generateFromD1(db, src, "f", opts(o)); const l = P.listProfiles(db).items; return l.length ? P.getProfile(db, l[0].id)!.steps.map((s) => s.procedure) : []; };
  assert.deepEqual(steps({}), ["app.get", "teams.getTeam"]);
  assert.deepEqual(steps({ includeMutations: true }), ["app.get", "app.save", "teams.getTeam"], "never-call list applies even with writes on");
  assert.deepEqual(steps({ onlyOk: false }), ["app.get", "app.get", "teams.getTeam"]);
});

test("generating from sample data: limit, truncation and replace", () => {
  const sample = join(dir, "s2.db"); makeSampleD1(sample, 120, 7);
  const db = fresh();
  const manual = P.createProfile(db, { name: "mine", phase: "during", steps: [step("application.get")] }) as { id: number };
  const r = P.generateFromD1(db, sample, "s2", opts({ limit: 10, maxSteps: 6 }), mulberry32(3));
  assert.equal(r.created, 10);
  assert.ok(r.sessions > 10);
  const items = P.listProfiles(db).items;
  assert.equal(items.length, 11);
  for (const it of items.filter((i) => i.source.startsWith("d1:"))) {
    const p = P.getProfile(db, it.id)!;
    assert.ok(p.steps.length >= 2 && p.steps.length <= 6);
    assert.ok(p.steps.every((s) => s.type === "query" && !["auth.create", "cheatCheck.startSweep"].includes(s.procedure)));
  }
  // regenerating with replace swaps the generated ones but never touches hand-made ones
  P.generateFromD1(db, sample, "s2", opts({ limit: 5, replace: true }), mulberry32(4));
  const after = P.listProfiles(db).items;
  assert.equal(after.length, 6);
  assert.ok(after.some((i) => i.id === manual.id), "manual profile survives replace");
});

test("no user hashes or timestamps are stored", () => {
  const sample = join(dir, "s3.db");
  const { hashes } = makeSampleD1(sample, 30, 5);
  const path = join(mkdtempSync(join(dir, "db-")), "p.db");
  const db = P.openProfilesDb(path);
  P.generateFromD1(db, sample, "s3", opts({ phase: "during", limit: 100 }));
  P.generateFromD1(db, sample, "s3", opts({ phase: "before", limit: 100 }));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const raw = readFileSync(path).toString("latin1");
  for (const h of hashes) assert.ok(!raw.includes(h), `hash ${h} leaked into the profiles db`);
  const cols = (db.prepare("PRAGMA table_info(profile_steps)").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(cols, ["profile_id", "idx", "procedure", "type", "gap_ms"]);
});

test("stats weight the procedure mix; disabled and zero-weight profiles don't count", () => {
  const db = fresh();
  const a = P.createProfile(db, { name: "a", weight: 3, steps: [step("x.one"), step("x.two")] }) as { id: number };
  P.createProfile(db, { name: "b", weight: 1, steps: [step("x.two")] });
  const off = P.createProfile(db, { name: "c", weight: 5, steps: [step("x.off")] }) as { id: number };
  P.updateProfile(db, off.id, { enabled: false });
  P.createProfile(db, { name: "z", weight: 0, steps: [step("x.zero")] });
  const s = P.stats(db, "during");
  const share = Object.fromEntries(s.mix.map((m) => [m.procedure, m.share]));
  assert.ok(Math.abs(share["x.one"] - 3 / 7) < 1e-9 && Math.abs(share["x.two"] - 4 / 7) < 1e-9, JSON.stringify(share));
  assert.ok(!("x.off" in share) && !("x.zero" in share));
  assert.ok(s.procedures.includes("x.off"), "autocomplete list still includes disabled ones");
  assert.equal(P.listProfiles(db, { q: "a" }).items[0].id, a.id);
});

test("export for k6 is compact and only has enabled, weighted profiles for the phase", () => {
  const db = fresh();
  P.createProfile(db, { name: "on", phase: "during", weight: 2, steps: [step("a.b", 0), step("c.d", 1500)] });
  const off = P.createProfile(db, { name: "off", phase: "during", steps: [step("a.b")] }) as { id: number }; P.updateProfile(db, off.id, { enabled: false });
  P.createProfile(db, { name: "other", phase: "before", steps: [step("a.b")] });
  P.createProfile(db, { name: "zero", phase: "during", weight: 0, steps: [step("a.b")] });
  const e = P.exportForK6(db, "during");
  assert.equal(e.version, 1);
  assert.equal(e.profiles.length, 1);
  assert.deepEqual(e.profiles[0].steps, [{ p: "a.b", t: "q", g: 0 }, { p: "c.d", t: "q", g: 1500 }]);
  assert.equal(e.profiles[0].weight, 2);
});

test("generation options are validated", () => {
  assert.equal(P.parseGenOptions({ phase: "during" }).ok, true);
  for (const bad of [{}, { phase: "x" }, { phase: "during", limit: 0 }, { phase: "during", limit: 5000 }, { phase: "during", minSteps: 10, maxSteps: 5 },
    { phase: "during", onlyOk: "yes" }, { phase: "during", file: "a.db", path: "/etc/passwd" }, { phase: "during", sessionGapMin: -1 }]) {
    assert.equal(P.parseGenOptions(bad).ok, false, JSON.stringify(bad));
  }
});

test("a failure part-way through generation leaves nothing behind", () => {
  const db = fresh();
  const src = craft([[1000, "a.b", "query", "OK", "u", "during"], [2000, "c.d", "query", "OK", "u", "during"]]);
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON profile_steps BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => P.generateFromD1(db, src, "x", opts()), /boom/);
  assert.equal(P.listProfiles(db).total, 0, "no half-created profiles");
  // and the connection is still usable afterwards
  db.exec("DROP TRIGGER boom");
  assert.ok(P.createProfile(db, { name: "after" }).ok);
});
