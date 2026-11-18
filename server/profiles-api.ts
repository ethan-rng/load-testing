import type { IncomingMessage, ServerResponse } from "node:http";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as P from "./profiles.ts";

export interface ApiCtx {
  req: IncomingMessage; res: ServerResponse; url: URL; method: string; path: string;
  user: { login: string; canLaunch: boolean };
  send: (res: ServerResponse, code: number, body: unknown) => void;
  fail: (res: ServerResponse, code: number, error: string) => void;
  readJson: (req: IncomingMessage) => Promise<unknown>;
}

const MAX_UPLOAD = 200 * 1024 * 1024;
// Letters, digits, dot, dash, underscore; must start with a letter or digit. No slashes, so no paths.
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const FILE_EXT = /\.(db|sqlite|sqlite3)$/i;
export const validImportName = (n: unknown): n is string => typeof n === "string" && FILE_NAME.test(n) && FILE_EXT.test(n);

export function createProfilesApi(db: DatabaseSync, importsDir: string, dataDir: string) {
  mkdirSync(importsDir, { recursive: true });
  // leftovers from an interrupted upload
  for (const f of readdirSync(importsDir)) if (f.startsWith(".upload-")) try { unlinkSync(join(importsDir, f)); } catch { /* gone */ }

  const importPath = (name: string) => join(importsDir, name);

  return async function handle(c: ApiCtx): Promise<boolean> {
    const { path, method, res, req, user, send, fail } = c;
    if (!path.startsWith("/api/profiles") && !path.startsWith("/api/imports")) return false;
    const write = method !== "GET" && method !== "HEAD";
    if (write && !user.canLaunch) { fail(res, 403, "Only the launch team can change profiles."); return true; }
    const log = (msg: string) => console.log(`profiles: ${user.login} ${msg}`);
    const body = async (): Promise<Record<string, unknown> | null> => {
      try { const b = await c.readJson(req); return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null; } catch { return null; }
    };
    const badBody = () => fail(res, 400, "Body must be a JSON object.");

    // ---------- imports ----------
    if (path === "/api/imports" && method === "GET") {
      const files = readdirSync(importsDir).filter(validImportName)
        .map((name) => { const s = statSync(importPath(name)); return { name, size: s.size, modified: s.mtime.toISOString() }; })
        .sort((a, b) => b.modified.localeCompare(a.modified));
      send(res, 200, files); return true;
    }

    if (path === "/api/imports" && method === "POST") {
      const raw = String(req.headers["x-filename"] ?? "");
      if (!validImportName(raw)) { fail(res, 400, "File name must be letters, digits, . - _ and end in .db, .sqlite or .sqlite3."); return true; }
      if (Number(req.headers["content-length"] ?? 0) > MAX_UPLOAD) { fail(res, 413, "File is over 200 MB."); return true; }
      const tmp = join(importsDir, `.upload-${randomBytes(6).toString("hex")}`);
      const out = createWriteStream(tmp);
      let size = 0, tooBig = false;
      try {
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_UPLOAD) { tooBig = true; break; }
          if (!out.write(chunk)) await once(out, "drain");
        }
        out.end(); await once(out, "close");
      } catch { out.destroy(); try { unlinkSync(tmp); } catch { /* gone */ } fail(res, 400, "Upload failed."); return true; }
      if (tooBig) { try { unlinkSync(tmp); } catch { /* gone */ } fail(res, 413, "File is over 200 MB."); return true; }
      const check = P.inspectD1(tmp);
      if (!check.ok) { unlinkSync(tmp); fail(res, 400, check.error); return true; }
      let name = raw;
      if (existsSync(importPath(name))) name = `${Date.now()}-${raw}`.slice(0, 60);
      if (!validImportName(name)) name = `${Date.now()}.db`;
      renameSync(tmp, importPath(name));
      log(`uploaded ${name} (${size} bytes)`);
      send(res, 201, { name, size, summary: check.summary }); return true;
    }

    const im = /^\/api\/imports\/([^/]+)(\/summary)?$/.exec(path);
    if (im) {
      const name = decodeURIComponent(im[1]);
      if (!validImportName(name) || !existsSync(importPath(name))) { fail(res, 404, "No such import."); return true; }
      if (im[2] && method === "GET") {
        const r = P.inspectD1(importPath(name));
        r.ok ? send(res, 200, r.summary) : fail(res, 422, r.error); return true;
      }
      if (!im[2] && method === "DELETE") { unlinkSync(importPath(name)); log(`deleted import ${name}`); send(res, 200, { ok: true }); return true; }
    }

    // ---------- profiles ----------
    if (path === "/api/profiles" && method === "GET") {
      const q = c.url.searchParams;
      send(res, 200, P.listProfiles(db, { phase: q.get("phase") ?? undefined, q: q.get("q") ?? undefined, limit: Number(q.get("limit") ?? 100), offset: Number(q.get("offset") ?? 0) }));
      return true;
    }
    if (path === "/api/profiles" && method === "POST") {
      const b = await body(); if (!b) { badBody(); return true; }
      const r = P.createProfile(db, b);
      if (!r.ok) { fail(res, 400, r.error); return true; }
      log(`created profile ${r.id}`); send(res, 201, P.getProfile(db, r.id)); return true;
    }
    if (path === "/api/profiles/stats" && method === "GET") { send(res, 200, P.stats(db, c.url.searchParams.get("phase") ?? undefined)); return true; }

    if (path === "/api/profiles/bulk" && method === "POST") {
      const b = await body(); if (!b) { badBody(); return true; }
      const r = P.bulk(db, b.action, b.ids);
      if (!r.ok) { fail(res, 400, r.error); return true; }
      log(`bulk ${String(b.action)} on ${r.changed} profile(s)`); send(res, 200, r); return true;
    }

    if (path === "/api/profiles/generate" && method === "POST") {
      const b = await body(); if (!b) { badBody(); return true; }
      if (!validImportName(b.file) || !existsSync(importPath(b.file))) { fail(res, 400, "Choose one of the imported files."); return true; }
      const o = P.parseGenOptions(b);
      if (!o.ok) { fail(res, 400, o.error); return true; }
      try {
        const r = P.generateFromD1(db, importPath(b.file), b.file, o.opts);
        log(`generated ${r.created} profile(s) for ${o.opts.phase} from ${b.file}`);
        send(res, 200, r);
      } catch (e) { fail(res, 422, e instanceof Error ? e.message : "Generation failed."); }
      return true;
    }

    if (path === "/api/profiles/publish" && method === "POST") {
      const b = await body(); if (!b) { badBody(); return true; }
      if (!(P.PHASES as readonly unknown[]).includes(b.phase)) { fail(res, 400, `phase must be one of: ${P.PHASES.join(", ")}`); return true; }
      const data = P.exportForK6(db, b.phase as P.Phase);
      if (data.profiles.length === 0) { fail(res, 400, `No enabled profiles with weight above 0 for "${String(b.phase)}".`); return true; }
      const file = `profile.${String(b.phase)}.json`;
      const tmp = join(dataDir, `.${file}.tmp`);
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, join(dataDir, file)); // atomic: a run never reads half a file
      log(`published ${file} (${data.profiles.length} profiles)`);
      send(res, 200, { file: `data/${file}`, profiles: data.profiles.length, steps: data.profiles.reduce((a, p) => a + p.steps.length, 0) }); return true;
    }

    const pm = /^\/api\/profiles\/(\d{1,9})(\/duplicate)?$/.exec(path);
    if (pm) {
      const id = Number(pm[1]);
      const p = P.getProfile(db, id);
      if (!p) { fail(res, 404, "No such profile."); return true; }
      if (!pm[2] && method === "GET") { send(res, 200, p); return true; }
      if (!pm[2] && method === "PATCH") {
        const b = await body(); if (!b) { badBody(); return true; }
        const r = P.updateProfile(db, id, b);
        if (!r.ok) { fail(res, 400, r.error); return true; }
        log(`updated profile ${id} (${Object.keys(b).join(", ")})`); send(res, 200, P.getProfile(db, id)); return true;
      }
      if (!pm[2] && method === "DELETE") { P.bulk(db, "delete", [id]); log(`deleted profile ${id}`); send(res, 200, { ok: true }); return true; }
      if (pm[2] && method === "POST") {
        const r = P.duplicateProfile(db, id);
        if (!r.ok) { fail(res, 400, r.error); return true; }
        log(`duplicated profile ${id} as ${r.id}`); send(res, 201, P.getProfile(db, r.id)); return true;
      }
    }

    fail(res, 404, "Not found."); return true;
  };
}
