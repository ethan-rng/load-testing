import http from "k6/http";
import { Options } from "k6/options";
import { config, assertSafeTarget } from "./lib/config.ts";
import { naive, anonymousSteps, hackerSteps } from "./scenarios/naive.ts";
import { loadAppMap, findDrift, MapSource } from "./lib/appmap.ts";

// Fails fast, before any load is sent.
export function setup(): { mapSource: MapSource } {
  assertSafeTarget();
  if (config.mode !== "naive") {
    throw new Error(
      `MODE=${config.mode} is not built yet. Only MODE=naive works for now.`,
    );
  }

  // Stop before any load if the target doesn't answer at all.
  const probe = http.get(`${config.target}/api/auth/csrf`, {
    tags: { name: "setup.probe" },
    timeout: "10s",
  });
  if (probe.status === 0) {
    throw new Error(
      `Target ${config.target} is not reachable (${probe.error || "no response"}). Nothing was sent.`,
    );
  }

  // Check the scenario's routes still exist in the app. Warns, never fails:
  // naive mode doesn't need the map to run.
  const { map, source } = loadAppMap();
  if (map) {
    const problems = findDrift(map, [...anonymousSteps, ...hackerSteps]);
    for (const p of problems) console.warn(`Route check: ${p}`);
    console.log(`App map: ${source}, ${problems.length} route problem(s).`);
  }
  return { mapSource: source };
}

export const options: Options = {
  // Each VU logs in once and keeps its session. By default k6 clears cookies
  // at the start of every iteration, which silently logged VUs out after the first.
  noCookiesReset: true,
  scenarios: {
    naive: {
      executor: "ramping-vus",
      exec: "naive",
      startVUs: 0,
      stages: [
        { duration: config.rampUp, target: config.vus },
        { duration: config.duration, target: config.vus },
      ],
      gracefulRampDown: "5s",
    },
  },
  tags: {
    testid: config.testId,
    mode: config.mode,
    phase: config.phase,
  },
  thresholds: {
    // abortOnFail stops a run that is mostly failing instead of hammering a
    // target that has stopped answering.
    http_req_failed: [{ threshold: "rate<0.01", abortOnFail: true, delayAbortEval: "10s" }],
    http_req_duration: ["p(95)<800"],
  },
};

export { naive };
