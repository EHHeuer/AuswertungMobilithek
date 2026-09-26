import {
  h, cssVar, lineChart, stackedArea, stackedColumns, hBars, heatmap, ridgeline, lorenz,
  spreadStrips, tileMap, sparkline, tipRows, seqColor, STATE_TILES,
} from "./charts.js";
import { fmt, fmtCompact, fmtEnergy, fmtHours, fmtPeriod, parseDate } from "./format.js";

const MIN_N = 30; // Zeiträume mit weniger Ladevorgängen je Klasse werden nicht gezeichnet
const DOW = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

const state = {
  grain: "quarter",
  stat: "med",
  scope: "all|Alle",
  classes: new Set([1, 2, 3, 4, 5]),
  tools: {},
};

let D = null;
const IDX = {}; // grain -> Map("dim|val" -> rows[])
let RANGE = null;
const cards = new Map();

// ------------------------------------------------------------------ Start

init().catch((err) => {
  console.error(err);
  document.querySelector("main").prepend(
    h("div", { class: "wrap" }, h("div", { class: "card", style: { marginTop: "32px" } }, [
      h("p", { class: "card__title", text: "Daten konnten nicht geladen werden" }),
      h("p", { class: "card__sub", html: "Erwartet wird <code>web/data/obelis.json</code>. Seite über einen lokalen Server öffnen, z. B. <code>python -m http.server -d web</code>." }),
    ])),
  );
});

