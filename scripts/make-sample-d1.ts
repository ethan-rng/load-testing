// Writes a fake D1 export (same schema as the real request_events table) so the
// Profiles page and tests have something to work with. Not real traffic.
//
//   node scripts/make-sample-d1.ts data/imports/sample-d1.db [users] [seed]
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
  CREATE TABLE request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, procedure TEXT NOT NULL, type TEXT NOT NULL,
    status TEXT NOT NULL, duration_ms INTEGER NOT NULL, user_hash TEXT, phase TEXT NOT NULL);
  CREATE INDEX idx_events_ts ON request_events (ts);
  CREATE INDEX idx_events_user ON request_events (user_hash, ts);
  CREATE TABLE request_counts (id INTEGER PRIMARY KEY AUTOINCREMENT, minute INTEGER NOT NULL, procedure TEXT NOT NULL, n INTEGER NOT NULL, phase TEXT NOT NULL);`;

// [procedure, type] pools per phase, roughly how people use the site then.
const POOLS: Record<string, [string, string][]> = {
  before: [["auth.checkVerified", "query"], ["application.get", "query"], ["application.get", "query"], ["application.save", "mutation"], ["application.save", "mutation"], ["application.submit", "mutation"], ["teamFinder.list", "query"], ["scavengerHunt.getAllScavengerHuntItems", "query"], ["auth.create", "mutation"]],
  during: [["scavengerHunt.getPoints", "query"], ["scavengerHunt.getScans", "query"], ["scavengerHunt.getAllScavengerHuntItems", "query"], ["teamFinder.list", "query"], ["teamFinder.getMine", "query"], ["teams.getTeam", "query"], ["teams.saveProject", "mutation"], ["scavengerHunt.redeem", "mutation"], ["qrRouter.generate", "mutation"], ["cheatCheck.startSweep", "mutation"]],
  after: [["application.get", "query"], ["teams.getTeam", "query"], ["scavengerHunt.getPoints", "query"]],
};

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeSampleD1(path: string, users = 60, seed = 1): { events: number; hashes: string[] } {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) rmSync(path);
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const ins = db.prepare("INSERT INTO request_events (ts, procedure, type, status, duration_ms, user_hash, phase) VALUES (?,?,?,?,?,?,?)");
  const rand = mulberry32(seed);
  const hashes: string[] = [];
  let events = 0, t0 = Date.UTC(2026, 10, 1);
  db.exec("BEGIN");
  for (let u = 0; u < users; u++) {
    const hash = Array.from({ length: 16 }, () => Math.floor(rand() * 16).toString(16)).join("");
    hashes.push(hash);
    const phase = (["before", "during", "during", "after"] as const)[Math.floor(rand() * 4)];
    let ts = t0 + Math.floor(rand() * 5 * 86_400_000);
    for (let s = 0, sessions = 1 + Math.floor(rand() * 3); s < sessions; s++) {
      const n = 2 + Math.floor(rand() * 14);
      for (let i = 0; i < n; i++) {
        const [proc, type] = POOLS[phase][Math.floor(rand() * POOLS[phase].length)];
        const status = rand() < 0.06 ? "UNAUTHORIZED" : "OK";
        ins.run(ts, proc, type, status, 5 + Math.floor(rand() * 200), hash, phase); events++;
        // mostly short waits, sometimes a long one inside the session
        ts += rand() < 0.05 ? 5 * 60_000 + Math.floor(rand() * 600_000) : Math.floor(-Math.log(1 - rand()) * 20_000);
      }
      ts += 45 * 60_000 + Math.floor(rand() * 3 * 3_600_000); // long break: next session
    }
  }
  for (let i = 0; i < 40; i++) { ins.run(t0 + i * 60_000, "scavengerHunt.getAllScavengerHuntItems", "query", "OK", 20, null, "during"); events++; } // anonymous
  db.exec("COMMIT");
  db.close();
  return { events, hashes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? "data/imports/sample-d1.db";
  const r = makeSampleD1(out, Number(process.argv[3] ?? 60), Number(process.argv[4] ?? 1));
  console.log(`Wrote ${out}: ${r.events} events from ${r.hashes.length} users (fake data).`);
}
