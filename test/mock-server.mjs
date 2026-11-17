// Minimal stand-in for the Hack Western app: next-auth credentials login plus
// tRPC routes. Only for checking the k6 scripts work. Not the real app.
import http from "node:http";

const sessions = new Set();
const counts = {};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  counts[url.pathname] = (counts[url.pathname] || 0) + 1;
  const json = (code, body, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const cookie = (req.headers.cookie || "").match(/sid=(\w+)/)?.[1];
  const authed = cookie && sessions.has(cookie);

  if (url.pathname === "/api/auth/csrf") return json(200, { csrfToken: "tok" });
  if (url.pathname === "/api/auth/callback/credentials") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = new URLSearchParams(body);
      if (p.get("csrfToken") === "tok" && p.get("password") === "ThisIsAStrongPassword1!") {
        const sid = Math.random().toString(16).slice(2);
        sessions.add(sid);
        return json(200, { url: "/" }, { "set-cookie": `sid=${sid}; Path=/` });
      }
      json(401, {});
    });
    return;
  }
  if (url.pathname === "/api/auth/session")
    return json(200, authed ? { user: { id: "u" } } : {});
  if (url.pathname === "/api/docs/app") {
    if (req.headers.authorization !== "Bearer secret") return json(401, { message: "Unauthorized" });
    return json(200, { version: 1, pages: [], rest: [{}], trpc: [{}, {}] });
  }
  if (url.pathname === "/__counts") return json(200, counts);

  if (url.pathname.startsWith("/api/trpc/")) {
    const proc = url.pathname.slice("/api/trpc/".length);
    const publicProcs = ["scavengerHunt.getAllScavengerHuntItems"];
    if (!publicProcs.includes(proc) && !authed)
      return json(401, { error: { json: { message: "UNAUTHORIZED" } } });
    if (proc === "teams.getTeam") return json(400, { error: { json: { message: "no team" } } });
    return setTimeout(() => json(200, { result: { data: { json: [] } } }), 5 + Math.random() * 20);
  }
  json(404, {});
});
server.listen(3999, () => console.log("mock on :3999"));
