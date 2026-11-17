import { Options } from "k6/options";
import { config, assertSafeTarget } from "./lib/config.ts";
import { naive } from "./scenarios/naive.ts";

// Fails fast, before any load is sent.
export function setup(): void {
  assertSafeTarget();
  if (config.mode !== "naive") {
    throw new Error(
      `MODE=${config.mode} is not built yet. Only MODE=naive works for now.`,
    );
  }
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
