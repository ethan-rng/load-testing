// GitHub sign-in restricted to one org, with a smaller team allowed to launch.
//
// Flow: /auth/login -> GitHub -> /auth/callback. We exchange the code, ask
// GitHub who the user is and whether they're in the org (and the launch team),
// then drop the GitHub token. The session is a signed cookie, so nothing about
// users is stored on the server. Org changes take effect when the session
// expires (SESSION_HOURS).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export interface User { login: string; canLaunch: boolean }

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  org: string;
  launchTeam: string;
  sessionSecret: string;
  publicUrl: string;
  secureCookies: boolean;
  sessionHours: number;
  githubWeb: string;
  githubApi: string;
}

const SESSION_COOKIE = "lt_session";
const STATE_COOKIE = "lt_oauth_state";

export function loadAuthConfig(env: Env = process.env): AuthConfig {
  const need = (k: string): string => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`${k} is required when AUTH_MODE=github.`);
    return v;
  };
  const publicUrl = need("PUBLIC_URL").replace(/\/+$/, "");
  let u: URL;
  try { u = new URL(publicUrl); } catch { throw new Error(`PUBLIC_URL "${publicUrl}" is not a valid URL.`); }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !local) throw new Error("PUBLIC_URL must be https unless it is localhost.");

  const sessionSecret = need("SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters (try: openssl rand -hex 32).");

  const hours = Number(env.SESSION_HOURS ?? 4);
  if (!(hours > 0 && hours <= 24)) throw new Error("SESSION_HOURS must be between 0 and 24.");

  return {
    clientId: need("GITHUB_CLIENT_ID"),
    clientSecret: need("GITHUB_CLIENT_SECRET"),
    org: need("GITHUB_ORG"),
    // Required on purpose: there is no "everyone in the org can launch" default.
    launchTeam: need("LAUNCH_TEAM"),
    sessionSecret,
    publicUrl,
    secureCookies: u.protocol === "https:",
    sessionHours: hours,
    githubWeb: (env.GITHUB_WEB_URL ?? "https://github.com").replace(/\/+$/, ""),
    githubApi: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, ""),
  };
}

// ---- signed values ----
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest();

export function sign(secret: string, payload: unknown): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(secret, body))}`;
}

export function verify<T>(secret: string, value: string | undefined): T | null {
  if (!value) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  const want = mac(secret, body);
  let got: Buffer;
  try { got = Buffer.from(sig, "base64url"); } catch { return null; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()) as T; } catch { return null; }
}

// ---- cookies ----
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(cfg: AuthConfig, name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${cfg.secureCookies ? "; Secure" : ""}`;
}

interface SessionPayload { login: string; canLaunch: boolean; exp: number }

export function sessionCookie(cfg: AuthConfig, user: User, nowMs = Date.now()): string {
  const exp = nowMs + cfg.sessionHours * 3600_000;
  return cookie(cfg, SESSION_COOKIE, sign(cfg.sessionSecret, { ...user, exp } satisfies SessionPayload), cfg.sessionHours * 3600);
}
export const clearCookies = (cfg: AuthConfig): string[] => [cookie(cfg, SESSION_COOKIE, "", 0), cookie(cfg, STATE_COOKIE, "", 0)];

export function readSession(cfg: AuthConfig, cookieHeader: string | undefined, nowMs = Date.now()): User | null {
  const p = verify<SessionPayload>(cfg.sessionSecret, parseCookies(cookieHeader)[SESSION_COOKIE]);
  if (!p || typeof p.login !== "string" || typeof p.exp !== "number" || p.exp <= nowMs) return null;
  return { login: p.login, canLaunch: p.canLaunch === true };
}

// ---- OAuth flow ----
export function startLogin(cfg: AuthConfig): { location: string; setCookie: string } {
  const state = randomBytes(16).toString("hex");
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${cfg.publicUrl}/auth/callback`,
    scope: "read:org",
    state,
    allow_signup: "false",
  });
  return {
    location: `${cfg.githubWeb}/login/oauth/authorize?${q}`,
    setCookie: cookie(cfg, STATE_COOKIE, sign(cfg.sessionSecret, { state, exp: Date.now() + 600_000 }), 600),
  };
}

export type CallbackResult =
  | { ok: true; user: User; setCookies: string[] }
  | { ok: false; status: number; error: string };

const deny = (status: number, error: string): CallbackResult => ({ ok: false, status, error });

export async function finishLogin(cfg: AuthConfig, url: URL, cookieHeader: string | undefined): Promise<CallbackResult> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return deny(403, "GitHub sign-in was cancelled or refused.");
  if (!code || !state) return deny(400, "Missing code or state.");

  const saved = verify<{ state: string; exp: number }>(cfg.sessionSecret, parseCookies(cookieHeader)[STATE_COOKIE]);
  if (!saved || saved.exp <= Date.now() || saved.state.length !== state.length ||
      !timingSafeEqual(Buffer.from(saved.state), Buffer.from(state))) {
    return deny(400, "Sign-in expired or was not started here. Try again.");
  }

  const gh = async (path: string, token: string) =>
    fetch(`${cfg.githubApi}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "hw-load-test" },
      signal: AbortSignal.timeout(10_000),
    });

  try {
    const tokenRes = await fetch(`${cfg.githubWeb}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "hw-load-test" },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, redirect_uri: `${cfg.publicUrl}/auth/callback` }),
      signal: AbortSignal.timeout(10_000),
    });
    const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
    if (!tok.access_token) return deny(400, "GitHub did not accept the sign-in. Try again.");
    const token = tok.access_token; // used below, never stored

    const me = await gh("/user", token);
    if (!me.ok) return deny(502, "Could not read your GitHub profile.");
    const login = ((await me.json()) as { login?: string }).login;
    if (!login) return deny(502, "Could not read your GitHub profile.");

    const org = await gh(`/user/memberships/orgs/${encodeURIComponent(cfg.org)}`, token);
    const orgState = org.ok ? ((await org.json()) as { state?: string }).state : null;
    if (orgState !== "active") {
      console.warn(`sign-in refused: ${login} is not an active member of ${cfg.org} (HTTP ${org.status})`);
      return deny(403, `Access denied. You need to be a member of the ${cfg.org} GitHub organization. ` +
        `If you are one, the org may need to approve this app.`);
    }

    const team = await gh(`/orgs/${encodeURIComponent(cfg.org)}/teams/${encodeURIComponent(cfg.launchTeam)}/memberships/${encodeURIComponent(login)}`, token);
    const canLaunch = team.ok && ((await team.json()) as { state?: string }).state === "active";

    const user: User = { login, canLaunch };
    console.log(`signed in: ${login} (${canLaunch ? "can launch" : "view only"})`);
    return { ok: true, user, setCookies: [sessionCookie(cfg, user), cookie(cfg, STATE_COOKIE, "", 0)] };
  } catch (err) {
    console.error("sign-in failed:", err instanceof Error ? err.message : err);
    return deny(502, "Could not reach GitHub. Try again.");
  }
}
