import { api, h, icon, empty, toast, state, fmtInt, fmtTime } from "./ui.js";

const PHASES = ["before", "during", "after"];
const PAGE = 50;
const fmtSecs = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
// Long names like scavengerHunt.getAllScavengerHuntItems may wrap, but only after a dot.
const procName = (name) => name.split(".").flatMap((part, i, a) => (i < a.length - 1 ? [part + ".", document.createElement("wbr")] : [part]));
const canWrite = () => state.config.user.canLaunch;
const srcLabel = (s) => (s.startsWith("d1:") ? `D1 · ${s.slice(3)}` : s.startsWith("copy:") ? `Copy of #${s.slice(5)}` : "Hand-made");

// ====================== list ======================
export async function profilesView(view) {
  let phase = "", q = "", offset = 0, data = { total: 0, items: [] }, stats = { phases: [], mix: [], procedures: [] };
  const selected = new Set();

  const head = h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, "Profiles"), h("p", {}, "Simulated users built from real traffic. Realistic runs replay these.")),
    h("div", { class: "actions" },
      h("button", { class: "btn btn-secondary", disabled: !canWrite(), onclick: publish }, "Publish to k6"),
      h("button", { class: "btn btn-primary", disabled: !canWrite(), onclick: () => openGenerate(reload) }, icon("plus"), "Generate from D1")));
  const chips = h("div", { class: "chips", role: "group", "aria-label": "Filter by phase" });
  const search = h("input", { class: "input search", type: "search", placeholder: "Search by name", "aria-label": "Search profiles",
    oninput: debounce((e) => { q = e.target.value.trim(); offset = 0; reload(); }, 250) });
  const bulkBar = h("div", { class: "bulk", hidden: true });
  const tableCard = h("div", { class: "card" });
  const mixCard = h("div", { class: "card card-pad mix" });
  view.append(head, h("div", { class: "toolbar" }, chips, search),
    h("div", { class: "profiles-layout" }, h("div", {}, bulkBar, tableCard), mixCard));

  function drawChips() {
    const count = (p) => stats.phases.filter((x) => !p || x.phase === p).reduce((a, x) => a + x.profiles, 0);
    chips.replaceChildren(...[["", "All"], ...PHASES.map((p) => [p, p[0].toUpperCase() + p.slice(1)])].map(([p, label]) =>
      h("button", { class: "chip", "aria-pressed": String(phase === p), onclick: () => { phase = p; offset = 0; selected.clear(); reload(); } }, label, h("span", { class: "chip-n" }, count(p)))));
  }

  function drawMix() {
    const max = Math.max(...stats.mix.map((m) => m.share), 0.0001);
    mixCard.replaceChildren(
      h("div", { class: "section-label" }, `What users do${phase ? ` · ${phase}` : ""}`),
      stats.mix.length
        ? h("ul", { class: "bars" }, stats.mix.map((m) => h("li", {},
            h("div", { class: "bar-label" }, h("span", { class: "bar-name", title: m.procedure }, procName(m.procedure)), h("span", { class: "bar-val" }, `${(m.share * 100).toFixed(m.share < 0.1 ? 1 : 0)}%`)),
            h("div", { class: "bar-track", "aria-hidden": "true" }, h("div", { class: "bar-fill", style: { width: `${(m.share / max) * 100}%` } })))))
        : h("p", { class: "muted" }, "Share of calls across enabled profiles, once weights are applied. Nothing to show yet."));
  }

  function drawBulk() {
    bulkBar.hidden = selected.size === 0 || !canWrite();
    if (bulkBar.hidden) return;
    const act = (action) => async () => {
      if (action === "delete" && !confirm(`Delete ${selected.size} profile${selected.size === 1 ? "" : "s"}? This can't be undone.`)) return;
      try { const r = await api("/api/profiles/bulk", { method: "POST", body: JSON.stringify({ action, ids: [...selected] }) }); toast(`${r.changed} profile${r.changed === 1 ? "" : "s"} updated`); selected.clear(); reload(); }
      catch (e) { toast(e.message); }
    };
    bulkBar.replaceChildren(h("strong", {}, `${selected.size} selected`),
      h("button", { class: "btn btn-outline btn-sm", onclick: act("enable") }, "Enable"),
      h("button", { class: "btn btn-outline btn-sm", onclick: act("disable") }, "Disable"),
      h("button", { class: "btn btn-danger btn-sm", onclick: act("delete") }, "Delete"));
  }

  function drawTable() {
    if (!data.total && !q && !phase) {
      tableCard.replaceChildren(h("div", { class: "empty-wrap" }, empty("No profiles yet",
        canWrite() ? "Generate them from a D1 export, or build one by hand from a profile's page." : "Someone on the launch team can generate them.")));
      return;
    }
    if (!data.items.length) { tableCard.replaceChildren(h("div", { class: "empty-wrap" }, empty("No matches", "Try a different phase or search."))); return; }
    const all = h("input", { type: "checkbox", "aria-label": "Select all on this page", disabled: !canWrite(),
      onchange: (e) => { for (const p of data.items) e.target.checked ? selected.add(p.id) : selected.delete(p.id); drawTable(); drawBulk(); } });
    all.checked = data.items.every((p) => selected.has(p.id));
    const from = offset + 1, to = offset + data.items.length;
    tableCard.replaceChildren(
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", { class: "check" }, all), h("th", {}, "Name"), h("th", { class: "hide-sm" }, "Phase"), h("th", { class: "num" }, "Steps"), h("th", { class: "num hide-sm" }, "Length"), h("th", { class: "num" }, "Weight"), h("th", {}, "Status"))),
        h("tbody", {}, data.items.map((p) => {
          const cb = h("input", { type: "checkbox", "aria-label": `Select ${p.name}`, disabled: !canWrite(), onclick: (e) => e.stopPropagation(),
            onchange: (e) => { e.target.checked ? selected.add(p.id) : selected.delete(p.id); drawBulk(); drawTable(); } });
          cb.checked = selected.has(p.id);
          return h("tr", { tabindex: "0", class: p.enabled ? "" : "off", onclick: () => (location.hash = `#/profiles/${p.id}`), onkeydown: (e) => { if (e.key === "Enter") location.hash = `#/profiles/${p.id}`; } },
            h("td", { class: "check", onclick: (e) => e.stopPropagation() }, cb), h("td", { class: "name-cell" }, h("div", { class: "strong" }, p.name), h("div", { class: "muted small" }, srcLabel(p.source))), h("td", { class: "hide-sm" }, h("span", { class: "tag" }, p.phase)),
            h("td", { class: "num" }, p.steps), h("td", { class: "num hide-sm" }, fmtSecs(p.durationMs)), h("td", { class: "num" }, p.weight),
            h("td", {}, p.enabled ? h("span", { class: "status s-succeeded" }, h("span", { class: "dot" }), "On") : h("span", { class: "status" }, h("span", { class: "dot" }), "Off")));
        }))),),
      h("div", { class: "pager" }, h("span", { class: "muted" }, `${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(data.total)}`),
        h("div", {}, h("button", { class: "btn btn-secondary btn-sm", disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - PAGE); reload(); } }, "Prev"), " ",
          h("button", { class: "btn btn-secondary btn-sm", disabled: to >= data.total, onclick: () => { offset += PAGE; reload(); } }, "Next"))));
  }

  async function reload() {
    const params = new URLSearchParams({ limit: PAGE, offset });
    if (phase) params.set("phase", phase);
    if (q) params.set("q", q);
    [data, stats] = await Promise.all([api(`/api/profiles?${params}`), api(`/api/profiles/stats${phase ? `?phase=${phase}` : ""}`)]);
    drawChips(); drawMix(); drawTable(); drawBulk();
  }

  async function publish() {
    const p = phase || "during";
    try {
      const r = await api("/api/profiles/publish", { method: "POST", body: JSON.stringify({ phase: p }) });
      toast(`Published ${r.profiles} profile${r.profiles === 1 ? "" : "s"} (${r.steps} steps) to ${r.file}`);
    } catch (e) { toast(e.message); }
  }

  await reload();
}

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ====================== generate dialog ======================
async function openGenerate(done) {
  let files = await api("/api/imports");
  const err = h("p", { class: "error-text", role: "alert" });
  const fileSel = h("select", { class: "select", name: "file" });
  const info = h("div", { class: "file-info muted" });
  const phaseSel = h("select", { class: "select", name: "phase" }, [...PHASES, "unknown"].map((p) => h("option", { value: p }, p)));
  const num = (name, label, value, hint) => h("label", { class: "field" }, h("span", {}, label), h("input", { class: "input", name, type: "number", min: 0, step: "any", value }), hint ? h("small", {}, hint) : null);
  const check = (name, label, on, hint) => { const i = h("input", { type: "checkbox", name }); i.checked = on; return h("label", { class: "check-row" }, i, h("span", {}, label, hint ? h("small", {}, hint) : null)); };
  const go = h("button", { class: "btn btn-primary", type: "submit" }, "Generate");
  const upload = h("input", { type: "file", accept: ".db,.sqlite,.sqlite3", hidden: true });
  const uploadBtn = h("button", { class: "btn btn-outline btn-sm", type: "button", onclick: () => upload.click() }, "Upload a file");
  const delBtn = h("button", { class: "btn btn-danger btn-sm", type: "button", onclick: removeFile }, "Delete file");
  const howTo = h("div", { class: "howto" },
    h("p", {}, "D1 exports as SQL. Convert it to a SQLite file, then upload it here:"),
    h("pre", { class: "snippet" }, "wrangler d1 export <database> --remote --output=d1.sql\nsqlite3 d1.db < d1.sql"));

  const form = h("form", { method: "dialog", class: "gen" },
    h("h2", {}, "Generate profiles"),
    h("p", { class: "lead" }, "Each recorded session becomes one simulated user. Who they were isn't kept, only what they did and how long they waited."),
    h("div", { class: "field" }, h("span", {}, "D1 export"), fileSel, h("div", { class: "row-gap" }, uploadBtn, delBtn, upload), info),
    howTo,
    h("label", { class: "field" }, h("span", {}, "Phase"), phaseSel),
    h("div", { class: "field-row" }, num("limit", "Max profiles", 200, "Random sample if more."), num("sessionGapMin", "Session gap (min)", 30, "Silence that ends a session.")),
    check("onlyOk", "Only successful calls", true, "Skip calls that errored."),
    check("includeMutations", "Include writes", false, "Mutations only replay when a run allows them."),
    check("replace", "Replace earlier D1 profiles for this phase", false, "Your edits to those are lost. Hand-made profiles stay."),
    h("details", { class: "adv" }, h("summary", {}, "Advanced"),
      h("div", { class: "field-row" }, num("minSteps", "Min steps", 2), num("maxSteps", "Max steps", 100)),
      num("maxGapSec", "Longest single wait (s)", 120, "Longer waits are shortened so a replay stays short.")),
    err,
    h("div", { class: "dialog-actions" }, h("button", { class: "btn btn-secondary", type: "button", onclick: () => dlg.close() }, "Cancel"), go));
  const dlg = h("dialog", {}, form);
  document.body.append(dlg);
  dlg.addEventListener("close", () => dlg.remove());

  function drawFiles(select) {
    fileSel.replaceChildren(...(files.length ? files.map((f) => h("option", { value: f.name }, `${f.name} · ${(f.size / 1048576).toFixed(1)} MB`)) : [h("option", { value: "" }, "No files yet")]));
    if (select) fileSel.value = select;
    howTo.hidden = files.length > 0;
    go.disabled = !files.length; delBtn.hidden = !files.length;
    showInfo();
  }
  async function showInfo() {
    info.textContent = "";
    if (!fileSel.value) return;
    try {
      const s = await api(`/api/imports/${encodeURIComponent(fileSel.value)}/summary`);
      info.textContent = s.phases.map((p) => `${p.phase}: ${fmtInt(p.events)} events, ${fmtInt(p.users)} users`).join("  ·  ");
      if (s.phases[0]) phaseSel.value = s.phases[0].phase;
    } catch (e) { info.textContent = e.message; }
  }
  async function removeFile() {
    if (!confirm(`Delete ${fileSel.value} from the server? Profiles already generated from it are kept.`)) return;
    try { await api(`/api/imports/${encodeURIComponent(fileSel.value)}`, { method: "DELETE" }); files = await api("/api/imports"); drawFiles(); } catch (e) { err.textContent = e.message; }
  }
  fileSel.addEventListener("change", showInfo);
  upload.addEventListener("change", async () => {
    const f = upload.files[0]; if (!f) return;
    err.textContent = ""; uploadBtn.disabled = true; uploadBtn.textContent = "Uploading…";
    try {
      const res = await fetch("/api/imports", { method: "POST", headers: { "x-requested-with": "runs-ui", "x-filename": f.name, "content-type": "application/octet-stream" }, body: f });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || res.statusText);
      files = await api("/api/imports"); drawFiles(out.name);
    } catch (e) { err.textContent = e.message; }
    finally { uploadBtn.disabled = false; uploadBtn.textContent = "Upload a file"; upload.value = ""; }
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.textContent = ""; go.disabled = true; go.textContent = "Generating…";
    const f = form.elements;
    try {
      const r = await api("/api/profiles/generate", { method: "POST", body: JSON.stringify({
        file: f.file.value, phase: f.phase.value, limit: Number(f.limit.value), sessionGapMin: Number(f.sessionGapMin.value),
        minSteps: Number(f.minSteps.value), maxSteps: Number(f.maxSteps.value), maxGapSec: Number(f.maxGapSec.value),
        onlyOk: f.onlyOk.checked, includeMutations: f.includeMutations.checked, replace: f.replace.checked }) });
      dlg.close();
      toast(r.created ? `Created ${r.created} profile${r.created === 1 ? "" : "s"} from ${fmtInt(r.sessions)} sessions${r.truncatedInput ? " (input was cut off at 3M rows)" : ""}` : "No sessions matched those settings");
      done();
    } catch (e2) { err.textContent = e2.message; go.disabled = false; go.textContent = "Generate"; }
  });
  drawFiles();
  dlg.showModal();
}

