// Shared state (filled in by app.js at startup).
export const state = { config: null };

// Small helpers. Everything is built with textContent/DOM nodes, never innerHTML
// with data, so nothing from the server can inject markup.

export function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "dataset") Object.assign(n.dataset, v);
    else if (k === "style") Object.assign(n.style, v); // object form only: CSP blocks style="" attributes
    else if (v === true) n.setAttribute(k, "");
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}

// Inline icons (24px grid, stroke only). Static strings written here, no data.
const ICONS = {
  runs: '<path d="M5 4v16l14-8z"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 5l-4 14"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.4c1.8.8 3 2.6 3 5.6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="m15 6-6 6 6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6z"/>',
};
export function icon(name) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("fill", "none");
  s.setAttribute("stroke", "currentColor");
  s.setAttribute("stroke-width", "1.8");
  s.setAttribute("stroke-linecap", "round");
  s.setAttribute("stroke-linejoin", "round");
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] ?? "";
  return s;
}

export const fmtMs = (v) => (v == null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);
export const fmtPct = (v) => (v == null ? "–" : `${(v * 100).toFixed(v < 0.001 && v > 0 ? 2 : 1)}%`);
export const fmtInt = (v) => (v == null ? "–" : v.toLocaleString());
export const fmtTime = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export function fmtDuration(startIso, endIso) {
  if (!endIso) return "–";
  const s = Math.max(0, Math.round((new Date(endIso) - new Date(startIso)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
export const host = (url) => url.replace(/^https?:\/\//, "");

const LABELS = { running: "Running", succeeded: "Passed", failed: "Failed", stopped: "Stopped", interrupted: "Interrupted" };
export const status = (s) => h("span", { class: `status s-${s}` }, h("span", { class: "dot" }), LABELS[s] ?? s);

export function empty(title, body) {
  return h("div", { class: "empty" }, h("strong", {}, title), body);
}

let toastTimer;
export function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", "x-requested-with": "runs-ui", ...(opts.headers ?? {}) },
  });
  if (res.status === 401) { location.href = "/auth/login"; throw new Error("Signing in…"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
