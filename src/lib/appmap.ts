import http from "k6/http";
import { SharedArray } from "k6/data";
import { config } from "./config.ts";

// Just the parts of the app map we look at.
export interface TrpcEntry {
  path: string;
  type: "query" | "mutation";
  auth?: string;
}
export interface AppMap {
  trpc: TrpcEntry[];
  rest: unknown[];
  pages: unknown[];
}

export type MapSource = "runtime" | "fallback-file" | "none";

// Saved copy from `npm run fetch:app-map`. Only used if the runtime fetch
// fails. Read once at init and shared between VUs. Empty if there's no file.
const fallback = new SharedArray<AppMap>("appmap-fallback", () => {
  try {
    return [JSON.parse(open("../../data/app.json")) as AppMap];
  } catch {
    return [];
  }
});

function looksLikeMap(m: unknown): m is AppMap {
  const x = m as AppMap | null;
  return !!x && Array.isArray(x.trpc) && Array.isArray(x.rest) && Array.isArray(x.pages);
}

function fetchRuntime(): AppMap | null {
  if (!config.docsToken) {
    console.warn("DOCS_TOKEN not set, skipping the runtime app map fetch.");
    return null;
  }
  const res = http.get(`${config.docsRoot}/api/docs/app`, {
    headers: { authorization: `Bearer ${config.docsToken}` },
    tags: { name: "setup.app-map" },
    // We handle the status ourselves; a 401 here must not count as a failed
    // request in the load results.
    responseCallback: http.expectedStatuses({ min: 200, max: 599 }),
  });
  if (res.status !== 200) {
    console.warn(`App map fetch from ${config.docsRoot} returned ${res.status}.`);
    return null;
  }
  try {
    const body = res.json();
    return looksLikeMap(body) ? body : null;
  } catch {
    return null;
  }
}

/** Runtime fetch first, saved file second. Call from setup() only. */
export function loadAppMap(): { map: AppMap | null; source: MapSource } {
  const live = fetchRuntime();
  if (live) return { map: live, source: "runtime" };
  if (fallback.length > 0) {
    console.warn("Using the saved data/app.json, which may be out of date.");
    return { map: fallback[0], source: "fallback-file" };
  }
  console.warn("No app map available (no runtime fetch and no data/app.json).");
  return { map: null, source: "none" };
}

/** Lists scenario steps whose procedure is missing from the map or has the wrong type. */
export function findDrift(
  map: AppMap,
  steps: { path: string; type: string }[],
): string[] {
  const byPath = new Map(map.trpc.map((p) => [p.path, p]));
  const problems: string[] = [];
  for (const s of steps) {
    const p = byPath.get(s.path);
    if (!p) problems.push(`${s.path} is not in the app map`);
    else if (p.type !== s.type) problems.push(`${s.path} is a ${p.type} in the app map, not a ${s.type}`);
  }
  return problems;
}
