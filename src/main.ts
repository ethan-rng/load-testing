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
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800"],
  },
};

export { naive };
