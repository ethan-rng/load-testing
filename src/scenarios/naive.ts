import { sleep } from "k6";
import { SharedArray } from "k6/data";
import { config } from "../lib/config.ts";
import { login, TestUser } from "../lib/auth.ts";
import { trpc, ProcedureType } from "../lib/trpc.ts";

// Users come from data/users.json (made by the seed script). If it's missing
// we fall back to a single account from TEST_EMAIL / TEST_PASSWORD, or run
// anonymous only.
const users = new SharedArray<TestUser>("users", () => {
  try {
    return JSON.parse(open("../../data/users.json")) as TestUser[];
  } catch {
    return config.email
      ? [{ email: config.email, password: config.password, role: "hacker" }]
      : [];
  }
});

interface Step {
  path: string;
  type: ProcedureType;
  input?: unknown;
  expected?: number[];
}

// Fixed, hand-picked journeys. Phase 1 only uses read-only calls.
const anonymousSteps: Step[] = [
  { path: "scavengerHunt.getAllScavengerHuntItems", type: "query" },
];

const hackerSteps: Step[] = [
  { path: "application.get", type: "query" },
  { path: "scavengerHunt.getPoints", type: "query" },
  { path: "scavengerHunt.getScans", type: "query" },
  { path: "teamFinder.list", type: "query" },
  { path: "teamFinder.getMine", type: "query" },
  // 400 when the user isn't on a team, which is the normal case
  { path: "teams.getTeam", type: "query", expected: [400, 404] },
];

// Per-VU state. Each VU is its own JS runtime, so module variables are per VU.
let loggedIn: boolean | undefined;

export function naive(): void {
  const user = users.length > 0 ? users[(__VU - 1) % users.length] : undefined;

  if (user && loggedIn === undefined) loggedIn = login(user);

  const steps = loggedIn ? [...anonymousSteps, ...hackerSteps] : anonymousSteps;
  for (const s of steps) {
    trpc(s.path, s.type, s.input, { expected: s.expected });
    sleep(1 + Math.random() * 2);
  }
}
