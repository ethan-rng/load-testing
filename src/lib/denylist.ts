// Procedures that must never be called. Plain TypeScript with no k6 globals,
// so both the k6 scripts and the Node server (profile generation) import it.
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
