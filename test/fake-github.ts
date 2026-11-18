// A stand-in for github.com + api.github.com, just enough for the sign-in flow.
import http from "node:http";
import type { AddressInfo } from "node:net";

// alice: in the org and the launch team. bob: in the org only.
// carol: invited but not accepted. mallory: not in the org.
const ORG = "hackwestern";
const TEAM = "hw13-web";
const inOrg: Record<string, string> = { alice: "active", bob: "active", carol: "pending" };
const inTeam = new Set(["alice"]);

export async function startFakeGithub() {
  let who = "alice";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const user = token.startsWith("tok_") ? token.slice(4) : null;

    if (url.pathname === "/login/oauth/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", who);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    if (url.pathname === "/login/oauth/access_token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      return void req.on("end", () => {
        const { code, client_secret } = JSON.parse(body);
        if (client_secret !== "secret" || !code) return json(200, { error: "bad_verification_code" });
        json(200, { access_token: `tok_${code}` });
      });
    }
    if (!user) return json(401, {});
    if (url.pathname === "/user") return json(200, { login: user });
    if (url.pathname === `/user/memberships/orgs/${ORG}`) {
      return inOrg[user] ? json(200, { state: inOrg[user] }) : json(404, {});
    }
    if (url.pathname === `/orgs/${ORG}/teams/${TEAM}/memberships/${user}`) {
      return inTeam.has(user) ? json(200, { state: "active" }) : json(404, {});
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, setUser: (u: string) => { who = u; }, close: () => server.close() };
}
