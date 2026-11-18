import { api, h, icon, status, empty, toast, state, fmtMs, fmtPct, fmtInt, fmtTime, fmtDuration, host } from "./ui.js";

const P95_TARGET_MS = 800;
const ERR_TARGET = 0.01;

// ---------- list ----------
export async function runsView(view) {
  const cfg = state.config;
  const body = h("div", { class: "card" });
  const newBtn = h("button", { class: "btn btn-primary full-mobile", disabled: !cfg.user.canLaunch, onclick: () => openLaunch(cfg) }, icon("plus"), "New run");
  view.append(
    h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, "Runs"), h("p", {}, "Launch a load test and see how the site holds up.")),
      newBtn),
    body,
  );

  async function refresh() {
    const runs = await api("/api/runs");
    if (!runs.length) {
      body.replaceChildren(empty("No runs yet", cfg.user.canLaunch ? "Start one with New run." : "Someone on the launch team can start one."));
      return;
    }
    body.replaceChildren(h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {},
        h("th", {}, "Status"), h("th", {}, "Started"), h("th", {}, "Target"),
        h("th", { class: "num" }, "Users"), h("th", { class: "num" }, "p95"), h("th", { class: "num" }, "Errors"), h("th", {}, "By"))),
      h("tbody", {}, runs.map((r) => {
        const tr = h("tr", { tabindex: "0", onclick: () => (location.hash = `#/runs/${r.id}`),
          onkeydown: (e) => { if (e.key === "Enter") location.hash = `#/runs/${r.id}`; } },
          h("td", {}, status(r.status)),
          h("td", {}, fmtTime(r.createdAt)),
          h("td", {}, host(r.params.target)),
          h("td", { class: "num" }, r.params.vus),
          h("td", { class: "num" }, fmtMs(r.summary?.p95Ms)),
          h("td", { class: "num" }, fmtPct(r.summary?.errorRate)),
          h("td", { class: "muted" }, r.launchedBy));
        return tr;
      })))));
  }
  await refresh();
  const t = setInterval(() => refresh().catch(() => {}), 4000);
  return () => clearInterval(t);
}

// ---------- launch dialog ----------
function openLaunch(cfg) {
  const err = h("p", { class: "error-text", role: "alert" });
  const sel = (name, opts, def) => h("select", { class: "select", name }, opts.map((o) => h("option", { value: o, selected: o === def }, o)));
  const go = h("button", { class: "btn btn-primary", type: "submit" }, "Start run");
  const form = h("form", { method: "dialog" },
    h("h2", {}, "New run"),
    h("p", { class: "lead" }, `Read-only traffic. Up to ${cfg.limits.maxVus} users and ${cfg.limits.maxDurationSec / 60} minutes.`),
    h("label", { class: "field" }, h("span", {}, "Target"), sel("target", cfg.targets)),
    h("div", { class: "field-row" },
      h("label", { class: "field" }, h("span", {}, "Mode"), sel("mode", cfg.modes)),
      h("label", { class: "field" }, h("span", {}, "Phase"), sel("phase", cfg.phases, "during"))),
    h("label", { class: "field" }, h("span", {}, "Users"),
      h("input", { class: "input", name: "vus", type: "number", min: 1, max: cfg.limits.maxVus, value: 10, required: true }),
      h("small", {}, "Concurrent simulated users.")),
    h("div", { class: "field-row" },
      h("label", { class: "field" }, h("span", {}, "Duration"), h("input", { class: "input", name: "duration", value: "30s", placeholder: "30s or 5m", required: true })),
      h("label", { class: "field" }, h("span", {}, "Ramp-up"), h("input", { class: "input", name: "rampUp", value: "10s", placeholder: "10s", required: true }))),
    err,
    h("div", { class: "dialog-actions" },
      h("button", { class: "btn btn-secondary", type: "button", onclick: () => dlg.close() }, "Cancel"), go),
  );
  const dlg = h("dialog", {}, form);
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    go.disabled = true;
    const f = form.elements;
    try {
      const run = await api("/api/runs", { method: "POST", body: JSON.stringify({
        target: f.target.value, mode: f.mode.value, phase: f.phase.value,
        vus: Number(f.vus.value), duration: f.duration.value.trim(), rampUp: f.rampUp.value.trim() }) });
      dlg.close();
      location.hash = `#/runs/${run.id}`;
    } catch (e2) { err.textContent = e2.message; go.disabled = false; }
  });
  dlg.showModal();
}

