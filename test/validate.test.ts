import { test } from "node:test";
import assert from "node:assert/strict";
import { validateParams, assertConfig, parseDuration, LIMITS } from "../server/validate.ts";

const env = { ALLOWED_TARGETS: "https://dev.hackwestern.com,http://localhost:3999" };
const ok = (body: unknown) => validateParams(body, env);

test("accepts a normal launch and fills defaults", () => {
  const r = ok({ target: "https://dev.hackwestern.com" });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.params, { target: "https://dev.hackwestern.com", mode: "naive", phase: "during", vus: 10, duration: "30s", rampUp: "10s" });
});

test("trailing slash on target is fine", () => {
  assert.equal(ok({ target: "https://dev.hackwestern.com/" }).ok, true);
});

test("refuses production and unlisted targets", () => {
  assert.equal(ok({ target: "https://hackwestern.com" }).ok, false);
  assert.equal(ok({ target: "https://www.hackwestern.com" }).ok, false);
  assert.equal(ok({ target: "https://example.org" }).ok, false);
  assert.equal(ok({ target: "https://dev.hackwestern.com.evil.com" }).ok, false);
  assert.equal(ok({}).ok, false);
});

test("caps VUs and duration", () => {
  const t = "https://dev.hackwestern.com";
  assert.equal(ok({ target: t, vus: LIMITS.maxVus }).ok, true);
  assert.equal(ok({ target: t, vus: LIMITS.maxVus + 1 }).ok, false);
  assert.equal(ok({ target: t, vus: 0 }).ok, false);
  assert.equal(ok({ target: t, vus: 1.5 }).ok, false);
  assert.equal(ok({ target: t, vus: "10" }).ok, false);
  assert.equal(ok({ target: t, duration: "10m" }).ok, true);
  assert.equal(ok({ target: t, duration: "11m" }).ok, false);
  assert.equal(ok({ target: t, duration: "30" }).ok, false);
  assert.equal(ok({ target: t, rampUp: "3m" }).ok, false);
});

test("rejects unknown fields, including a mutations switch", () => {
  assert.equal(ok({ target: "https://dev.hackwestern.com", allowMutations: true }).ok, false);
  assert.equal(ok({ target: "https://dev.hackwestern.com", env: "x" }).ok, false);
});

test("rejects bad mode, phase and body shape", () => {
  const t = "https://dev.hackwestern.com";
  assert.equal(ok({ target: t, mode: "realistic" }).ok, false);
  assert.equal(ok({ target: t, phase: "never" }).ok, false);
  assert.equal(ok(null).ok, false);
  assert.equal(ok([]).ok, false);
  assert.equal(ok("x").ok, false);
});

test("startup refuses a config that allows production", () => {
  assert.throws(() => assertConfig({ ALLOWED_TARGETS: "https://hackwestern.com" }));
  assert.throws(() => assertConfig({ ALLOWED_TARGETS: "https://dev.hackwestern.com,https://www.hackwestern.com" }));
  assert.doesNotThrow(() => assertConfig(env));
});

test("parseDuration", () => {
  assert.equal(parseDuration("90s"), 90);
  assert.equal(parseDuration("2m"), 120);
  assert.equal(parseDuration("2h"), null);
  assert.equal(parseDuration(5), null);
});
