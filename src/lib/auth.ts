import http from "k6/http";
import { check } from "k6";
import { config } from "./config.ts";

export interface TestUser {
  email: string;
  password: string;
  role?: "hacker" | "organizer" | "judge";
}

/**
 * Logs in through next-auth's credentials provider. k6 keeps a cookie jar per
 * VU, so the session cookie sticks for the rest of that VU's life.
 * Returns true if /api/auth/session shows a user afterwards. Never throws:
 * an unreachable server or a bad response is just a failed login, so the
 * caller can back off instead of retrying in a tight loop.
 */
export function login(user: TestUser): boolean {
  const base = config.target;
  const tags = { name: "auth.login" };

  const csrfRes = http.get(`${base}/api/auth/csrf`, { tags });
  if (csrfRes.status !== 200 || !csrfRes.body) return false;
  let csrf: unknown;
  try {
    csrf = (csrfRes.json() as { csrfToken?: unknown }).csrfToken;
  } catch {
    return false;
  }
  if (typeof csrf !== "string") return false;

  http.post(
    `${base}/api/auth/callback/credentials`,
    {
      username: user.email,
      password: user.password,
      csrfToken: csrf,
      json: "true",
    },
    { tags },
  );

  const sessionRes = http.get(`${base}/api/auth/session`, { tags });
  let ok = false;
  try {
    const body = sessionRes.json() as { user?: unknown } | null;
    ok = !!body && !!body.user;
  } catch {
    ok = false;
  }
  check(sessionRes, { "logged in": () => ok });
  return ok;
}
