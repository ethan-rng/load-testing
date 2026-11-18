import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { ROOT, RESULTS_DIR, getRun, listRuns, loadStore } from "./store.ts";
import { activeRunId, followLogs, reapOrphans, startRun, stopAll, stopRun } from "./launcher.ts";
import { LIMITS, MODES, PHASES, allowedTargets, assertConfig, validateParams } from "./validate.ts";
import { listFiles, readCodeFile } from "./code.ts";
import { openProfilesDb } from "./profiles.ts";
import { createProfilesApi } from "./profiles-api.ts";
import { clearCookies, finishLogin, loadAuthConfig, readSession, startLogin, type AuthConfig, type User } from "./auth.ts";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "127.0.0.1";
const AUTH_MODE = process.env.AUTH_MODE ?? "";

// ---- startup checks ----
try {
  assertConfig();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
let authCfg: AuthConfig | null = null;
if (AUTH_MODE === "github") {
  try {
    authCfg = loadAuthConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
} else if (AUTH_MODE === "none") {
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.error(`AUTH_MODE=none must not be exposed (HOST=${HOST}). Bind to 127.0.0.1, or use AUTH_MODE=github.`);
    process.exit(1);
  }
} else {
  console.error("Set AUTH_MODE=github (real use) or AUTH_MODE=none (local only, binds to 127.0.0.1).");
  process.exit(1);
}
loadStore();
reapOrphans(listRuns());
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR ?? "data");
mkdirSync(DATA_DIR, { recursive: true });
const profilesApi = createProfilesApi(
  openProfilesDb(resolve(ROOT, process.env.PROFILES_DB ?? "data/profiles.db")),
  resolve(ROOT, process.env.IMPORTS_DIR ?? "data/imports"),
  DATA_DIR,
);

// ---- auth ----
function authenticate(req: IncomingMessage): User | null {
  if (!authCfg) return { login: "local", canLaunch: true }; // AUTH_MODE=none, loopback only
  return readSession(authCfg, req.headers.cookie);
}

// Launches per person per hour, on top of the one-run-at-a-time rule.
// Only runs that actually start count, so typos can't use up the allowance.
const LAUNCHES_PER_HOUR = 10;
const launchLog = new Map<string, number[]>();
const recentLaunches = (login: string): number[] => {
  const cutoff = Date.now() - 3600_000;
  const recent = (launchLog.get(login) ?? []).filter((t) => t > cutoff);
  launchLog.set(login, recent);
  return recent;
};

// ---- helpers ----
const SECURITY: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  ...(authCfg?.secureCookies ? { "strict-transport-security": "max-age=31536000" } : {}),
};
function send(res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}): void {
  const isStr = typeof body === "string";
  res.writeHead(code, { ...SECURITY, "content-type": isStr ? "text/plain; charset=utf-8" : "application/json", ...extra });
  res.end(isStr ? body : JSON.stringify(body));
}
const fail = (res: ServerResponse, code: number, error: string) => send(res, code, { error });

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 10_000) throw new Error("Body too large.");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