// ---------- detail ----------
export async function runDetailView(view, id) {
  let run = await api(`/api/runs/${encodeURIComponent(id)}`);
  const head = h("div", { class: "page-head" });
  const stats = h("div", { class: "stats" });
  const panel = h("div", { class: "card card-pad" });
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const bar = h("div", { class: "progress", hidden: true });
  const log = h("pre", { class: "log", "aria-live": "polite", "aria-label": "Run log" });
  let tab = "log";
  view.append(h("a", { class: "crumb", href: "#/runs" }, icon("back"), "All runs"), head, bar, stats, tabs, panel);

  function drawHead() {
    const stop = h("button", { class: "btn btn-danger", hidden: run.status !== "running" || !state.config.user.canLaunch,
      onclick: async (e) => { e.currentTarget.disabled = true; try { await api(`/api/runs/${run.id}/stop`, { method: "POST" }); toast("Stopping…"); } catch (er) { toast(er.message); e.currentTarget.disabled = false; } } },
      icon("stop"), "Stop run");
    head.replaceChildren(
      h("div", {}, h("h1", {}, host(run.params.target)),
        h("p", {}, status(run.status), h("span", { class: "muted" }, `  ·  ${run.params.vus} users  ·  ${fmtTime(run.createdAt)}  ·  ${run.launchedBy}`))),
      stop);
  }
  function drawStats() {
    const s = run.summary;
    const stat = (label, value, hint, bad) => h("div", { class: "card stat" },
      h("div", { class: "label" }, label), h("div", { class: bad ? "value bad" : "value" }, value), h("div", { class: "hint" }, hint));
    stats.replaceChildren(
      stat("p95 latency", fmtMs(s?.p95Ms), `Goal: under ${P95_TARGET_MS} ms`, s?.p95Ms > P95_TARGET_MS),
      stat("Error rate", fmtPct(s?.errorRate), `Goal: under ${ERR_TARGET * 100}%`, s?.errorRate > ERR_TARGET),
      stat("Requests", fmtInt(s?.requests), run.status === "running" ? "Updates when the run ends" : " "),
      stat("Duration", run.status === "running" ? "…" : fmtDuration(run.createdAt, run.finishedAt), `${run.params.rampUp} ramp-up + ${run.params.duration}`));
  }
  function drawTabs() {
    const defs = [["log", "Log"], ["report", "Report"], ["details", "Details"]];
    tabs.replaceChildren(...defs.map(([k, label]) => h("button", { class: "tab", role: "tab", "aria-selected": String(tab === k),
      onclick: () => { tab = k; drawTabs(); drawPanel(); } }, label)));
  }
  function drawPanel() {
    if (tab === "log") panel.replaceChildren(log);
    else if (tab === "report") {
      if (!run.hasReport) {
        panel.replaceChildren(empty(run.status === "running" ? "Report not ready" : "No report for this run",
          run.status === "running" ? "It appears when the run finishes." : "k6 skips the report when a run is too short to have enough data. The log and summary still apply."));
      } else {
        const src = `/results/${encodeURIComponent(run.id)}.html`;
        panel.replaceChildren(
          h("p", { class: "muted report-links" }, h("a", { href: src, target: "_blank", rel: "noopener" }, "Open full page"), "  ·  ",
            h("a", { href: `/results/${encodeURIComponent(run.id)}.json`, target: "_blank", rel: "noopener" }, "Summary JSON")),
          h("iframe", { class: "report-frame", src, title: "k6 report", sandbox: "allow-scripts" }));
      }
    } else {
      const p = run.params;
      const rows = [["Run id", run.id], ["Target", p.target], ["Mode", p.mode], ["Phase", p.phase], ["Users", p.vus],
        ["Ramp-up", p.rampUp], ["Duration", p.duration], ["Launched by", run.launchedBy], ["Exit code", run.exitCode ?? "–"]];
      panel.replaceChildren(h("dl", { class: "kv" }, rows.flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, String(v))])));
    }
  }
  function drawProgress(p) {
    if (run.status !== "running" || !p) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.replaceChildren(
      h("div", { class: "progress-track", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": p.pct, "aria-label": "Run progress" },
        h("div", { class: "progress-fill", style: { width: `${p.pct}%` } })),
      h("div", { class: "progress-meta" }, h("span", {}, `${p.pct}% complete`), h("span", {}, `${p.vus} of ${p.maxVus} users active`)));
  }
  function drawAll() { drawHead(); drawStats(); drawTabs(); drawPanel(); }
  drawAll();

  // live log
  const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/logs`);
  es.onmessage = (e) => {
    const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    log.append(JSON.parse(e.data) + "\n");
    if (atEnd) log.scrollTop = log.scrollHeight;
  };
  es.addEventListener("progress", (e) => drawProgress(JSON.parse(e.data)));
  es.addEventListener("end", async () => { es.close(); run = await api(`/api/runs/${encodeURIComponent(id)}`); drawProgress(null); drawAll(); });
  es.onerror = () => es.close();
  const t = setInterval(async () => {
    if (run.status !== "running") return;
    try { const next = await api(`/api/runs/${encodeURIComponent(id)}`); if (next.status !== run.status) { run = next; drawAll(); } } catch { /* retry next tick */ }
  }, 3000);
  return () => { es.close(); clearInterval(t); };
}
