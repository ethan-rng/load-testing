// All configuration comes from env vars (k6 -e KEY=value), so the same scripts
// run unchanged on a laptop, a VM, CI, or anywhere else.

export type Mode = "naive" | "realistic";
export type Phase = "before" | "during" | "after";

function env(name: string, fallback: string): string {
  const v = __ENV[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  target: env("TARGET", "http://localhost:3000").replace(/\/+$/, ""),
  mode: env("MODE", "naive") as Mode,
  phase: env("PHASE", "during") as Phase,
  vus: parseInt(env("VUS", "10"), 10),
  duration: env("DURATION", "30s"),
  rampUp: env("RAMP_UP", "10s"),
  testId: env("TEST_ID", `adhoc-${Date.now()}`),
  // Mutations stay off unless explicitly enabled.
  allowMutations: env("ALLOW_MUTATIONS", "false") === "true",
  // Optional single account, used when there is no data/users.json yet.
  email: env("TEST_EMAIL", ""),
  password: env("TEST_PASSWORD", ""),
  // Comma separated hostnames that may be tested besides localhost.
  allowedHosts: env("ALLOWED_HOSTS", "dev.hackwestern.com")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
  // Hosts that must never be tested.
  blockedHosts: ["hackwestern.com", "www.hackwestern.com"],
};

function hostOf(url: string): string {
  const m = url.match(/^https?:\/\/([^/:]+)/i);
  return m ? m[1].toLowerCase() : "";
}

/** Refuses to run against production or any host not explicitly allowed. */
export function assertSafeTarget(): void {
  const host = hostOf(config.target);
  if (!host) throw new Error(`TARGET is not a valid URL: ${config.target}`);
  if (config.blockedHosts.includes(host)) {
    throw new Error(`Refusing to load test ${host}: that is production.`);
  }
  const local = host === "localhost" || host === "127.0.0.1";
  if (!local && !config.allowedHosts.includes(host)) {
    throw new Error(
      `Host ${host} is not allowed. Add it to ALLOWED_HOSTS if it's a dev/staging target.`,
    );
  }
}

/** Procedures that must never be called, even if a scenario lists them. */
export const DENY_LIST = new Set<string>([
  // send email through Mailjet
  "auth.create",
  "auth.resendEmail",
  "auth.reset",
  // call GitHub / Devpost
  "cheatCheck.commitWithinAllottedTime",
  "cheatCheck.devPostMembersAreRegistered",
  "cheatCheck.onlyTeamMemberCommits",
  "cheatCheck.runAllTeamChecks",
  "cheatCheck.runAllHackerChecks",
  "cheatCheck.startSweep",
  "cheatCheck.resumeSweep",
  // destructive
  "application.bulkUpdateStatusByEmails",
  "judging.admin.purgeQueue",
  "judging.admin.loadQueue",
  "teams.deleteTeam",
  "scavengerHunt.deleteScavengerHuntItem",
]);
