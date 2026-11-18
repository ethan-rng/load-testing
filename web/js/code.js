import { api, h, icon, empty, toast } from "./ui.js";
import { highlight } from "./highlight.js";

const DEFAULT_FILE = "src/scenarios/naive.ts";
const BLURB = {
  src: "k6 test: what each simulated user does",
  scripts: "Helper scripts: checks and fetching the app map",
  server: "This web app's API and run launcher",
  web: "This web app's pages",
  test: "Tests and the mock server",
};
const fmtSize = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export async function codeView(view, wanted) {
  const files = await api("/api/code/tree");
  const current = wanted ? decodeURIComponent(wanted) : files.some((f) => f.path === DEFAULT_FILE) ? DEFAULT_FILE : files[0]?.path;

  const tree = h("nav", { class: "tree card", "aria-label": "Files" });
  const viewer = h("div", { class: "viewer card" });
  view.append(
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "Code"), h("p", {}, "Read-only view of what the load test runs."))),
    h("div", { class: "code-layout" }, tree, viewer));

  // group by top folder; root files go under "Project"
  const groups = new Map();
  for (const f of files) {
    const top = f.path.includes("/") ? f.path.split("/")[0] : "";
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(f);
  }
  const order = ["src", "server", "web", "scripts", "test", ""];
  const link = (f, label) => h("a", { href: `#/code/${f.path.split("/").map(encodeURIComponent).join("/")}`, "aria-current": f.path === current ? "page" : null }, icon("file"), label);
  tree.replaceChildren(...order.filter((k) => groups.has(k)).map((k) =>
    h("details", { open: k === "" || current?.startsWith(k + "/") || k === "src" },
      h("summary", {}, icon("folder"), k || "Project files"),
      k && BLURB[k] ? h("p", { class: "blurb" }, BLURB[k]) : null,
      h("ul", {}, groups.get(k).map((f) => h("li", {}, link(f, k ? f.path.slice(k.length + 1) : f.path)))))));

  if (!current) { viewer.replaceChildren(empty("No files", "Nothing to show.")); return; }
  let file;
  try { file = await api(`/api/code/file?path=${encodeURIComponent(current)}`); }
  catch (e) { viewer.replaceChildren(empty("Can't show that file", e.message)); return; }

  const lines = highlight(file.content, file.language);
  const code = h("div", { class: "code", role: "region", "aria-label": file.path, tabindex: "0" },
    lines.map((tokens, i) => h("div", { class: "ln" }, h("span", { class: "n", "aria-hidden": "true" }, i + 1),
      h("span", { class: "c" }, tokens.length ? tokens.map((t) => (t.cls ? h("span", { class: `tok-${t.cls}` }, t.text) : t.text)) : "​"))));
  viewer.replaceChildren(
    h("div", { class: "viewer-head" },
      h("div", {}, h("div", { class: "viewer-path" }, file.path), h("div", { class: "muted small" }, `${lines.length} lines · ${fmtSize(file.size)}`)),
      h("button", { class: "btn btn-outline btn-sm", onclick: async () => { try { await navigator.clipboard.writeText(file.content); toast("Copied"); } catch { toast("Couldn't copy"); } } }, "Copy")),
    code);
}
