import { api, h, icon, state } from "./ui.js";
import { runsView, runDetailView } from "./runs.js";
import { codeView } from "./code.js";
import { profilesView, profileView } from "./profiles.js";

const NAV = [
  { href: "#/runs", label: "Runs", icon: "runs", match: /^#\/runs/ },
  { href: "#/profiles", label: "Profiles", icon: "users", match: /^#\/profiles/ },
  { href: "#/code", label: "Code", icon: "code", match: /^#\/code/ },
];
const routes = [
  [/^#\/runs\/([A-Za-z0-9_-]+)$/, runDetailView],
  [/^#\/runs$/, runsView],
  [/^#\/profiles\/(\d+)$/, profileView],
  [/^#\/profiles$/, profilesView],
  [/^#\/code(?:\/(.+))?$/, codeView],
];

function navLinks(current) {
  return NAV.map((n) =>
    h("a", { href: n.href, "aria-current": n.match.test(current) ? "page" : null }, icon(n.icon), n.label),
  );
}

function renderChrome(current) {
  const cfg = state.config;
  const who = h("div", { class: "sidebar-foot" },
    h("div", {}, "Signed in as ", h("strong", {}, cfg.user.login)),
    cfg.user.canLaunch ? null : h("div", {}, "View only"),
    cfg.authMode === "github"
      ? h("button", { class: "signout", onclick: async () => { await api("/auth/logout", { method: "POST" }); location.href = "/"; } }, "Sign out")
      : h("div", {}, "Local mode"),
  );
  const brand = h("div", { class: "brand" }, h("span", { class: "brand-mark" }, icon("bolt")), "Load tests");
  document.getElementById("sidebar").replaceChildren(brand, h("nav", { class: "nav", "aria-label": "Sections" }, navLinks(current)), who);
  document.getElementById("topbar").replaceChildren(brand.cloneNode(true), h("nav", { class: "nav" }, navLinks(current)));
}

// A view may return a function (cleanup) or { dispose, guard }, where guard()
// returns false to stop the user leaving (e.g. unsaved edits).
let dispose = null, guard = null, current = "", ignoreNext = false;
async function render() {
  const hash = location.hash || "#/runs";
  if (dispose) { try { dispose(); } catch { /* view already gone */ } dispose = null; }
  guard = null;
  current = hash;
  renderChrome(hash);
  const view = document.getElementById("view");
  for (const [re, fn] of routes) {
    const m = re.exec(hash);
    if (m) {
      view.replaceChildren();
      try {
        const out = await fn(view, ...m.slice(1));
        dispose = typeof out === "function" ? out : out?.dispose ?? null;
        guard = out?.guard ?? null;
      } catch (err) { view.replaceChildren(h("p", { class: "error-text" }, `Could not load this page: ${err.message}`)); }
      view.focus({ preventScroll: true });
      return;
    }
  }
  location.hash = "#/runs";
}

async function init() {
  state.config = await api("/api/config");
  window.addEventListener("hashchange", () => {
    if (ignoreNext) { ignoreNext = false; return; }
    if (guard && guard() === false) { ignoreNext = true; location.hash = current; return; } // stay put
    render();
  });
  await render();
}
init().catch((err) => {
  document.getElementById("view").replaceChildren(h("p", { class: "error-text" }, `Could not load: ${err.message}`));
});
