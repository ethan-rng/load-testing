import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isViewable, listFiles, readCodeFile, MAX_BYTES } from "../server/code.ts";

function fixture(): string {
  const r = mkdtempSync(join(tmpdir(), "code-"));
  for (const d of ["src/lib", "server", "data", "results", "node_modules/x", ".git", "web/fonts"]) mkdirSync(join(r, d), { recursive: true });
  const w = (p: string, c = "x") => writeFileSync(join(r, p), c);
  w("src/main.ts", "export {}"); w("src/lib/a.ts"); w("server/s.ts"); w("README.md"); w("package.json", "{}");
  w(".env", "SECRET=1"); w(".env.example", "A=");
  w("data/users.json", "[]"); w("data/runs.json"); w("results/a.log"); w("node_modules/x/i.js"); w(".git/config");
  w("web/fonts/f.woff2"); w("src/.hidden.ts"); w("src/big.ts", "a".repeat(MAX_BYTES + 1));
  writeFileSync(join(r, "outside.txt"), "outside"); // not on any list
  return r;
}

test("allows source files and the few root files", () => {
  for (const p of ["src/main.ts", "src/lib/a.ts", "server/s.ts", "web/js/app.js", "test/x.test.ts", "README.md", "package.json", "run.sh", ".env.example"]) assert.equal(isViewable(p), true, p);
});

test("refuses secrets, data, results, dependencies and git", () => {
  for (const p of [".env", ".env.local", "data/users.json", "data/runs.json", "results/a.log", "node_modules/x/i.js", ".git/config", "package-lock.json", "src/.hidden.ts", "web/fonts/f.woff2", "src/node_modules/x.js"]) assert.equal(isViewable(p), false, p);
});

test("refuses traversal and odd paths", () => {
  for (const p of ["../etc/passwd", "src/../.env", "./src/main.ts", "/etc/passwd", "src//main.ts", "src\\main.ts", "src/main.ts\0.png", "", "..", "src/%2e%2e/.env"]) assert.equal(isViewable(p), false, JSON.stringify(p));
});

test("lists only allowed files", () => {
  const r = fixture();
  const names = listFiles(r).map((f) => f.path);
  assert.deepEqual(names, [".env.example", "package.json", "README.md", "server/s.ts", "src/lib/a.ts", "src/main.ts"]);
});

test("reads allowed files and rejects everything else", () => {
  const r = fixture();
  assert.equal(readCodeFile(r, "src/main.ts")?.content, "export {}");
  assert.equal(readCodeFile(r, "src/main.ts")?.language, "ts");
  for (const p of [".env", "data/users.json", "../outside.txt", "src/missing.ts", "src/big.ts"]) assert.equal(readCodeFile(r, p), null, p);
});

test("symlinks can't be used to reach other files", () => {
  const r = fixture();
  symlinkSync(join(r, ".env"), join(r, "src/link-env.ts"));
  symlinkSync(join(r, "outside.txt"), join(r, "src/link-out.ts"));
  symlinkSync("/etc/hosts", join(r, "src/link-abs.ts"));
  symlinkSync(join(r, "data"), join(r, "src/linkdir"));
  for (const p of ["src/link-env.ts", "src/link-out.ts", "src/link-abs.ts"]) assert.equal(readCodeFile(r, p), null, p);
  assert.equal(readCodeFile(r, "src/linkdir/users.json"), null);
  assert.ok(!listFiles(r).some((f) => f.path.includes("link")), "symlinks are not listed");
});