// ====================== editor ======================
export async function profileView(view, id) {
  let saved = await api(`/api/profiles/${id}`);
  const stats = await api("/api/profiles/stats");
  let draft = clone(saved);
  const write = canWrite();

  const head = h("div", { class: "page-head" });
  const settings = h("div", { class: "card card-pad" });
  const stepsCard = h("div", { class: "card card-pad" });
  const saveBar = h("div", { class: "savebar", hidden: true });
  const err = h("p", { class: "error-text", role: "alert" });
  view.append(h("a", { class: "crumb", href: "#/profiles" }, icon("back"), "All profiles"), head, settings, stepsCard, err, saveBar,
    h("datalist", { id: "procs" }, stats.procedures.map((p) => h("option", { value: p }))));

  const dirty = () => JSON.stringify(strip(draft)) !== JSON.stringify(strip(saved));
  function touch() { saveBar.hidden = !write || !dirty(); drawSummary(); }

  function drawHead() {
    head.replaceChildren(
      h("div", {}, h("h1", {}, saved.name), h("p", { class: "muted" }, `${srcLabel(saved.source)} · updated ${fmtTime(saved.updatedAt)}`)),
      write ? h("div", { class: "actions" },
        h("button", { class: "btn btn-outline", onclick: async () => { try { const d = await api(`/api/profiles/${id}/duplicate`, { method: "POST" }); location.hash = `#/profiles/${d.id}`; } catch (e) { toast(e.message); } } }, "Duplicate"),
        h("button", { class: "btn btn-danger", onclick: async () => { if (!confirm(`Delete "${saved.name}"?`)) return; try { await api(`/api/profiles/${id}`, { method: "DELETE" }); location.hash = "#/profiles"; } catch (e) { toast(e.message); } } }, "Delete")) : null);
  }

  function drawSettings() {
    const ro = !write;
    const name = h("input", { class: "input", value: draft.name, maxlength: 80, disabled: ro, "aria-label": "Name", oninput: (e) => { draft.name = e.target.value; touch(); } });
    const phase = h("select", { class: "select", disabled: ro, onchange: (e) => { draft.phase = e.target.value; touch(); } }, [...PHASES, "unknown"].map((p) => h("option", { value: p, selected: p === draft.phase }, p)));
    const weight = h("input", { class: "input", type: "number", min: 0, step: "any", value: draft.weight, disabled: ro, oninput: (e) => { draft.weight = e.target.value === "" ? NaN : Number(e.target.value); touch(); } });
    const on = h("input", { type: "checkbox", role: "switch", disabled: ro, onchange: (e) => { draft.enabled = e.target.checked; touch(); } }); on.checked = draft.enabled;
    settings.replaceChildren(h("div", { class: "settings-grid" },
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("label", { class: "field" }, h("span", {}, "Phase"), phase),
      h("label", { class: "field" }, h("span", {}, "Weight"), weight, h("small", {}, "Higher means picked more often.")),
      h("label", { class: "field" }, h("span", {}, "Included in runs"), h("span", { class: "switch-row" }, on, h("span", {}, "Enabled")))));
  }

  const summary = h("p", { class: "muted" });
  const timeline = h("div", { class: "timeline", "aria-hidden": "true" });
  const rows = h("div", { class: "steps" });
  function drawSummary() {
    const total = draft.steps.reduce((a, s) => a + s.gapMs, 0);
    summary.textContent = `${draft.steps.length} step${draft.steps.length === 1 ? "" : "s"} · ${fmtSecs(total)} end to end`;
    timeline.replaceChildren(h("div", { class: "timeline-line" }), ...draft.steps.map((s, i) => {
      const at = draft.steps.slice(0, i + 1).reduce((a, x) => a + x.gapMs, 0);
      return h("span", { class: `tick ${s.type}`, title: `${i + 1}. ${s.procedure}`, style: { left: `${total ? (at / total) * 100 : (i / Math.max(draft.steps.length - 1, 1)) * 100}%` } });
    }));
  }
  function drawSteps() {
    const ro = !write;
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= draft.steps.length) return; [draft.steps[i], draft.steps[j]] = [draft.steps[j], draft.steps[i]]; draft.steps[0].gapMs = 0; drawSteps(); touch(); };
    rows.replaceChildren(...draft.steps.map((s, i) => h("div", { class: "step" },
      h("span", { class: "step-n" }, i + 1),
      h("input", { class: "input", list: "procs", value: s.procedure, disabled: ro, "aria-label": `Step ${i + 1} procedure`, placeholder: "application.get", oninput: (e) => { s.procedure = e.target.value.trim(); touch(); } }),
      h("select", { class: "select", disabled: ro, "aria-label": `Step ${i + 1} type`, onchange: (e) => { s.type = e.target.value; touch(); } },
        ["query", "mutation"].map((t) => h("option", { value: t, selected: t === s.type }, t))),
      h("label", { class: "wait" }, i === 0 ? h("span", { class: "muted" }, "starts the session") :
        [h("input", { class: "input", type: "number", min: 0, step: "0.5", value: Number((s.gapMs / 1000).toFixed(1)), disabled: ro, "aria-label": `Wait before step ${i + 1}, in seconds`, oninput: (e) => { s.gapMs = Math.round(Number(e.target.value || 0) * 1000); touch(); } }), h("span", { class: "muted" }, "s wait")]),
      write ? h("span", { class: "step-actions" },
        h("button", { class: "icon-btn", "aria-label": `Move step ${i + 1} up`, disabled: i === 0, onclick: () => move(i, -1) }, "↑"),
        h("button", { class: "icon-btn", "aria-label": `Move step ${i + 1} down`, disabled: i === draft.steps.length - 1, onclick: () => move(i, 1) }, "↓"),
        h("button", { class: "icon-btn", "aria-label": `Remove step ${i + 1}`, onclick: () => { draft.steps.splice(i, 1); if (draft.steps[0]) draft.steps[0].gapMs = 0; drawSteps(); touch(); } }, "✕")) : null)));
    if (!draft.steps.length) rows.replaceChildren(empty("No steps", write ? "Add the first call below." : ""));
  }
  stepsCard.append(h("div", { class: "row-between" }, h("div", { class: "section-label" }, "Steps"), summary), timeline, rows,
    write ? h("button", { class: "btn btn-outline btn-sm", onclick: () => { draft.steps.push({ procedure: "", type: "query", gapMs: draft.steps.length ? 5000 : 0 }); drawSteps(); touch(); } }, icon("plus"), "Add step") : null);

  const saveBtn = h("button", { class: "btn btn-primary", onclick: save }, "Save changes");
  saveBar.append(h("span", {}, "You have unsaved changes."),
    h("div", {}, h("button", { class: "btn btn-secondary", onclick: () => { draft = clone(saved); drawSettings(); drawSteps(); touch(); err.textContent = ""; } }, "Discard"), " ", saveBtn));

  async function save() {
    err.textContent = ""; saveBtn.disabled = true;
    try {
      if (!Number.isFinite(draft.weight)) throw new Error("Weight must be a number.");
      saved = await api(`/api/profiles/${id}`, { method: "PATCH", body: JSON.stringify({ name: draft.name, phase: draft.phase, weight: draft.weight, enabled: draft.enabled, steps: draft.steps }) });
      draft = clone(saved); drawHead(); drawSettings(); drawSteps(); touch(); toast("Saved");
    } catch (e) { err.textContent = e.message; }
    finally { saveBtn.disabled = false; }
  }

  const warn = (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", warn);
  drawHead(); drawSettings(); drawSteps(); touch();
  return {
    dispose: () => window.removeEventListener("beforeunload", warn),
    guard: () => !dirty() || confirm("Discard unsaved changes?"),
  };
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const strip = (p) => ({ name: p.name, phase: p.phase, weight: p.weight, enabled: p.enabled, steps: p.steps });