const WEB_DIR = resolve(ROOT, "web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
/** Resolves a request path to a file inside web/, or null. No dotfiles, no escapes. */
function staticFile(path: string): { file: string; type: string } | null {
  const rel = path === "/" ? "/index.html" : path;
  if (rel.split("/").some((seg) => seg.startsWith("."))) return null;
  const file = resolve(WEB_DIR, "." + rel);
  if (!file.startsWith(WEB_DIR + sep)) return null;
  const type = MIME[extname(file)];
  return type && existsSync(file) ? { file, type } : null;
}
const PAGE_CSP = "default-src 'self'; frame-src 'self'; img-src 'self' data:; frame-ancestors 'none'";
// The k6 report is self-contained but runs its own scripts, so it is sandboxed
// away from this origin and cannot make network requests.
const REPORT_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";
const ID = /^[A-Za-z0-9_-]{1,100}$/;

// ---- routes ----
async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (path === "/healthz") return send(res, 200, "ok");

  // Sign-in routes are the only ones reachable without a session.
  if (authCfg && path === "/auth/login" && method === "GET") {
    const l = startLogin(authCfg);
    res.writeHead(302, { ...SECURITY, location: l.location, "set-cookie": l.setCookie });
    return void res.end();
  }
  if (authCfg && path === "/auth/callback" && method === "GET") {
    const r = await finishLogin(authCfg, url, req.headers.cookie);
    if (!r.ok) return send(res, r.status, r.error);
    res.writeHead(302, { ...SECURITY, location: "/", "set-cookie": r.setCookies });
    return void res.end();
  }

  const user = authenticate(req);
  if (!user) {
    if (method === "GET" && path === "/") {
      res.writeHead(302, { ...SECURITY, location: "/auth/login" });
      return void res.end();
    }
    return fail(res, 401, "Sign in required.");
  }

  if (method !== "GET" && method !== "HEAD") {
    // Same-origin only: a custom header can't be set by a cross-site form, and Origin must match.
    if (req.headers["x-requested-with"] !== "runs-ui") return fail(res, 403, "Missing request header.");
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try { originHost = new URL(origin).host; } catch { /* "null" and junk fall through to refusal */ }
      const expected = authCfg ? new URL(authCfg.publicUrl).host : req.headers.host;
      if (originHost !== expected) return fail(res, 403, "Cross-origin request refused.");
    }
  }

  if (path === "/auth/logout" && method === "POST") {
    res.writeHead(200, { ...SECURITY, "content-type": "application/json", "set-cookie": authCfg ? clearCookies(authCfg) : [] });
    return void res.end(JSON.stringify({ ok: true }));
  }

  const stat = method === "GET" || method === "HEAD" ? staticFile(path) : null;
  if (stat) {
    const cache = stat.type === "font/woff2" ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { ...SECURITY, "content-type": stat.type, "cache-control": cache, "content-security-policy": PAGE_CSP });
    return void res.end(method === "HEAD" ? undefined : readFileSync(stat.file));
  }

  if (path === "/api/config" && method === "GET") {
    return send(res, 200, { user, authMode: authCfg ? "github" : "none", targets: allowedTargets(), limits: LIMITS, modes: MODES, phases: PHASES, activeRunId: activeRunId() });
  }

  if (path === "/api/code/tree" && method === "GET") return send(res, 200, listFiles(ROOT));
  if (path === "/api/code/file" && method === "GET") {
    const f = readCodeFile(ROOT, url.searchParams.get("path") ?? "");
    return f ? send(res, 200, f) : fail(res, 404, "That file isn't available.");
  }

  if (await profilesApi({ req, res, url, method, path, user, send, fail, readJson })) return;

  if (path === "/api/runs" && method === "GET") return send(res, 200, listRuns().slice(0, 100));

  if (path === "/api/runs" && method === "POST") {
    if (!user.canLaunch) return fail(res, 403, "You can view runs but not launch them.");
    if (recentLaunches(user.login).length >= LAUNCHES_PER_HOUR) {
      return fail(res, 429, `Launch limit reached (${LAUNCHES_PER_HOUR} per hour). Try again later.`);
    }
    let body: unknown;
    try { body = await readJson(req); } catch (e) { return fail(res, 400, e instanceof Error ? e.message : "Bad JSON."); }
    const v = validateParams(body);
    if (!v.ok) return fail(res, 400, v.error);
    const r = startRun(v.params, user.login);
    if (!r.ok) return fail(res, 409, r.error);
    recentLaunches(user.login).push(Date.now());
    console.log(`run ${r.run.id} started by ${user.login}: ${JSON.stringify(v.params)}`);
    return send(res, 201, r.run);
  }

  const m = /^\/api\/runs\/([^/]+)(\/logs|\/stop)?$/.exec(path);
  if (m) {
    const id = m[1];
    if (!ID.test(id)) return fail(res, 400, "Bad run id.");
    const run = getRun(id);
    if (!run) return fail(res, 404, "No such run.");

    if (!m[2] && method === "GET") return send(res, 200, run);

    if (m[2] === "/stop" && method === "POST") {
      if (!user.canLaunch) return fail(res, 403, "You can view runs but not stop them.");
      console.log(`run ${id} stop requested by ${user.login}`);
      return stopRun(id) ? send(res, 200, { stopping: true }) : fail(res, 409, "That run is not running.");
    }

    if (m[2] === "/logs" && method === "GET") {
      res.writeHead(200, { ...SECURITY, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const stop = followLogs(
        id,
        (l) => res.write(`data: ${JSON.stringify(l)}\n\n`),
        () => { res.write("event: end\ndata: {}\n\n"); res.end(); },
        (p) => res.write(`event: progress\ndata: ${JSON.stringify(p)}\n\n`),
      );
      req.on("close", () => stop?.());
      return;
    }
  }

  const f = /^\/results\/([A-Za-z0-9_-]{1,100})\.(html|json|log)$/.exec(path);
  if (f && method === "GET") {
    if (!getRun(f[1])) return fail(res, 404, "No such run.");
    const file = resolve(RESULTS_DIR, `${f[1]}.${f[2]}`);
    if (!existsSync(file)) return fail(res, 404, "Not available for this run.");
    const types = { html: "text/html; charset=utf-8", json: "application/json", log: "text/plain; charset=utf-8" } as const;
    const headers: Record<string, string> = { ...SECURITY, "content-type": types[f[2] as keyof typeof types] };
    if (f[2] === "html") headers["content-security-policy"] = REPORT_CSP;
    res.writeHead(200, headers);
    return void res.end(readFileSync(file));
  }

  return fail(res, 404, "Not found.");
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error("request failed:", err);
    if (!res.headersSent) fail(res, 500, "Server error.");
    else res.end();
  });
});
server.listen(PORT, HOST, () => console.log(`Load test UI on http://${HOST}:${PORT} (AUTH_MODE=${AUTH_MODE}${authCfg ? `, org ${authCfg.org}, launch team ${authCfg.launchTeam}` : ", local only"})`));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`${sig}: stopping any active run before exit`);
    server.close();
    await stopAll();
    process.exit(0);
  });
}
