// Read-only access to this project's source, for the Code page.
// An allowlist, not a denylist: only a few folders and file types are visible,
// and symlinks are resolved so they can't be used to reach anything else
// (.env, data/, results/, node_modules, .git are never reachable).
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep, posix } from "node:path";

const DIRS = ["src", "scripts", "server", "web", "test"];
// .env.example holds placeholders only; the real .env is not on this list.
const ROOT_FILES = new Set(["README.md", "package.json", "tsconfig.json", "run.sh", ".env.example"]);
const EXT = new Set([".ts", ".js", ".mjs", ".json", ".md", ".sh", ".css", ".html"]);
export const MAX_BYTES = 300_000;

export interface CodeFile { path: string; size: number }
export interface CodeContent extends CodeFile { content: string; language: string }

/** Is this project-relative path (forward slashes) allowed to be shown? */
export function isViewable(rel: string): boolean {
  if (!rel || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) return false;
  const norm = posix.normalize(rel);
  if (norm !== rel) return false; // rejects ./x, a//b, src/../x
  if (norm === ".." || norm.startsWith("../")) return false;
  const parts = norm.split("/");
  if (parts.length === 1) return ROOT_FILES.has(norm);
  if (!DIRS.includes(parts[0])) return false;
  if (parts.some((p) => p.startsWith(".") || p === "node_modules")) return false;
  return EXT.has(extname(norm));
}

function walk(root: string, dir: string, out: CodeFile[]): void {
  for (const name of readdirSync(join(root, dir))) {
    const rel = dir ? `${dir}/${name}` : name;
    const abs = join(root, rel);
    const l = lstatSync(abs);
    if (l.isSymbolicLink()) continue;
    if (l.isDirectory()) { if (!name.startsWith(".") && name !== "node_modules") walk(root, rel, out); continue; }
    if (l.isFile() && isViewable(rel) && l.size <= MAX_BYTES) out.push({ path: rel, size: l.size });
  }
}

export function listFiles(root: string): CodeFile[] {
  const out: CodeFile[] = [];
  for (const f of ROOT_FILES) {
    const abs = join(root, f);
    if (existsSync(abs) && lstatSync(abs).isFile() && !lstatSync(abs).isSymbolicLink()) out.push({ path: f, size: statSync(abs).size });
  }
  for (const d of DIRS) if (existsSync(join(root, d))) walk(root, d, out);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The file's text, or null if the path isn't allowed, missing, too big, or escapes the project. */
export function readCodeFile(root: string, rel: string): CodeContent | null {
  if (!isViewable(rel)) return null;
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(resolve(root, rel));
  } catch { return null; }
  if (!real.startsWith(realRoot + sep)) return null;
  // A symlink inside src/ could point at .env inside the project: check where it really lands.
  if (!isViewable(relative(realRoot, real).split(sep).join("/"))) return null;
  const st = statSync(real);
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  return { path: rel, size: st.size, content: readFileSync(real, "utf8"), language: extname(rel).slice(1) || (rel.endsWith("run.sh") ? "sh" : "txt") };
}
