"use strict";
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", "x-requested-with": "runs-ui" },
  });
  if (res.status === 401) { location.href = "/auth/login"; throw new Error("Signing in…"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const fmtTime = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtMs = (v) => (v == null ? "–" : `${Math.round(v)} ms`);
const fmtPct = (v) => (v == null ? "–" : `${(v * 100).toFixed(2)}%`);
const pill = (s) => el("span", { className: `pill s-${s}`, textContent: s });

let selected = null;
let stream = null;

async function init() {
  const cfg = await api("/api/config");
  $("who").textContent = `Signed in as ${cfg.user.login}${cfg.user.canLaunch ? "" : " (view only)"}`;
  if (cfg.authMode === "github") {
    $("signout").hidden = false;
    $("signout").addEventListener("click", async () => { await api("/auth/logout", { method: "POST" }); location.href = "/"; });
  }
  const f = $("form");
  for (const t of cfg.targets) f.target.append(el("option", { value: t, textContent: t }));
  for (const m of cfg.modes) f.mode.append(el("option", { value: m, textContent: m }));
  for (const p of cfg.phases) f.phase.append(el("option", { value: p, textContent: p, selected: p === "during" }));
  f.vus.max = cfg.limits.maxVus;
  $("limits").textContent = `Max ${cfg.limits.maxVus} users, ${cfg.limits.maxDurationSec / 60} min. Read-only: nothing is changed on the target.`;
  if (!cfg.user.canLaunch) { $("go").disabled = true; $("formError").textContent = "You can view runs but not launch them."; }

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("formError").textContent = "";
    $("go").disabled = true;
    try {
      const run = await api("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          target: f.target.value, mode: f.mode.value, phase: f.phase.value,
          vus: Number(f.vus.value), duration: f.duration.value.trim(), rampUp: f.rampUp.value.trim(),
        }),
      });
      await refresh();
      select(run.id);
    } catch (err) {
      $("formError").textContent = err.message;
    } finally {
      $("go").disabled = false;
    }
  });

  $("stop").addEventListener("click", async () => {
    $("stop").disabled = true;
    try { await api(`/api/runs/${selected}/stop`, { method: "POST" }); } catch (err) { $("formError").textContent = err.message; }
  });

  await refresh();
  setInterval(refresh, 4000);
}

async function refresh() {
  const runs = await api("/api/runs");
  const body = $("rows");
  body.replaceChildren();
  if (!runs.length) body.append(el("tr", {}, el("td", { colSpan: 7, className: "muted", textContent: "No runs yet." })));
  for (const r of runs) {
    const tr = el("tr", { className: r.id === selected ? "sel" : "" },
      el("td", { textContent: fmtTime(r.createdAt) }),
      el("td", {}, pill(r.status)),
      el("td", { textContent: r.params.target.replace(/^https?:\/\//, "") }),
      el("td", { textContent: String(r.params.vus) }),
      el("td", { textContent: fmtMs(r.summary?.p95Ms) }),
      el("td", { textContent: fmtPct(r.summary?.errorRate) }),
      el("td", { textContent: r.launchedBy }),
    );
    tr.addEventListener("click", () => select(r.id));
    body.append(tr);
  }
  if (selected) showMeta(runs.find((r) => r.id === selected));
}

function showMeta(run) {
  if (!run) return;
  $("dTitle").replaceChildren(run.id, " ", pill(run.status));
  $("stop").hidden = run.status !== "running";
  $("stop").disabled = false;
  const rows = [
    ["Target", run.params.target], ["Mode / phase", `${run.params.mode} / ${run.params.phase}`],
    ["Users", String(run.params.vus)], ["Duration", `${run.params.rampUp} ramp-up + ${run.params.duration}`],
    ["Launched by", run.launchedBy], ["Started", fmtTime(run.createdAt)],
    ["p95 latency", fmtMs(run.summary?.p95Ms)], ["Error rate", fmtPct(run.summary?.errorRate)],
    ["Requests", run.summary?.requests == null ? "–" : String(run.summary.requests)],
  ];
  $("dMeta").replaceChildren(...rows.flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })]));
  const box = $("reportBox");
  if (run.hasReport) {
    box.hidden = false;
    const src = `/results/${encodeURIComponent(run.id)}.html`;
    if ($("report").getAttribute("src") !== src) $("report").setAttribute("src", src);
    $("reportLink").href = src;
    $("jsonLink").href = `/results/${encodeURIComponent(run.id)}.json`;
  } else {
    box.hidden = true;
    $("report").removeAttribute("src");
  }
}

function select(id) {
  selected = id;
  if (stream) stream.close();
  $("detail").hidden = false;
  const log = $("log");
  log.textContent = "";
  stream = new EventSource(`/api/runs/${encodeURIComponent(id)}/logs`);
  stream.onmessage = (e) => {
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    log.append(JSON.parse(e.data) + "\n");
    if (atEnd) log.scrollTop = log.scrollHeight;
  };
  stream.addEventListener("end", () => { stream.close(); refresh(); });
  stream.onerror = () => stream.close();
  refresh();
  $("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

init().catch((err) => { document.body.prepend(el("p", { className: "error", textContent: `Could not load: ${err.message}` })); });