async function init() {
  restoreTheme();
  const res = await fetch("data/obelis.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  D = await res.json();
  prepare();
  setupControls();
  defineCards();
  renderStatic();
  renderAll();
  let lastW = window.innerWidth;
  let timer;
  window.addEventListener("resize", () => {
    if (Math.abs(window.innerWidth - lastW) < 8) return;
    lastW = window.innerWidth;
    clearTimeout(timer);
    timer = setTimeout(renderAll, 160);
  });
}

function prepare() {
  const cols = D.series.cols;
  for (const grain of ["month", "quarter", "year"]) {
    const map = new Map();
    for (const r of D.series[grain]) {
      const o = {};
      cols.forEach((c, i) => (o[c] = r[i]));
      o.date = parseDate(o.p);
      o.t = +o.date;
      const key = `${o.dim}|${o.val}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(o);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.t - b.t);
    IDX[grain] = map;
  }
  const start = parseDate(D.meta.range[0]);
  const last = parseDate(D.meta.range[1]);
  RANGE = { start, endExcl: new Date(last.getFullYear(), last.getMonth() + 1, 1) };
  const years = [...new Set(D.series.year.map((r) => +r[0].slice(0, 4)))].sort();
  const fullYears = years.filter((y) => new Date(y, 0, 1) >= start && new Date(y + 1, 0, 1) <= RANGE.endExcl);
  RANGE.years = years;
  RANGE.lastFull = fullYears[fullYears.length - 1] ?? years[years.length - 1];
  RANGE.firstFull = fullYears[0] ?? years[0];
}

// ------------------------------------------------------------------ Datenzugriff

const classById = (id) => D.classes.find((c) => c.id === id);
const classColor = (id) => cssVar(`--c${id}`);
const visibleClasses = () => D.classes.filter((c) => state.classes.has(c.id));

function scopeRows(grain = state.grain, scope = state.scope) {
  return IDX[grain].get(scope) || [];
}

function periodDays(t, grain) {
  const d = new Date(t);
  const end = grain === "year" ? new Date(d.getFullYear() + 1, 0, 1)
    : grain === "quarter" ? new Date(d.getFullYear(), d.getMonth() + 3, 1)
      : new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const a = Math.max(+d, +RANGE.start), b = Math.min(+end, +RANGE.endExcl);
  return Math.max(1, (b - a) / 864e5);
}

/** Zeitreihe je sichtbarer Klasse; fn(row) -> {y, lo, hi} oder Zahl */
function classSeries(fn, { grain = state.grain, scope = state.scope, withTotal = false, minN = MIN_N } = {}) {
  const rows = scopeRows(grain, scope);
  const periods = [...new Set(rows.map((r) => r.t))].sort((a, b) => a - b);
  const ids = visibleClasses().map((c) => c.id);
  if (withTotal) ids.push(0);
  return ids.map((id) => {
    const byT = new Map(rows.filter((r) => r.cls === id).map((r) => [r.t, r]));
    return {
      id,
      label: id ? classById(id).label : "Alle Klassen",
      color: classColor(id),
      values: periods.map((t) => {
        const r = byT.get(t);
        if (!r || r.n < minN) return { x: new Date(t), y: null };
        const v = fn(r, t);
        return typeof v === "object" && v !== null ? { x: new Date(t), ...v, row: r } : { x: new Date(t), y: v, row: r };
      }),
    };
  });
}

function shadeRanges(grain = state.grain) {
  const months = D.meta.incomplete || [];
  return months.map((m) => {
    const d = parseDate(m);
    let from = d, to = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    if (grain === "quarter") { from = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); to = new Date(from.getFullYear(), from.getMonth() + 3, 1); }
    if (grain === "year") { from = new Date(d.getFullYear(), 0, 1); to = new Date(d.getFullYear() + 1, 0, 1); }
    return { from, to, label: "unvollständig" };
  });
}

function seriesTable(series, fmtV, grain = state.grain) {
  const xs = [...new Set(series.flatMap((s) => s.values.map((v) => +v.x)))].sort((a, b) => a - b);
  return {
    head: ["Zeitraum", ...series.map((s) => s.label)],
    rows: xs.map((t) => [fmtPeriod(new Date(t), grain), ...series.map((s) => {
      const v = s.values.find((p) => +p.x === t);
      return v && v.y != null ? fmtV(v.y) : "–";
    })]),
  };
}

const statLabel = () => (state.stat === "med" ? "Median" : "Mittelwert");
const scopeLabel = () => {
  const [dim, val] = state.scope.split("|");
  return dim === "all" ? "Deutschland" : dim === "bl" ? val : `Lage: ${val}`;
};
const nationalOnly = () => (state.scope !== "all|Alle" ? "Bundesweit, unabhängig vom gewählten Ausschnitt." : "");

// ------------------------------------------------------------------ Steuerung

function setupControls() {
  // Ausschnitt
  const sel = document.getElementById("scope");
  sel.append(h("option", { value: "all|Alle", text: "Deutschland gesamt" }));
  const g1 = h("optgroup", { label: "Bundesland" });
  for (const b of D.meta.bundeslaender) g1.append(h("option", { value: `bl|${b}`, text: b }));
  const g2 = h("optgroup", { label: "Lage der Station" });
  for (const l of D.meta.lagen) g2.append(h("option", { value: `lage|${l}`, text: l }));
  sel.append(g1, g2);
  sel.addEventListener("change", () => { state.scope = sel.value; renderAll(); });

  for (const seg of document.querySelectorAll(".seg[data-control]")) {
    const key = seg.dataset.control;
    for (const b of seg.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.value === state[key]));
      b.addEventListener("click", () => {
        state[key] = b.dataset.value;
        seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        renderAll();
      });
    }
  }

  const chips = document.getElementById("class-chips");
  for (const c of D.classes) {
    const chip = h("button", { class: "chip", type: "button", "aria-pressed": "true", style: { "--c": `var(--c${c.id})` }, title: c.label }, [
      h("span", { class: "chip__dot" }), c.short,
    ]);
    chip.addEventListener("click", () => {
      if (state.classes.has(c.id)) {
        if (state.classes.size === 1) return;
        state.classes.delete(c.id);
      } else state.classes.add(c.id);
      chip.setAttribute("aria-pressed", String(state.classes.has(c.id)));
      renderAll();
    });
    chips.append(chip);
  }

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("ladebilanz-theme", root.dataset.theme); } catch { /* optional */ }
    renderAll();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderAll());
}

function restoreTheme() {
  try {
    const t = localStorage.getItem("ladebilanz-theme");
    if (t) document.documentElement.dataset.theme = t;
  } catch { /* optional */ }
}

// ------------------------------------------------------------------ Karten-Rahmen

function tool(key, def) {
  if (!(key in state.tools)) state.tools[key] = def;
  return state.tools[key];
}

function card(name, spec) {
  cards.set(name, spec);
}

function renderCard(name) {
  const root = document.querySelector(`[data-chart="${name}"]`);
  const spec = cards.get(name);
  if (!root || !spec) return;
  if (spec.available && !spec.available()) {
    root.hidden = true;
    return;
  }
  root.hidden = false;
  root.innerHTML = "";
  const tools = h("div", { class: "card__tools" });
  for (const t of spec.tools ? spec.tools() : []) tools.append(renderTool(t, name));
  const tableBtn = h("button", { class: "tool-btn", type: "button", "aria-pressed": String(!!state.tools[`${name}:table`]), text: "Tabelle" });
  tableBtn.addEventListener("click", () => { state.tools[`${name}:table`] = !state.tools[`${name}:table`]; renderCard(name); });
  tools.append(tableBtn);
  const head = h("div", { class: "card__head" }, [
    h("div", {}, [h("h3", { class: "card__title", text: spec.title() }), spec.sub ? h("p", { class: "card__sub", text: spec.sub() }) : null]),
    tools,
  ]);
  const body = h("div", { class: "card__body chart" });
  root.append(head, body);
  const table = spec.render(body);
  const foot = spec.foot ? spec.foot() : "";
  if (foot) root.append(h("p", { class: "card__foot", text: foot }));
  if (state.tools[`${name}:table`] && table) root.append(renderTable(table));
}

function renderTool(t, cardName) {
  const val = tool(t.key, t.default);
  if (t.type === "seg") {
    const wrap = h("div", { class: "mini-seg", role: "group", "aria-label": t.label || "" });
    for (const [v, label] of t.options) {
      const b = h("button", { type: "button", "aria-pressed": String(v === val), text: label });
      b.addEventListener("click", () => { state.tools[t.key] = v; t.global ? renderAll() : renderCard(cardName); });
      wrap.append(b);
    }
    return wrap;
  }
  if (t.type === "select") {
    const s = h("select", { class: "mini-select", "aria-label": t.label || "" });
    for (const [v, label] of t.options) s.append(h("option", { value: v, text: label, selected: String(v) === String(val) }));
    s.addEventListener("change", () => {
      state.tools[t.key] = t.numeric ? +s.value : s.value;
      t.global ? renderAll() : renderCard(cardName);
    });
    return s;
  }
  if (t.type === "toggle") {
    const b = h("button", { class: "tool-btn", type: "button", "aria-pressed": String(!!val), text: t.label });
    b.addEventListener("click", () => { state.tools[t.key] = !state.tools[t.key]; renderCard(cardName); });
    return b;
  }
  return "";
}

function renderTable({ head, rows }) {
  return h("div", { class: "table-wrap" }, h("table", { class: "data-table" }, [
    h("thead", {}, h("tr", {}, head.map((c) => h("th", { text: c })))),
    h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => h("td", { text: c }))))),
  ]));
}

function renderAll() {
  for (const name of cards.keys()) renderCard(name);
  renderKpis();
  renderHeroRidge();
}

// ------------------------------------------------------------------ Kopfbereich

function renderStatic() {
  const m = D.meta;
  if (m.demo) document.getElementById("demo-banner").hidden = false;
  const fmtD = (s) => { const d = parseDate(s); return fmtPeriod(d, "month"); };
  document.getElementById("hero-lede").textContent =
    `Grundlage sind ${fmtCompact(m.quality.rows_kept)} plausible Ladevorgänge an ${fmt(m.lps_total, 0)} Ladepunkten ` +
    `von ${fmtD(m.range[0])} bis ${fmtD(m.range[1])}. Die Betreiber geförderter Ladeinfrastruktur melden sie halbjährlich ` +
    `an die Nationale Leitstelle Ladeinfrastruktur.`;
  document.getElementById("footer-source").innerHTML =
    `Datenquelle: ${m.source}. <a href="${m.source_url}" target="_blank" rel="noopener">Mobilithek</a>. ` +
    `Eigene Aufbereitung und Plausibilisierung, Ergebnisse ohne Gewähr.`;
  document.getElementById("footer-meta").textContent =
    `Stand der Aufbereitung: ${new Date(m.generated).toLocaleDateString("de-DE")}${m.demo ? " · Demodaten" : ""}`;

  const q = m.quality;
  document.getElementById("note-energie").textContent =
    `Zeiträume mit weniger als ${MIN_N} Ladevorgängen je Klasse bleiben leer. Klassen nach Nennleistung des Ladepunkts, nicht nach Fahrzeug.`;
  const inc = m.incomplete?.length ? ` Grau hinterlegt: Monate mit auffällig wenigen Meldungen (${m.incomplete.map(fmtD).join(", ")}).` : "";
  document.getElementById("note-lps").textContent = `Insgesamt ${fmt(m.lps_total, 0)} Ladepunkte an ${fmt(m.lss_total, 0)} Stationen.${inc}`;

  const ls = D.master?.ls, lp = D.master?.lp;
  const parts = [];
  if (ls) parts.push(`${fmt(ls.rows, 0)} Ladestationen in ${ls.file}`);
  if (lp) parts.push(`${fmt(lp.rows, 0)} Ladepunkte in ${lp.file}`);
  document.getElementById("note-master").textContent = parts.length
    ? `Enthalten: ${parts.join(", ")}. Spalten wurden automatisch erkannt, siehe Methodik.`
    : "Keine Stammdaten eingebunden.";
  if (!ls && !lp) document.getElementById("stammdaten").hidden = true;

  renderMethod(q);
}

function renderKpis() {
  const box = document.getElementById("kpis");
  box.innerHTML = "";
  const rows = scopeRows("year").filter((r) => r.cls === 0);
  if (!rows.length) return;
  const byYear = new Map(rows.map((r) => [r.date.getFullYear(), r]));
  const last = byYear.get(RANGE.lastFull) || rows[rows.length - 1];
  const prev = byYear.get(RANGE.lastFull - 1);
  const first = byYear.get(RANGE.firstFull) || rows[0];
  const sumN = rows.reduce((a, r) => a + r.n, 0);
  const sumE = rows.reduce((a, r) => a + r.e_sum, 0);
  const e = fmtEnergy(sumE);
  const pct = (a, b) => (a != null && b ? ((a - b) / b) * 100 : null);
  const kpiW = Math.max(120, box.clientWidth / (window.innerWidth < 900 ? 2 : 4) - 24);

  const tiles = [
    {
      label: `Ladevorgänge · ${scopeLabel()}`,
      value: fmtCompact(sumN), unit: "",
      delta: pct(last.n, prev?.n), deltaText: `${RANGE.lastFull} ggü. Vorjahr`,
      spark: rows.map((r) => r.n / periodDays(r.t, "year")),
    },
    {
      label: "Geladene Energie",
      value: e.v, unit: e.u,
      delta: pct(last.e_sum, prev?.e_sum), deltaText: `${RANGE.lastFull} ggü. Vorjahr`,
      spark: rows.map((r) => r.e_sum / periodDays(r.t, "year")),
    },
    {
      label: `Meldende Ladepunkte ${RANGE.lastFull}`,
      value: fmt(last.lps, 0), unit: "",
      delta: pct(last.lps, prev?.lps), deltaText: "ggü. Vorjahr",
      spark: rows.map((r) => r.lps),
    },
    {
      label: `Median Energie je Vorgang ${RANGE.lastFull}`,
      value: fmt(last.e_med, 1), unit: "kWh",
      delta: last.e_med - first.e_med, abs: true, deltaText: `kWh ggü. ${RANGE.firstFull}`,
      spark: rows.map((r) => r.e_med),
    },
  ];
  for (const t of tiles) {
    let delta = null;
    if (t.delta != null && isFinite(t.delta)) {
      const up = t.delta >= 0;
      const txt = t.abs ? `${up ? "+" : "−"}${fmt(Math.abs(t.delta), 1)}` : `${up ? "+" : "−"}${fmt(Math.abs(t.delta), 0)} %`;
      delta = h("p", { class: "kpi__delta" }, [h("b", { class: up ? "up" : "down", text: `${up ? "▲" : "▼"} ${txt}` }), t.deltaText]);
    }
    box.append(h("div", { class: "kpi" }, [
      h("p", { class: "kpi__label", text: t.label }),
      h("p", { class: "kpi__value" }, [t.value, t.unit ? h("span", { class: "kpi__unit", text: t.unit }) : null]),
      delta,
      sparkline(t.spark, cssVar("--accent"), kpiW),
    ]));
  }
}

function binMedian(bins, edges, log = false) {
  const total = bins.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < bins.length; i++) {
    if (acc + bins[i] >= total / 2) {
      const frac = bins[i] ? (total / 2 - acc) / bins[i] : 0;
      const lo = edges[i], hi = edges[i + 1] ?? (log ? edges[i] * (edges[1] / edges[0]) : edges[i] + (edges[1] - edges[0]));
      return log ? lo * Math.pow(hi / lo, frac) : lo + (hi - lo) * frac;
    }
    acc += bins[i];
  }
  return null;
}

function renderHeroRidge() {
  const svgHost = document.getElementById("hero-ridge");
  const fig = svgHost.parentElement;
  const hist = D.hist.kwh;
  const years = Object.keys(hist.data).sort();
  const groups = years.map((y) => ({ label: y, bins: hist.data[y]["0"], highlight: +y === RANGE.lastFull }))
    .filter((g) => g.bins && g.bins.reduce((a, b) => a + b, 0) > 50);
  groups.forEach((g) => (g.marker = binMedian(g.bins, hist.edges)));
  const holder = h("div", { class: "chart" });
  holder.style.width = "100%";
  fig.replaceChild(holder, fig.firstElementChild);
  holder.id = "hero-ridge";
  const rowH = Math.max(22, Math.min(34, 240 / Math.max(groups.length, 1)));
  ridgeline(holder, groups, hist.edges, {
    rowH, overlap: 2.4, xMax: 80, unit: "kWh", fill: cssVar("--page"),
    onHover: (g) => tipRows(g.label, [
      { label: "Median", value: `${fmt(g.marker, 1)} kWh` },
      { label: "Ladevorgänge", value: fmtCompact(g.bins.reduce((a, b) => a + b, 0)) },
    ]),
  });
  document.getElementById("hero-ridge-cap").textContent =
    "Verteilung der Energie je Ladevorgang, ein Kamm je Jahr, Strich = Median";
}

// ------------------------------------------------------------------ Karten-Definitionen

function defineCards() {
  const kwh = (v, long) => (long ? `${fmt(v)} kWh` : fmt(v));
  const kw = (v, long) => (long ? `${fmt(v)} kW` : fmt(v));
  const pct = (v, long) => `${fmt(v, long ? 1 : 0)} %`;
  const hrs = (v, long) => (long ? fmtHours(v, true) : fmt(v));
  const single = () => state.classes.size === 1;
  const metricFn = (base) => (r) => state.stat === "med"
    ? { y: r[`${base}_med`], lo: r[`${base}_p25`], hi: r[`${base}_p75`] }
    : { y: r[`${base}_mean`], lo: r[`${base}_p25`], hi: r[`${base}_p75`] };

  // 01 Energie
  card("energy", {
    title: () => `${statLabel()} der Energie je Ladevorgang`,
    sub: () => `kWh · ${scopeLabel()}`,
    tools: () => [{ type: "toggle", key: "energyTotal", label: "Alle Klassen", default: false }],
    render: (body) => {
      const s = classSeries(metricFn("e"), { withTotal: tool("energyTotal", false) });
      lineChart(body, s, { yFormat: kwh, grain: state.grain, band: single(), shade: shadeRanges(),
        tooltipFoot: () => (single() ? "Band: 25. bis 75. Perzentil" : "") });
      return seriesTable(s, (v) => fmt(v, 1));
    },
    foot: () => (tool("energyTotal", false) ? "Die Linie »Alle Klassen« steigt auch durch den wachsenden Anteil schneller Ladepunkte (Mix-Effekt)." : ""),
  });

  // 02 Dauer
  card("duration", {
    title: () => `${statLabel()} der Ladedauer`,
    sub: () => `Stunden · ${scopeLabel()}`,
    tools: () => [{ type: "seg", key: "durScale", default: "all", options: [["all", "Alle"], ["dc", "Nur DC"]] }],
    render: (body) => {
      let s = classSeries(metricFn("h"));
      if (tool("durScale", "all") === "dc") s = s.filter((x) => x.id >= 3);
      lineChart(body, s, { yFormat: hrs, grain: state.grain, band: single() || s.length === 1, shade: shadeRanges() });
      return seriesTable(s, (v) => fmtHours(v, true));
    },
    foot: () => "»Nur DC« blendet die AC-Klassen aus, damit die kurzen Schnellladevorgänge lesbar werden.",
  });

  // 03 Leistung
  card("power", {
    title: () => `${statLabel()} der mittleren Ladeleistung`,
    sub: () => `kW = Energie / Dauer je Vorgang · ${scopeLabel()}`,
    render: (body) => {
      const s = classSeries(metricFn("kw"));
      lineChart(body, s, { yFormat: kw, grain: state.grain, band: single(), shade: shadeRanges(), height: 280 });
      return seriesTable(s, (v) => fmt(v, 1));
    },
  });
  card("util", {
    title: () => "Ausnutzung der Nennleistung",
    sub: () => `Median, mittlere Leistung / Nennleistung · ${scopeLabel()}`,
    render: (body) => {
      const s = classSeries((r) => (r.util_med != null ? r.util_med * 100 : null));
      lineChart(body, s, { yFormat: pct, grain: state.grain, shade: shadeRanges(), height: 280 });
      return seriesTable(s, (v) => `${fmt(v, 1)} %`);
    },
  });

  // 04 Ladepunkte
  card("lps", {
    title: () => "Ladepunkte mit Ladevorgängen",
    sub: () => `Anzahl je ${state.grain === "month" ? "Monat" : state.grain === "quarter" ? "Quartal" : "Jahr"} · ${scopeLabel()}`,
    render: (body) => {
      const s = classSeries((r) => r.lps, { minN: 1 }).map((x) => ({ ...x, values: x.values.map((v) => ({ ...v, y: v.y ?? 0 })) }));
      stackedArea(body, s, { grain: state.grain, shade: shadeRanges(), valueFormat: (v) => fmt(v, 0), totalLabel: "Summe", height: 300 });
      return seriesTable(s, (v) => fmt(v, 0));
    },
  });
  card("newlps", {
    title: () => "Neu meldende Ladepunkte",
    sub: () => "Erster Monat mit Ladevorgang",
    render: (body) => {
      const s = newLpSeries();
      stackedColumns(body, s, { grain: state.grain, yFormat: (v) => fmt(v, 0), height: 220 });
      return seriesTable(s, (v) => fmt(v, 0));
    },
    foot: () => nationalOnly() || "Der erste Zeitraum enthält alle Punkte, die schon vor Beginn der Daten liefen.",
  });
  card("quote", {
    available: () => !!D.master?.lp?.commissioning,
    title: () => "Meldequote",
    sub: () => "Meldende / bis dahin in Betrieb genommene Ladepunkte",
    render: (body) => {
      const s = quoteSeries();
      lineChart(body, s, { yFormat: pct, grain: state.grain, height: 220, endLabels: false });
      return seriesTable(s, (v) => `${fmt(v, 1)} %`);
    },
    foot: () => "Verhältnis zweier getrennter Tabellen (Ladevorgänge vs. Ladepunkt-Stammdaten), daher nur als Größenordnung lesbar. Bundesweit.",
  });

  // 05 Auslastung
  card("sessPerLp", {
    title: () => "Ladevorgänge je Ladepunkt und Tag",
    sub: () => `Mittel über meldende Ladepunkte · ${scopeLabel()}`,
    render: (body) => {
      const s = classSeries((r, t) => r.n / r.lps / periodDays(t, state.grain));
      lineChart(body, s, { yFormat: (v, l) => fmt(v, l ? 2 : 1), grain: state.grain, shade: shadeRanges(), height: 260 });
      return seriesTable(s, (v) => fmt(v, 2));
    },
    foot: () => (state.grain === "year" ? "Im Jahresraster zählt jeder meldende Ladepunkt für das ganze Jahr, Monatsraster ist genauer." : ""),
  });
  card("kwhPerLp", {
    title: () => "Energie je Ladepunkt und Tag",
    sub: () => `kWh · ${scopeLabel()}`,
    render: (body) => {
      const s = classSeries((r, t) => r.e_sum / r.lps / periodDays(t, state.grain));
      lineChart(body, s, { yFormat: kwh, grain: state.grain, shade: shadeRanges(), height: 260 });
      return seriesTable(s, (v) => fmt(v, 1));
    },
  });
  const yearOpts = () => Object.keys(D.lp.load).sort().reverse().map((y) => [+y, y]);
  card("loadSpread", {
    title: () => "Streuung zwischen Ladepunkten",
    sub: () => "10., 25., 50., 75., 90. Perzentil je Klasse",
    tools: () => [
      { type: "seg", key: "spreadMetric", default: "kwh_day", options: [["kwh_day", "kWh/Tag"], ["sess_day", "Vorgänge/Tag"]] },
      { type: "select", key: "spreadYear", default: RANGE.lastFull, numeric: true, options: yearOpts(), label: "Jahr", global: true },
    ],
    render: (body) => {
      const y = String(tool("spreadYear", RANGE.lastFull));
      const metric = tool("spreadMetric", "kwh_day");
      const src = D.lp.load[y] || {};
      const items = visibleClasses().filter((c) => src[c.id]).map((c) => ({
        label: c.label, color: classColor(c.id), q: src[c.id][metric],
        foot: `Je Tag in Monaten mit Meldung, ${y}`,
      }));
      if (!items.length) { body.append(h("div", { class: "empty", text: "Keine Daten." })); return null; }
      const f = metric === "kwh_day" ? kwh : (v, l) => fmt(v, l ? 2 : 1);
      spreadStrips(body, items, { format: f });
      return { head: ["Klasse", "P10", "P25", "Median", "P75", "P90"], rows: items.map((i) => [i.label, ...i.q.map((v) => fmt(v, 2))]) };
    },
    foot: () => nationalOnly(),
  });
  card("lorenz", {
    title: () => "Konzentration der Energie",
    sub: () => "Lorenzkurve je Klasse · Gini-Koeffizient",
    tools: () => [{ type: "select", key: "spreadYear", default: RANGE.lastFull, numeric: true, options: yearOpts(), label: "Jahr", global: true }],
    render: (body) => {
      const y = String(tool("spreadYear", RANGE.lastFull));
      const src = D.lp.lorenz[y] || {};
      const s = visibleClasses().filter((c) => src[c.id]).map((c) => ({ label: c.label, color: classColor(c.id), pts: src[c.id].pts, gini: src[c.id].gini, n: src[c.id].n }));
      if (!s.length) { body.append(h("div", { class: "empty", text: "Keine Daten." })); return null; }
      lorenz(body, s, { height: 300 });
      return { head: ["Klasse", "Ladepunkte", "Gini"], rows: s.map((x) => [x.label, fmt(x.n, 0), fmt(x.gini, 3)]) };
    },
    foot: () => `0 = alle Ladepunkte gleich ausgelastet, 1 = ein Punkt lädt alles. ${nationalOnly()}`,
  });

  // 06 Energiemix
  card("mix", {
    title: () => (tool("mixMode", "share") === "share" ? "Anteil an der geladenen Energie" : "Geladene Energie"),
    sub: () => `${tool("mixMode", "share") === "share" ? "Prozent" : "MWh"} je Leistungsklasse · ${scopeLabel()}`,
    tools: () => [{ type: "seg", key: "mixMode", default: "share", options: [["share", "Anteil"], ["abs", "Absolut"]] }],
    render: (body) => {
      const s = classSeries((r) => r.e_sum / 1000, { minN: 1 }).map((x) => ({ ...x, values: x.values.map((v) => ({ ...v, y: v.y ?? 0 })) }));
      const share = tool("mixMode", "share") === "share";
      stackedArea(body, s, { normalize: share, grain: state.grain, shade: shadeRanges(), valueFormat: (v) => `${fmt(v, v < 10 ? 1 : 0)} MWh`, totalLabel: "Summe", height: 320 });
      return seriesTable(s, (v) => fmt(v, 1));
    },
    foot: () => (state.classes.size < 5 ? "Anteile beziehen sich nur auf die gewählten Klassen." : ""),
  });

  // 07 Wochenrhythmus
  card("week", {
    title: () => ({ n: "Start von Ladevorgängen", h: "Mittlere Dauer nach Startzeit", e: "Mittlere Energie nach Startzeit" }[tool("weekMetric", "n")]),
    sub: () => "Wochentag × Stunde des Ladebeginns",
    tools: () => [
      { type: "seg", key: "weekMetric", default: "n", options: [["n", "Starts"], ["h", "Dauer"], ["e", "Energie"]] },
      { type: "select", key: "weekClass", default: 0, numeric: true, options: [[0, "Alle Klassen"], ...D.classes.map((c) => [c.id, c.label])] },
    ],
    render: (body) => {
      const cls = String(tool("weekClass", 0));
      const metric = tool("weekMetric", "n");
      const data = D.week.data[cls] || [];
      const total = data.reduce((a, r) => a + r[2], 0) || 1;
      const matrix = DOW.map(() => Array.from({ length: 24 }, () => ({ v: null })));
      for (const [dow, hod, n, e, hh] of data) {
        const v = metric === "n" ? (n / total) * 100 : metric === "h" ? hh : e;
        matrix[dow - 1][hod] = {
          v,
          tip: tipRows(`${DOW[dow - 1]}, ${hod}:00 bis ${hod + 1}:00 Uhr`, [
            { label: "Anteil der Starts", value: `${fmt((n / total) * 100, 2)} %` },
            { label: "Ladevorgänge", value: fmtCompact(n) },
            { label: "Ø Dauer", value: fmtHours(hh, true) },
            { label: "Ø Energie", value: `${fmt(e, 1)} kWh` },
          ]),
        };
      }
      const f = metric === "n" ? (v) => `${fmt(v, 2)} %` : metric === "h" ? (v) => fmtHours(v) : (v) => `${fmt(v, 1)} kWh`;
      heatmap(body, matrix, DOW, Array.from({ length: 24 }, (_, i) => String(i)), { format: f });
      return {
        head: ["Tag", ...Array.from({ length: 24 }, (_, i) => `${i} h`)],
        rows: matrix.map((row, i) => [DOW[i], ...row.map((c) => (c.v == null ? "–" : fmt(c.v, 2)))]),
      };
    },
    foot: () => nationalOnly(),
  });

  // 08 Verteilungen
  card("ridge", {
    title: () => ({ kwh: "Energie je Ladevorgang", h: "Dauer je Ladevorgang", kwavg: "Mittlere Ladeleistung je Vorgang" }[tool("ridgeMetric", "kwh")]),
    sub: () => "Verteilung je Jahr, auf die eigene Spitze normiert · Strich = Median",
    tools: () => [
      { type: "seg", key: "ridgeMetric", default: "kwh", options: [["kwh", "Energie"], ["h", "Dauer"], ["kwavg", "Leistung"]] },
      { type: "select", key: "ridgeClass", default: 0, numeric: true, options: [[0, "Alle Klassen"], ...D.classes.map((c) => [c.id, c.label])] },
    ],
    render: (body) => {
      const metric = tool("ridgeMetric", "kwh");
      const cls = String(tool("ridgeClass", 0));
      const hist = D.hist[metric];
      const log = metric === "kwavg";
      const years = Object.keys(hist.data).sort();
      const groups = years
        .map((y) => ({ label: y, bins: hist.data[y][cls] || [], highlight: +y === RANGE.lastFull }))
        .filter((g) => g.bins.reduce((a, b) => a + b, 0) >= 200);
      groups.forEach((g) => (g.marker = binMedian(g.bins, hist.edges, log)));
      if (!groups.length) { body.append(h("div", { class: "empty", text: "Zu wenige Ladevorgänge." })); return null; }
      const xMax = metric === "kwh" ? 100 : metric === "h" ? 16 : 400;
      const unitFmt = metric === "kwh" ? (v) => `${fmt(v, 1)} kWh` : metric === "h" ? (v) => fmtHours(v, true) : (v) => `${fmt(v, 1)} kW`;
      ridgeline(body, groups, hist.edges, {
        log, xMax, unit: hist.unit, rowH: 36, overlap: 2,
        onHover: (g) => tipRows(g.label, [
          { label: "Median", value: unitFmt(g.marker) },
          { label: "Ladevorgänge", value: fmtCompact(g.bins.reduce((a, b) => a + b, 0)) },
        ]),
      });
      return { head: ["Jahr", "Median", "Ladevorgänge"], rows: groups.map((g) => [g.label, unitFmt(g.marker), fmt(g.bins.reduce((a, b) => a + b, 0), 0)]) };
    },
    foot: () => `Median aus Histogramm-Klassen interpoliert. ${nationalOnly()}`,
  });

  // 09 Regionen
  const regionMetrics = {
    kwh_lp_day: { label: "Energie je Ladepunkt und Tag", unit: "kWh", fmt: (v, l) => (l ? `${fmt(v, 1)} kWh` : fmt(v, 1)) },
    sess_lp_day: { label: "Ladevorgänge je Ladepunkt und Tag", unit: "", fmt: (v) => fmt(v, 2) },
    kwh_sess: { label: "Ø Energie je Ladevorgang", unit: "kWh", fmt: (v, l) => (l ? `${fmt(v, 1)} kWh` : fmt(v, 1)) },
    dc_share: { label: "Anteil Energie an DC-Punkten (> 22 kW)", unit: "%", fmt: (v) => `${fmt(v, 0)} %` },
    lps: { label: "Meldende Ladepunkte", unit: "", fmt: (v) => fmt(v, 0) },
  };
  const regionTools = () => [
    { type: "select", key: "regionMetric", default: "kwh_lp_day", options: Object.entries(regionMetrics).map(([k, v]) => [k, v.label]), global: true, label: "Kennzahl" },
    { type: "select", key: "regionYear", default: RANGE.lastFull, numeric: true, options: RANGE.years.slice().reverse().map((y) => [y, String(y)]), global: true, label: "Jahr" },
  ];
  card("tiles", {
    title: () => regionMetrics[tool("regionMetric", "kwh_lp_day")].label,
    sub: () => `Bundesländer · ${tool("regionYear", RANGE.lastFull)}`,
    tools: regionTools,
    render: (body) => {
      const vals = regionValues(tool("regionMetric", "kwh_lp_day"), tool("regionYear", RANGE.lastFull));
      const spec = regionMetrics[tool("regionMetric", "kwh_lp_day")];
      tileMap(body, vals, { format: spec.fmt, label: spec.label });
      return { head: ["Bundesland", spec.label], rows: Object.entries(vals).sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1)).map(([k, v]) => [k, v == null ? "–" : spec.fmt(v, true)]) };
    },
    foot: () => (state.classes.size < 5 ? "Nur gewählte Leistungsklassen (außer DC-Anteil)." : "Kachelkarte: jedes Land gleich groß, Lage nur angenähert."),
  });
  card("blRank", {
    title: () => "Rangfolge",
    sub: () => `${regionMetrics[tool("regionMetric", "kwh_lp_day")].label} · ${tool("regionYear", RANGE.lastFull)}`,
    render: (body) => {
      const spec = regionMetrics[tool("regionMetric", "kwh_lp_day")];
      const vals = regionValues(tool("regionMetric", "kwh_lp_day"), tool("regionYear", RANGE.lastFull));
      const items = Object.entries(vals).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({ label: STATE_TILES[k]?.[0] ? `${k}` : k, value: v }));
      hBars(body, items, { format: (v) => spec.fmt(v), rowH: 22 });
      return { head: ["Bundesland", spec.label], rows: items.map((i) => [i.label, spec.fmt(i.value, true)]) };
    },
  });
  card("lage", {
    title: () => "Profil nach Lage der Station",
    sub: () => `${tool("regionYear", RANGE.lastFull)} · gewählte Leistungsklassen`,
    render: (body) => lageTable(body),
    foot: () => "Energie und Dauer als Mittelwert (summenbasiert), Leistung = Summe Energie / Summe Dauer.",
  });

  // 10 Stammdaten
  card("map", {
    available: () => !!(D.master?.ls?.points || D.master?.lp?.points),
    title: () => "Ladestationen nach Inbetriebnahme",
    sub: () => "Ein Punkt je Station mit Koordinaten",
    render: (body) => renderMap(body),
  });
  card("commissioning", {
    available: () => !!(D.master?.lp?.commissioning || D.master?.ls?.commissioning),
    title: () => (D.master?.lp?.commissioning ? "In Betrieb genommene Ladepunkte" : "In Betrieb genommene Ladestationen"),
    sub: () => "kumuliert, nach Inbetriebnahmedatum",
    render: (body) => {
      const s = commissioningSeries();
      if (s.length > 1) stackedArea(body, s, { grain: state.grain, valueFormat: (v) => fmt(v, 0), totalLabel: "Summe", height: 300 });
      else lineChart(body, s, { grain: state.grain, yFormat: (v) => fmt(v, 0), height: 300 });
      return seriesTable(s, (v) => fmt(v, 0));
    },
    foot: () => (D.master?.lp?.commissioning ? "Aus df_lp.csv, Klassen nach Nennleistung." : "Aus df_ls.csv."),
  });
  card("masterBl", {
    available: () => !!(D.master?.ls?.bundesland || D.master?.lp?.bundesland),
    title: () => "Stationen je Bundesland",
    sub: () => "Stammdaten",
    render: (body) => {
      const src = D.master.ls?.bundesland || D.master.lp.bundesland;
      const items = src.map(([k, v]) => ({ label: k, value: v }));
      hBars(body, items, { format: (v) => fmt(v, 0), rowH: 22 });
      return { head: ["Bundesland", "Anzahl"], rows: items.map((i) => [i.label, fmt(i.value, 0)]) };
    },
  });
  card("program", {
    available: () => !!(D.master?.ls?.program || D.master?.ls?.lage),
    title: () => (D.master.ls?.program ? "Stationen je Förderprogramm" : "Stationen nach Lage"),
    sub: () => "Stammdaten",
    render: (body) => {
      const src = D.master.ls.program || D.master.ls.lage;
      const items = src.map(([k, v]) => ({ label: String(k).length > 34 ? String(k).slice(0, 33) + "…" : String(k), value: v }));
      hBars(body, items, { format: (v) => fmt(v, 0), rowH: 24, color: cssVar("--c1") });
      return { head: ["Kategorie", "Anzahl"], rows: src.map(([k, v]) => [k, fmt(v, 0)]) };
    },
  });

  // 11 Qualität
  card("quality", {
    title: () => "Aussortierte Zeilen nach Regel",
    sub: () => `${fmt(D.meta.quality.rows_raw, 0)} Zeilen gelesen, ${fmt(D.meta.quality.rows_kept, 0)} plausibel (${fmt((D.meta.quality.rows_kept / D.meta.quality.rows_raw) * 100, 1)} %)`,
    render: (body) => {
      const items = D.meta.quality.drops.map((d) => ({
        label: d.label, value: d.n,
        tip: tipRows(d.label, [{ label: "Zeilen", value: fmt(d.n, 0) }, { label: "Anteil", value: `${fmt((d.n / D.meta.quality.rows_raw) * 100, 2)} %` }]),
      }));
      hBars(body, items, { format: (v) => fmt(v, 0), color: cssVar("--muted"), rowH: 26 });
      return { head: ["Regel", "Zeilen", "Anteil"], rows: items.map((i) => [i.label, fmt(i.value, 0), `${fmt((i.value / D.meta.quality.rows_raw) * 100, 2)} %`]) };
    },
  });
}

// ------------------------------------------------------------------ Hilfsrechnungen

function aggregateMonthly(pairs, grain) {
  // pairs: [[YYYY-MM-DD, n]] -> Map(t -> n) im gewählten Raster
  const out = new Map();
  for (const [m, n] of pairs) {
    const d = parseDate(m);
    const k = grain === "year" ? new Date(d.getFullYear(), 0, 1) : grain === "quarter" ? new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1) : d;
    out.set(+k, (out.get(+k) || 0) + n);
  }
  return out;
}

function periodsBetween(t0, t1, grain) {
  const res = [];
  let d = new Date(t0);
  d = grain === "year" ? new Date(d.getFullYear(), 0, 1) : grain === "quarter" ? new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1) : new Date(d.getFullYear(), d.getMonth(), 1);
  const step = grain === "year" ? 12 : grain === "quarter" ? 3 : 1;
  while (+d <= t1) {
    res.push(+d);
    d = new Date(d.getFullYear(), d.getMonth() + step, 1);
  }
  return res;
}

function newLpSeries() {
  const grain = state.grain;
  const periods = periodsBetween(+RANGE.start, +RANGE.endExcl - 1, grain);
  return visibleClasses().map((c) => {
    const agg = aggregateMonthly(D.lp.new_lps[String(c.id)] || [], grain);
    return { id: c.id, label: c.label, color: classColor(c.id), values: periods.map((t) => ({ x: new Date(t), y: agg.get(t) || 0 })) };
  });
}

function quoteSeries() {
  const grain = state.grain;
  const comm = D.master.lp.commissioning;
  const rows = scopeRows(grain, "all|Alle");
  return visibleClasses().map((c) => {
    const pairs = (comm[String(c.id)] || []).map(([m, n]) => [+parseDate(m), n]).sort((a, b) => a[0] - b[0]);
    const byT = new Map(rows.filter((r) => r.cls === c.id).map((r) => [r.t, r]));
    const periods = [...new Set(rows.map((r) => r.t))].sort((a, b) => a - b);
    return {
      id: c.id, label: c.label, color: classColor(c.id),
      values: periods.map((t) => {
        const endT = +new Date(new Date(t).getFullYear(), new Date(t).getMonth() + (grain === "year" ? 12 : grain === "quarter" ? 3 : 1), 1);
        const cum = pairs.filter(([pt]) => pt < endT).reduce((a, [, n]) => a + n, 0);
        const r = byT.get(t);
        return { x: new Date(t), y: r && cum >= 20 ? Math.min(150, (r.lps / cum) * 100) : null };
      }),
    };
  });
}

function commissioningSeries() {
  const grain = state.grain;
  const src = D.master.lp?.commissioning ? D.master.lp : D.master.ls;
  const comm = src.commissioning;
  const [a, b] = src.date_range.map((s) => +parseDate(s));
  const periods = periodsBetween(a, b, grain);
  const ids = src === D.master.lp && Object.keys(comm).some((k) => k !== "0") ? visibleClasses().map((c) => c.id) : [0];
  return ids.map((id) => {
    const pairs = id === 0 ? Object.values(comm).flat() : comm[String(id)] || [];
    const agg = aggregateMonthly(pairs, grain);
    let cum = 0;
    return {
      id, label: id ? classById(id).label : src.units_label, color: classColor(id || 2),
      values: periods.map((t) => { cum += agg.get(t) || 0; return { x: new Date(t), y: cum }; }),
    };
  });
}

function regionValues(metric, year) {
  const rows = IDX.year;
  const t = +new Date(year, 0, 1);
  const out = {};
  const ids = [...state.classes];
  for (const bl of Object.keys(STATE_TILES)) {
    const all = (rows.get(`bl|${bl}`) || []).filter((r) => r.t === t);
    if (!all.length) { out[bl] = null; continue; }
    const tot = all.find((r) => r.cls === 0);
    if (metric === "dc_share") {
      const dc = all.filter((r) => r.cls >= 3).reduce((a, r) => a + r.e_sum, 0);
      out[bl] = tot && tot.e_sum ? (dc / tot.e_sum) * 100 : null;
      continue;
    }
    const sel = all.filter((r) => ids.includes(r.cls));
    const n = sel.reduce((a, r) => a + r.n, 0);
    const e = sel.reduce((a, r) => a + r.e_sum, 0);
    const lps = sel.reduce((a, r) => a + r.lps, 0);
    const days = periodDays(t, "year");
    if (n < MIN_N) { out[bl] = null; continue; }
    out[bl] = metric === "kwh_lp_day" ? e / lps / days
      : metric === "sess_lp_day" ? n / lps / days
        : metric === "kwh_sess" ? e / n
          : lps;
  }
  return out;
}

function lageTable(body) {
  const year = tool("regionYear", RANGE.lastFull);
  const t = +new Date(year, 0, 1);
  const ids = [...state.classes];
  const rows = D.meta.lagen.map((l) => {
    const sel = (IDX.year.get(`lage|${l}`) || []).filter((r) => r.t === t && ids.includes(r.cls));
    const n = sel.reduce((a, r) => a + r.n, 0);
    const e = sel.reduce((a, r) => a + r.e_sum, 0);
    const hsum = sel.reduce((a, r) => a + r.h_mean * r.n, 0);
    const lps = sel.reduce((a, r) => a + r.lps, 0);
    return { l, n, e, kwh: n ? e / n : null, h: n ? hsum / n : null, kw: hsum ? e / hsum : null, lps };
  }).filter((r) => r.n >= MIN_N);
  if (!rows.length) { body.append(h("div", { class: "empty", text: "Keine Daten." })); return null; }
  const totalN = rows.reduce((a, r) => a + r.n, 0);
  const cols = [
    { key: "share", label: "Anteil Vorgänge", get: (r) => (r.n / totalN) * 100, f: (v) => `${fmt(v, 1)} %` },
    { key: "kwh", label: "Ø Energie", get: (r) => r.kwh, f: (v) => `${fmt(v, 1)} kWh` },
    { key: "h", label: "Ø Dauer", get: (r) => r.h, f: (v) => fmtHours(v, true) },
    { key: "kw", label: "Ø Leistung", get: (r) => r.kw, f: (v) => `${fmt(v, 1)} kW` },
    { key: "lps", label: "Ladepunkte", get: (r) => r.lps, f: (v) => fmt(v, 0) },
  ];
  const max = Object.fromEntries(cols.map((c) => [c.key, Math.max(...rows.map((r) => c.get(r) || 0))]));
  rows.sort((a, b) => b.n - a.n);
  const table = h("table", { class: "data-table lage-table" }, [
    h("thead", {}, h("tr", {}, [h("th", { text: "Lage" }), ...cols.map((c) => h("th", { text: c.label }))])),
    h("tbody", {}, rows.map((r) => h("tr", {}, [
      h("td", { text: r.l }),
      ...cols.map((c) => {
        const v = c.get(r);
        return h("td", {}, h("div", { class: "cellbar" }, [
          h("span", { class: "cellbar__bar", style: { width: `${max[c.key] ? (v / max[c.key]) * 100 : 0}%` } }),
          h("span", { class: "cellbar__val", text: c.f(v) }),
        ]));
      }),
    ]))),
  ]);
  body.append(h("div", { class: "lage-wrap" }, table));
  return { head: ["Lage", ...cols.map((c) => c.label)], rows: rows.map((r) => [r.l, ...cols.map((c) => c.f(c.get(r)))]) };
}

// ------------------------------------------------------------------ Karte

let mapTimer = null;
function renderMap(body) {
  const src = D.master.ls?.points ? D.master.ls : D.master.lp;
  const pts = src.points.data;
  const years = pts.map((p) => p[2]).filter((y) => y != null);
  const y0 = Math.min(...years), y1 = Math.max(...years);
  const W = body.clientWidth || 500;
  const lon0 = 5.7, lon1 = 15.2, lat0 = 47.2, lat1 = 55.1;
  const k = Math.cos((51 * Math.PI) / 180);
  const aspect = (lat1 - lat0) / ((lon1 - lon0) * k);
  const Hh = Math.min(540, W * aspect);
  const Ww = Hh / aspect;
  const dpr = window.devicePixelRatio || 1;
  const canvas = h("canvas", { class: "map-canvas", width: Math.round(Ww * dpr), height: Math.round(Hh * dpr), role: "img", "aria-label": "Karte der Ladestationen" });
  canvas.style.width = `${Ww}px`;
  canvas.style.height = `${Hh}px`;
  canvas.style.margin = "0 auto";
  const ctx = canvas.getContext("2d");
  const px = (lon) => ((lon - lon0) / (lon1 - lon0)) * Ww;
  const py = (lat) => ((lat1 - lat) / (lat1 - lat0)) * Hh;
  const sorted = pts.slice().sort((a, b) => (a[2] ?? 0) - (b[2] ?? 0));
  const label = h("span", { class: "map-year" });
  const count = h("span");
  const slider = h("input", { type: "range", min: y0, max: y1, step: 1, value: tool("mapYear", y1), "aria-label": "Stand bis Jahr" });
  const draw = (upto) => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, Ww, Hh);
    let n = 0;
    for (const [lat, lon, y] of sorted) {
      if (y != null && y > upto) continue;
      const t = y == null || y1 === y0 ? 0.6 : (y - y0) / (y1 - y0);
      ctx.fillStyle = seqColor(0.3 + t * 0.7);
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.arc(px(lon), py(lat), W < 500 ? 1.3 : 1.7, 0, Math.PI * 2);
      ctx.fill();
      n++;
    }
    ctx.globalAlpha = 1;
    label.textContent = `bis ${upto}`;
    count.textContent = `${fmt(n, 0)} Stationen`;
  };
  slider.addEventListener("input", () => { state.tools.mapYear = +slider.value; draw(+slider.value); });
  const play = h("button", { class: "play-btn", type: "button", "aria-label": "Zeitraffer abspielen", html: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.5v9l7-4.5z" fill="currentColor"/></svg>' });
  play.addEventListener("click", () => {
    clearInterval(mapTimer);
    let y = y0;
    slider.value = y;
    draw(y);
    mapTimer = setInterval(() => {
      y++;
      if (y > y1) { clearInterval(mapTimer); return; }
      slider.value = y;
      state.tools.mapYear = y;
      draw(y);
    }, 700);
  });
  body.append(canvas, h("div", { class: "map-controls" }, [play, label, slider, count]));
  const bar = h("span", { class: "seq-legend__bar", style: { background: `linear-gradient(90deg, ${seqColor(0.3)}, ${seqColor(1)})` } });
  body.append(h("div", { class: "seq-legend" }, [h("span", { text: `Inbetriebnahme ${y0}` }), bar, h("span", { text: String(y1) })]));
  draw(+slider.value);
  const byYear = {};
  for (const p of pts) byYear[p[2] ?? "ohne"] = (byYear[p[2] ?? "ohne"] || 0) + 1;
  return { head: ["Jahr der Inbetriebnahme", "Stationen"], rows: Object.entries(byYear).map(([y, n]) => [y, fmt(n, 0)]) };
}

// ------------------------------------------------------------------ Methodik

function renderMethod(q) {
  const m = D.meta;
  const R = m.rules;
  const det = (kind) => {
    const x = D.master?.[kind];
    if (!x) return "";
    const pairs = Object.entries(x.detected).map(([k, v]) => `${k} → <code>${v}</code>`).join(", ");
    return `<li><b>${x.file}</b>: ${fmt(x.rows, 0)} Zeilen. Erkannt: ${pairs || "keine Zuordnung"}.</li>`;
  };
  document.getElementById("method").innerHTML = `
    <div>
      <h3>Plausibilitätsregeln</h3>
      <ul>
        <li>Ladebeginn zwischen 2017 und Ende des Berichtszeitraums</li>
        <li>Dauer zwischen ${R.min_seconds / 60} Minute und ${R.max_seconds / 3600} Stunden</li>
        <li>Energie zwischen ${fmt(R.min_wh / 1000, 1)} und ${fmt(R.max_wh / 1000, 0)} kWh</li>
        <li>Nennleistung größer 0 und höchstens ${fmt(R.max_kw, 0)} kW</li>
        <li>Mittlere Leistung höchstens ${fmt((R.power_tolerance - 1) * 100, 0)} % (+1 kW) über der Nennleistung</li>
      </ul>
      <p>Die Grenzen sind bewusst großzügig und in <code>pipeline/build.py</code> anpassbar.</p>
    </div>
    <div>
      <h3>Leistungsklassen</h3>
      <p>Nach <code>maxladeleistunginkilowatt</code> des Ladepunkts: ${D.classes.map((c) => c.label).join(", ")}. Die Klasse beschreibt den Ladepunkt, nicht das Fahrzeug.</p>
      <h3>Kennzahlen</h3>
      <p>Median und Quartile werden in DuckDB per t-digest angenähert (typisch unter 1 % Abweichung). Mittlere Ladeleistung = Energie / Dauer je Vorgang, inklusive Standzeit.</p>
    </div>
    <div>
      <h3>Grenzen der Daten</h3>
      <ul>
        <li>Ladepunkt- und Stations-IDs der Ladevorgänge sind zufällig neu vergeben. Keine Verknüpfung mit Stammdaten möglich.</li>
        <li>Nur geförderte Ladepunkte, deren Betreiber berichten. Kein Abbild aller öffentlichen Ladepunkte.</li>
        <li>Halbjährliche Meldung: fehlende Halbjahre einzelner Betreiber drücken Zählwerte, nicht aber Mittelwerte je Vorgang.</li>
        <li>Zeitzone der Zeitstempel nicht dokumentiert.</li>
      </ul>
    </div>
    <div>
      <h3>Stammdaten</h3>
      <ul>${det("ls")}${det("lp")}</ul>
      <p>Spalten werden über Namensmuster erkannt. Falsche Zuordnung mit <code>--map rolle=spalte</code> korrigieren.</p>
    </div>`;
}
