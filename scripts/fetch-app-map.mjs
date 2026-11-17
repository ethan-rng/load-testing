// Downloads the app map (pages, REST routes, tRPC procedures) from the app's
// /api/docs/app route and saves it to data/app.json.
//
//   DOCS_ROOT   base URL of the app (default http://localhost:3000)
//   DOCS_TOKEN  bearer token the route requires
//
//   DOCS_ROOT=https://hackwestern.com DOCS_TOKEN=... npm run fetch:app-map
//
// This only reads one JSON document, so it is fine to point at production.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = (process.env.DOCS_ROOT || "http://localhost:3000").replace(/\/+$/, "");
const token = process.env.DOCS_TOKEN || "";
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../data/app.json");

if (!token) {
  console.error("DOCS_TOKEN is not set. The /api/docs/app route needs a bearer token.");
  process.exit(1);
}

const url = `${root}/api/docs/app`;
let res;
try {
  res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
} catch (err) {
  console.error(`Could not reach ${url}: ${err.message}`);
  process.exit(1);
}

if (!res.ok) {
  const hint =
    res.status === 401 ? " (wrong or missing token)" :
    res.status === 503 ? " (the app says docs are not configured)" : "";
  console.error(`GET ${url} returned ${res.status}${hint}`);
  process.exit(1);
}

let map;
try {
  map = await res.json();
} catch {
  console.error(`GET ${url} did not return JSON.`);
  process.exit(1);
}

for (const key of ["pages", "rest", "trpc"]) {
  if (!Array.isArray(map[key])) {
    console.error(`Response is missing the "${key}" list, so it isn't an app map.`);
    process.exit(1);
  }
}

await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(map, null, 2) + "\n");
console.log(
  `Saved ${out}\n  from ${url}\n  ${map.trpc.length} tRPC procedures, ${map.rest.length} REST routes, ${map.pages.length} pages`,
);
