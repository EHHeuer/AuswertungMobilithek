// Kleine SVG-Diagrammbibliothek für das Dashboard. Keine Abhängigkeiten.
// Konventionen: 2px Linien, Haarlinien-Raster, Balken max. 24px mit 4px Rundung am Datenende,
// 2px Flächenfuge zwischen gestapelten Segmenten, Tooltip bei jedem Diagramm.

import { fmt, fmtPeriod } from "./format.js";

const NS = "http://www.w3.org/2000/svg";

export function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  if (parent) parent.appendChild(node);
  return node;
}

export function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) node.style.setProperty(sk, sv);
        else node.style[sk] = sv;
      }
    }
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) if (c != null) node.append(c);
  return node;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ------------------------------------------------------------------ Skalen & Ticks

export function linear(d0, d1, r0, r1) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = (v) => r0 + (v - d0) * k;
  f.invert = (p) => d0 + (p - r0) / (k || 1);
  return f;
}

export function niceTicks(min, max, count = 5) {
  if (!isFinite(min) || !isFinite(max)) return [0];
  if (max === min) max = min + 1;
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function timeTicks(t0, t1, width) {
  const d0 = new Date(t0), d1 = new Date(t1);
  const years = d1.getFullYear() - d0.getFullYear();
  const ticks = [];
  const every = width < 420 && years > 4 ? 2 : 1;
  for (let y = d0.getFullYear() + (d0.getMonth() > 0 ? 1 : 0); y <= d1.getFullYear(); y += every) {
    const t = new Date(y, 0, 1).getTime();
    if (t >= t0 - 1 && t <= t1 + 1) ticks.push({ t, label: String(y) });
  }
  if (ticks.length < 2) {
    for (let y = d0.getFullYear(); y <= d1.getFullYear(); y++) {
      for (const m of [0, 6]) {
        const t = new Date(y, m, 1).getTime();
        if (t >= t0 && t <= t1 && !ticks.find((x) => x.t === t)) ticks.push({ t, label: m ? `Jul ${y}` : String(y) });
      }
    }
  }
  return ticks.sort((a, b) => a.t - b.t);
}

function textWidth(str, size = 11.5) {
  return String(str).length * size * 0.56;
}

// ------------------------------------------------------------------ Tooltip

const tip = () => document.getElementById("tooltip");

export function showTip(evt, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14;
  const r = t.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}

export function hideTip() {
  tip().hidden = true;
}

export function tipRows(title, rows, foot) {
  const body = rows
    .map((r) => `<div class="tooltip__row"><span class="tooltip__key" style="--c:${r.color || "transparent"}"></span><span>${r.label}</span><b>${r.value}</b></div>`)
    .join("");
  return `<div class="tooltip__title">${title}</div>${body}${foot ? `<div class="tooltip__muted">${foot}</div>` : ""}`;
}

function focusTipEvent(svg, x, y) {
  const r = svg.getBoundingClientRect();
  return { clientX: r.left + x, clientY: r.top + y };
}

// ------------------------------------------------------------------ Legende

export function legend(items, box = false) {
  return h(
    "div",
    { class: "legend" },
    items.map((it) => h("span", { class: "legend__item" }, [
      h("span", { class: `legend__key${box ? " legend__key--box" : ""}`, style: { "--c": it.color } }),
      it.label,
    ])),
  );
}

// ------------------------------------------------------------------ Liniendiagramm

/**
 * series: [{id, label, color, values: [{x: Date, y, lo, hi}]}]
 * opts: height, yFormat, yTitle, grain, band, shade [{from, to, label}], yMax, tooltipFoot(x), endLabels
 */
export function lineChart(container, series, opts = {}) {
  container.innerHTML = "";
  const W = container.clientWidth || 600;
  const H = opts.height || 300;
  const yFormat = opts.yFormat || ((v) => fmt(v));
  const all = series.flatMap((s) => s.values.filter((v) => v.y != null));
  if (!all.length) {
    container.append(h("div", { class: "empty", text: "Keine Werte für diese Auswahl." }));
    return;
  }
  const xs = [...new Set(all.map((v) => +v.x))].sort((a, b) => a - b);
  const t0 = xs[0], t1 = xs[xs.length - 1];
  let yMax = opts.yMax ?? Math.max(...all.map((v) => (opts.band && v.hi != null ? v.hi : v.y)));
  const yMin = opts.yMin ?? 0;
  const yt = niceTicks(yMin, yMax * 1.04, H < 220 ? 3 : 5);
  yMax = yt[yt.length - 1];

  const endLabels = opts.endLabels !== false && W > 420;
  const labelW = endLabels ? Math.min(120, Math.max(...series.map((s) => textWidth(s.label, 12))) + 22) : 12;
  const m = { t: 12, r: labelW, b: 26, l: Math.max(...yt.map((t) => textWidth(yFormat(t)))) + 14 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = linear(t0, t1 === t0 ? t0 + 1 : t1, m.l, m.l + iw);
  const y = linear(yMin, yMax, m.t + ih, m.t);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opts.aria || "" }, null);

  // Schattierte Bereiche (z. B. unvollständige Meldungen)
  for (const s of opts.shade || []) {
    const a = Math.max(m.l, x(+s.from)), b = Math.min(m.l + iw, x(+s.to));
    if (b > a) {
      el("rect", { class: "shade", x: a, y: m.t, width: b - a, height: ih }, svg);
      if (s.label && b - a > 40) el("text", { class: "shade-label", x: a + 4, y: m.t + 12, text: s.label }, svg);
    }
  }

  const g = el("g", { class: "grid" }, svg);
  const ax = el("g", { class: "axis" }, svg);
  for (const t of yt) {
    if (t !== yMin) el("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t) }, g);
    el("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end", text: yFormat(t) }, ax);
  }
  el("line", { class: "baseline", x1: m.l, x2: m.l + iw, y1: y(yMin), y2: y(yMin) }, svg);
  for (const tk of timeTicks(t0, t1, iw)) {
    el("text", { x: x(tk.t), y: H - 6, "text-anchor": "middle", text: tk.label }, ax);
  }
  if (opts.yTitle) el("text", { class: "axis-title", x: m.l, y: m.t - 2, text: "" }, svg);

  // Bänder
  if (opts.band) {
    for (const s of series) {
      const pts = s.values.filter((v) => v.lo != null && v.hi != null && v.y != null);
      if (pts.length < 2) continue;
      const d = pts.map((v, i) => `${i ? "L" : "M"}${x(+v.x)},${y(v.hi)}`).join("") +
        pts.slice().reverse().map((v) => `L${x(+v.x)},${y(v.lo)}`).join("") + "Z";
      el("path", { d, fill: s.color, class: "series-band" }, svg);
    }
  }

  // Linien (Lücken bei fehlenden Werten)
  for (const s of series) {
    let d = "", pen = false;
    for (const v of s.values) {
      if (v.y == null) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${x(+v.x).toFixed(1)},${y(v.y).toFixed(1)}`;
      pen = true;
    }
    el("path", { d, class: "series-line", stroke: s.color }, svg);
    // einzelne Punkte ohne Nachbarn sichtbar machen
    s.values.forEach((v, i) => {
      if (v.y == null) return;
      const prev = s.values[i - 1], next = s.values[i + 1];
      if ((!prev || prev.y == null) && (!next || next.y == null)) {
        el("circle", { cx: x(+v.x), cy: y(v.y), r: 3, fill: s.color }, svg);
      }
    });
  }

  // Endbeschriftungen mit Kollisionsvermeidung und Führungslinie
  if (endLabels) {
    const ends = series
      .map((s) => {
        const last = [...s.values].reverse().find((v) => v.y != null);
        return last ? { s, px: x(+last.x), py: y(last.y), ly: y(last.y) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.py - b.py);
    const gap = 14;
    for (let i = 1; i < ends.length; i++) if (ends[i].ly - ends[i - 1].ly < gap) ends[i].ly = ends[i - 1].ly + gap;
    const over = ends.length ? ends[ends.length - 1].ly - (m.t + ih) : 0;
    if (over > 0) ends.forEach((e) => (e.ly -= over));
    for (const e of ends) {
      const lx = m.l + iw + 10;
      if (Math.abs(e.ly - e.py) > 2 || lx - e.px > 12) {
        el("path", { class: "leader", d: `M${e.px + 4},${e.py}L${lx - 3},${e.ly}`, fill: "none" }, svg);
      }
      el("circle", { cx: e.px, cy: e.py, r: 3.5, fill: e.s.color, class: "hover-dot" }, svg);
      el("text", { class: "end-label", x: lx, y: e.ly + 4, text: e.s.label }, svg);
    }
  }

  // Interaktion: Crosshair + Tooltip, auch per Tastatur
  const hover = el("g", { style: "display:none" }, svg);
  const cross = el("line", { class: "crosshair", y1: m.t, y2: m.t + ih }, hover);
  const dots = series.map((s) => el("circle", { r: 4.5, fill: s.color, class: "hover-dot" }, hover));
  const overlay = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent", tabindex: 0, style: "cursor:crosshair;outline:none" }, svg);
  let idx = -1;
  const show = (i, evt) => {
    idx = Math.max(0, Math.min(xs.length - 1, i));
    const t = xs[idx];
    hover.style.display = "";
    cross.setAttribute("x1", x(t));
    cross.setAttribute("x2", x(t));
    const rows = [];
    series.forEach((s, k) => {
      const v = s.values.find((p) => +p.x === t);
      if (v && v.y != null) {
        dots[k].setAttribute("cx", x(t));
        dots[k].setAttribute("cy", y(v.y));
        dots[k].style.display = "";
        rows.push({ label: s.label, value: yFormat(v.y, true), color: s.color, y: v.y, v });
      } else dots[k].style.display = "none";
    });
    rows.sort((a, b) => b.y - a.y);
    const title = fmtPeriod(new Date(t), opts.grain);
    const foot = opts.tooltipFoot ? opts.tooltipFoot(t, rows) : "";
    showTip(evt || focusTipEvent(svg, x(t), m.t + 10), tipRows(title, rows, foot));
  };
  overlay.addEventListener("mousemove", (evt) => {
    const r = svg.getBoundingClientRect();
    const px = ((evt.clientX - r.left) / r.width) * W;
    const t = x.invert(px);
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - t) < Math.abs(xs[best] - t)) best = i;
    show(best, evt);
  });
  const leave = () => { hover.style.display = "none"; hideTip(); };
  overlay.addEventListener("mouseleave", leave);
  overlay.addEventListener("blur", leave);
  overlay.addEventListener("keydown", (evt) => {
    if (evt.key === "ArrowRight") { show(idx + 1); evt.preventDefault(); }
    if (evt.key === "ArrowLeft") { show(idx < 0 ? xs.length - 1 : idx - 1); evt.preventDefault(); }
  });
  overlay.addEventListener("focus", () => show(idx < 0 ? xs.length - 1 : idx));

  container.append(svg);
  if (series.length > 1) container.append(legend(series));
}

// ------------------------------------------------------------------ Gestapelte Fläche

/** series: [{id,label,color,values:[{x,y}]}] mit identischen x in gleicher Reihenfolge */
export function stackedArea(container, series, opts = {}) {
  container.innerHTML = "";
  const W = container.clientWidth || 600;
  const H = opts.height || 300;
  const norm = !!opts.normalize;
  const xs = series[0]?.values.map((v) => +v.x) || [];
  if (!xs.length) {
    container.append(h("div", { class: "empty", text: "Keine Werte für diese Auswahl." }));
    return;
  }
  const totals = xs.map((_, i) => series.reduce((a, s) => a + (s.values[i].y || 0), 0));
  const stacks = [];
  const base = xs.map(() => 0);
  for (const s of series) {
    const lo = base.slice();
    const hi = s.values.map((v, i) => {
      const val = norm ? (totals[i] ? (v.y || 0) / totals[i] : 0) : v.y || 0;
      base[i] += val;
      return base[i];
    });
    stacks.push({ s, lo, hi });
  }
  const yFormat = opts.yFormat || (norm ? (v) => fmt(v * 100, 0) + " %" : (v) => fmt(v));
  let yMax = norm ? 1 : Math.max(...base);
  const yt = norm ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(0, yMax * 1.04, 5);
  yMax = yt[yt.length - 1];
  const endLabels = W > 420;
  const labelW = endLabels ? Math.max(...series.map((s) => textWidth(s.label, 12))) + 18 : 12;
  const m = { t: 10, r: labelW, b: 26, l: Math.max(...yt.map((t) => textWidth(yFormat(t)))) + 14 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = linear(xs[0], xs[xs.length - 1] === xs[0] ? xs[0] + 1 : xs[xs.length - 1], m.l, m.l + iw);
  const y = linear(0, yMax, m.t + ih, m.t);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  for (const s of opts.shade || []) {
    const a = Math.max(m.l, x(+s.from)), b = Math.min(m.l + iw, x(+s.to));
    if (b > a) el("rect", { class: "shade", x: a, y: m.t, width: b - a, height: ih }, svg);
  }
  const g = el("g", { class: "grid" }, svg);
  const ax = el("g", { class: "axis" }, svg);
  for (const t of yt) {
    if (t) el("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t) }, g);
    el("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end", text: yFormat(t) }, ax);
  }
  for (const tk of timeTicks(xs[0], xs[xs.length - 1], iw)) el("text", { x: x(tk.t), y: H - 6, "text-anchor": "middle", text: tk.label }, ax);

  const surface = cssVar("--surface");
  for (const st of stacks) {
    const d = xs.map((t, i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(st.hi[i]).toFixed(1)}`).join("") +
      xs.slice().reverse().map((t, j) => { const i = xs.length - 1 - j; return `L${x(t).toFixed(1)},${y(st.lo[i]).toFixed(1)}`; }).join("") + "Z";
    el("path", { d, fill: st.s.color, "fill-opacity": 0.88 }, svg);
  }
  // 2px Flächenfuge zwischen den Schichten
  for (const st of stacks.slice(0, -1)) {
    const d = xs.map((t, i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(st.hi[i]).toFixed(1)}`).join("");
    el("path", { d, fill: "none", stroke: surface, "stroke-width": 2 }, svg);
  }
  el("line", { class: "baseline", x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0) }, svg);

  if (endLabels) {
    const lastI = xs.length - 1;
    const ends = stacks
      .map((st) => ({ st, py: y((st.lo[lastI] + st.hi[lastI]) / 2), h: y(st.lo[lastI]) - y(st.hi[lastI]) }))
      .filter((e) => e.h > 0.5);
    ends.sort((a, b) => a.py - b.py);
    for (let i = 1; i < ends.length; i++) if (ends[i].py - ends[i - 1].py < 14) ends[i].py = ends[i - 1].py + 14;
    for (const e of ends) el("text", { class: "end-label", x: m.l + iw + 8, y: e.py + 4, text: e.st.s.label }, svg);
  }

  const hover = el("g", { style: "display:none" }, svg);
  const cross = el("line", { class: "crosshair", y1: m.t, y2: m.t + ih }, hover);
  const overlay = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent", tabindex: 0, style: "outline:none" }, svg);
  let idx = -1;
  const show = (i, evt) => {
    idx = Math.max(0, Math.min(xs.length - 1, i));
    const t = xs[idx];
    hover.style.display = "";
    cross.setAttribute("x1", x(t));
    cross.setAttribute("x2", x(t));
    const rows = stacks.slice().reverse().map((st) => {
      const raw = st.s.values[idx].y || 0;
      const share = totals[idx] ? raw / totals[idx] : 0;
      return {
        label: st.s.label,
        color: st.s.color,
        value: norm ? `${fmt(share * 100, 1)} %` : `${(opts.valueFormat || fmt)(raw)} · ${fmt(share * 100, 0)} %`,
      };
    });
    const foot = opts.totalLabel ? `${opts.totalLabel}: ${(opts.valueFormat || fmt)(totals[idx])}` : "";
    showTip(evt || focusTipEvent(svg, x(t), m.t + 10), tipRows(fmtPeriod(new Date(t), opts.grain), rows, foot));
  };
  overlay.addEventListener("mousemove", (evt) => {
    const r = svg.getBoundingClientRect();
    const t = x.invert(((evt.clientX - r.left) / r.width) * W);
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - t) < Math.abs(xs[best] - t)) best = i;
    show(best, evt);
  });
  const leave = () => { hover.style.display = "none"; hideTip(); };
  overlay.addEventListener("mouseleave", leave);
  overlay.addEventListener("blur", leave);
  overlay.addEventListener("focus", () => show(idx < 0 ? xs.length - 1 : idx));
  overlay.addEventListener("keydown", (evt) => {
    if (evt.key === "ArrowRight") { show(idx + 1); evt.preventDefault(); }
    if (evt.key === "ArrowLeft") { show(idx - 1); evt.preventDefault(); }
  });
  container.append(svg, legend(series.slice().reverse(), true));
}

// ------------------------------------------------------------------ Gestapelte Säulen (Zeitachse)

export function stackedColumns(container, series, opts = {}) {
  container.innerHTML = "";
  const W = container.clientWidth || 600;
  const H = opts.height || 240;
  const xs = series[0]?.values.map((v) => +v.x) || [];
  if (!xs.length) {
    container.append(h("div", { class: "empty", text: "Keine Werte für diese Auswahl." }));
    return;
  }
  const totals = xs.map((_, i) => series.reduce((a, s) => a + (s.values[i].y || 0), 0));
  const yFormat = opts.yFormat || ((v) => fmt(v));
  const yt = niceTicks(0, Math.max(...totals) * 1.05, 4);
  const yMax = yt[yt.length - 1];
  const m = { t: 10, r: 8, b: 26, l: Math.max(...yt.map((t) => textWidth(yFormat(t)))) + 14 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const band = iw / xs.length;
  const bw = Math.max(1, Math.min(24, band - 2));
  const x = (i) => m.l + band * i + (band - bw) / 2;
  const y = linear(0, yMax, m.t + ih, m.t);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  const g = el("g", { class: "grid" }, svg);
  const ax = el("g", { class: "axis" }, svg);
  for (const t of yt) {
    if (t) el("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t) }, g);
    el("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end", text: yFormat(t) }, ax);
  }
  const tx = linear(xs[0], xs[xs.length - 1] || xs[0] + 1, m.l + band / 2, m.l + iw - band / 2);
  for (const tk of timeTicks(xs[0], xs[xs.length - 1], iw)) el("text", { x: tx(tk.t), y: H - 6, "text-anchor": "middle", text: tk.label }, ax);

  const gapPx = bw >= 6 ? 2 : 0;
  xs.forEach((t, i) => {
    let acc = 0;
    const segs = series.map((s) => ({ s, v: s.values[i].y || 0 })).filter((q) => q.v > 0);
    segs.forEach((q, k) => {
      const y0 = y(acc), y1 = y(acc + q.v);
      acc += q.v;
      const top = k === segs.length - 1;
      const hgt = Math.max(0, y0 - y1 - (k ? gapPx : 0));
      if (hgt <= 0) return;
      const r = top ? Math.min(4, bw / 2, hgt) : 0;
      const yy = y1, xx = x(i);
      const d = r
        ? `M${xx},${yy + hgt}V${yy + r}Q${xx},${yy} ${xx + r},${yy}H${xx + bw - r}Q${xx + bw},${yy} ${xx + bw},${yy + r}V${yy + hgt}Z`
        : `M${xx},${yy + hgt}V${yy}H${xx + bw}V${yy + hgt}Z`;
      el("path", { d, fill: q.s.color }, svg);
    });
    const hit = el("rect", { x: m.l + band * i, y: m.t, width: band, height: ih, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (evt) => {
      const rows = series.slice().reverse().map((s) => ({ label: s.label, color: s.color, value: yFormat(s.values[i].y || 0, true) }));
      showTip(evt, tipRows(fmtPeriod(new Date(t), opts.grain), rows, `Summe: ${yFormat(totals[i], true)}`));
    });
    hit.addEventListener("mouseleave", hideTip);
  });
  el("line", { class: "baseline", x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0) }, svg);
  container.append(svg);
  if (series.length > 1) container.append(legend(series.slice().reverse(), true));
}

// ------------------------------------------------------------------ Horizontale Balken

/** items: [{label, value, color?, tip?}] */
export function hBars(container, items, opts = {}) {
  container.innerHTML = "";
  const W = container.clientWidth || 400;
  const rowH = opts.rowH || 26;
  const fmtV = opts.format || ((v) => fmt(v));
  const labelW = Math.min(W * 0.46, Math.max(...items.map((i) => textWidth(i.label, 12.5))) + 12);
  const maxChars = Math.floor((labelW - 12) / (12.5 * 0.56));
  const clip = (str) => (str.length > maxChars ? str.slice(0, Math.max(3, maxChars - 1)) + "…" : str);
  const valW = Math.max(...items.map((i) => textWidth(fmtV(i.value)))) + 10;
  const H = items.length * rowH + 8;
  const max = opts.max ?? Math.max(...items.map((i) => i.value), 0);
  const x = linear(0, max || 1, labelW, W - valW);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  const bw = Math.min(16, rowH - 10);
  items.forEach((it, i) => {
    const cy = i * rowH + rowH / 2 + 2;
    const lab = el("text", { class: "cat-label", x: labelW - 10, y: cy + 4, "text-anchor": "end", text: clip(it.label) }, svg);
    if (clip(it.label) !== it.label) el("title", { text: it.label }, lab);
    const w = Math.max(0, x(it.value) - labelW);
    const r = Math.min(4, w, bw / 2);
    const x0 = labelW, y0 = cy - bw / 2;
    const d = w > 0
      ? `M${x0},${y0}H${x0 + w - r}Q${x0 + w},${y0} ${x0 + w},${y0 + r}V${y0 + bw - r}Q${x0 + w},${y0 + bw} ${x0 + w - r},${y0 + bw}H${x0}Z`
      : "";
    if (d) el("path", { d, fill: it.color || opts.color || cssVar("--accent") }, svg);
    el("text", { class: "bar-label", x: x0 + w + 6, y: cy + 4, text: fmtV(it.value) }, svg);
    const hit = el("rect", { x: 0, y: i * rowH, width: W, height: rowH, fill: "transparent" }, svg);
    const tipHtml = it.tip || tipRows(it.label, [{ label: opts.valueLabel || "Wert", value: fmtV(it.value, true), color: it.color || opts.color || cssVar("--accent") }]);
    {
      hit.addEventListener("mousemove", (evt) => showTip(evt, tipHtml));
      hit.addEventListener("mouseleave", hideTip);
    }
  });
  el("line", { class: "baseline", x1: labelW, x2: labelW, y1: 2, y2: H - 4 }, svg);
  container.append(svg);
}

// ------------------------------------------------------------------ Heatmap

/** matrix[r][c] = {v, tip}; rows/cols = Beschriftungen */
export function heatmap(container, matrix, rows, cols, opts = {}) {
  container.innerHTML = "";
  const W = container.clientWidth || 600;
  const m = { t: 8, r: 4, b: 22, l: 34 };
  const iw = W - m.l - m.r;
  const cw = iw / cols.length;
  const ch = Math.max(18, Math.min(34, cw * 0.95));
  const H = m.t + ch * rows.length + m.b;
  const vals = matrix.flat().map((c) => c.v).filter((v) => v != null);
  const lo = opts.min ?? Math.min(...vals), hi = opts.max ?? Math.max(...vals);
  const c0 = hexToRgb(cssVar("--seq-0")), c1 = hexToRgb(cssVar("--seq-1"));
  const color = (v) => {
    const t = hi === lo ? 0.5 : Math.pow((v - lo) / (hi - lo), opts.gamma || 0.85);
    return `rgb(${c0.map((a, i) => Math.round(a + (c1[i] - a) * t)).join(",")})`;
  };
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  const ax = el("g", { class: "axis" }, svg);
  rows.forEach((r, i) => el("text", { x: m.l - 8, y: m.t + ch * i + ch / 2 + 4, "text-anchor": "end", text: r }, ax));
  cols.forEach((c, j) => {
    if (j % (cw < 20 ? 3 : 2) === 0) el("text", { x: m.l + cw * j + cw / 2, y: H - 6, "text-anchor": "middle", text: c }, ax);
  });
  const gap = cw > 10 ? 2 : 1;
  matrix.forEach((row, i) => row.forEach((cell, j) => {
    if (cell.v == null) return;
    const r = el("rect", {
      x: m.l + cw * j + gap / 2, y: m.t + ch * i + gap / 2, width: cw - gap, height: ch - gap, rx: 2, fill: color(cell.v),
    }, svg);
    r.addEventListener("mousemove", (evt) => showTip(evt, cell.tip));
    r.addEventListener("mouseleave", hideTip);
  }));
  container.append(svg);
  const bar = h("span", { class: "seq-legend__bar", style: { background: `linear-gradient(90deg, ${cssVar("--seq-0")}, ${cssVar("--seq-1")})` } });
  const fmtL = opts.format || ((v) => fmt(v));
  container.append(h("div", { class: "seq-legend" }, [h("span", { text: fmtL(lo) }), bar, h("span", { text: fmtL(hi) }), opts.legendLabel ? h("span", { text: opts.legendLabel }) : null]));
}

export function hexToRgb(hex) {
  const s = hex.replace("#", "");
  const n = parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function seqColor(t) {
  const c0 = hexToRgb(cssVar("--seq-0")), c1 = hexToRgb(cssVar("--seq-1"));
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${c0.map((a, i) => Math.round(a + (c1[i] - a) * k)).join(",")})`;
}

// ------------------------------------------------------------------ Ridgeline

/**
 * groups: [{label, bins:[counts], highlight?}] von alt nach neu
 * edges: linke Bin-Ränder; log: log-Skala für x
 */
export function ridgeline(container, groups, edges, opts = {}) {
  container.innerHTML = "";
  const W = container.clientWidth || 600;
  const rowH = opts.rowH || 34;
  const overlap = opts.overlap || 1.9;
  const m = { t: rowH * overlap - rowH + 8, r: 16, b: opts.axis === false ? 4 : 26, l: opts.labels === false ? 4 : (opts.labelW || 48) };
  const H = m.t + rowH * groups.length + m.b;
  const iw = W - m.l - m.r;
  const lastEdge = edges[edges.length - 1] + (edges[1] - edges[0]);
  const xMaxVal = opts.xMax ?? lastEdge;
  const xMinVal = opts.log ? edges[0] : 0;
  const tf = opts.log ? Math.log10 : (v) => v;
  const x = linear(tf(xMinVal), tf(xMaxVal), m.l, m.l + iw);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  const ax = el("g", { class: "axis" }, svg);
  const ink = cssVar("--ink"), accent = cssVar("--accent"), surface = opts.fill || cssVar("--surface");
  const mids = edges.map((e, i) => (opts.log ? Math.sqrt(e * (edges[i + 1] || e * (edges[1] / edges[0]))) : e + (edges[1] - edges[0]) / 2));

  groups.forEach((gr, gi) => {
    const baseY = m.t + rowH * (gi + 1);
    const peak = Math.max(...gr.bins, 1);
    const pts = [];
    gr.bins.forEach((c, i) => {
      if (mids[i] > xMaxVal) return;
      pts.push([x(tf(mids[i])), baseY - (c / peak) * rowH * overlap]);
    });
    if (!pts.length) return;
    const d = `M${pts[0][0]},${baseY}` + pts.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("") + `L${pts[pts.length - 1][0]},${baseY}`;
    const hi = gr.highlight;
    el("path", { d: d + "Z", fill: hi ? accent : surface, "fill-opacity": hi ? 0.16 : 1 }, svg);
    if (hi) el("path", { d: d + "Z", fill: surface, "fill-opacity": 0 }, svg);
    el("path", { d, fill: "none", stroke: hi ? accent : ink, "stroke-width": hi ? 1.8 : 1.1, "stroke-opacity": hi ? 1 : 0.75, "stroke-linejoin": "round" }, svg);
    if (opts.labels !== false) {
      el("text", { class: "tick-label", x: m.l - 8, y: baseY - 3, "text-anchor": "end", text: gr.label, style: hi ? `fill:${accent};font-weight:600` : null }, svg);
    }
    if (gr.marker != null && gr.marker <= xMaxVal) {
      const mx = x(tf(gr.marker));
      el("line", { x1: mx, x2: mx, y1: baseY, y2: baseY - 6, stroke: hi ? accent : ink, "stroke-width": 1.5 }, svg);
    }
    if (opts.onHover) {
      const hit = el("rect", { x: m.l, y: baseY - rowH, width: iw, height: rowH, fill: "transparent" }, svg);
      hit.addEventListener("mousemove", (evt) => showTip(evt, opts.onHover(gr)));
      hit.addEventListener("mouseleave", hideTip);
    }
  });
  if (opts.axis !== false) {
    const ticks = opts.log ? [1, 3, 11, 22, 50, 150, 350].filter((t) => t >= xMinVal && t <= xMaxVal) : niceTicks(0, xMaxVal, 6).filter((t) => t <= xMaxVal);
    for (const t of ticks) el("text", { x: x(tf(t)), y: H - 6, "text-anchor": "middle", text: fmt(t) + (t === ticks[ticks.length - 1] && opts.unit ? ` ${opts.unit}` : "") }, ax);
    el("line", { class: "baseline", x1: m.l, x2: m.l + iw, y1: H - m.b + 2, y2: H - m.b + 2 }, svg);
  }
  container.append(svg);
  return svg;
}

// ------------------------------------------------------------------ Lorenzkurve

export function lorenz(container, series, opts = {}) {
  container.innerHTML = "";
  const W = container.clientWidth || 400;
  const H = Math.min(opts.height || 300, W * 0.8);
  const m = { t: 10, r: 12, b: 42, l: 42 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = linear(0, 1, m.l, m.l + iw), y = linear(0, 1, m.t + ih, m.t);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  const g = el("g", { class: "grid" }, svg), ax = el("g", { class: "axis" }, svg);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    if (t) el("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t) }, g);
    el("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end", text: `${t * 100} %` }, ax);
    el("text", { x: x(t), y: m.t + ih + 17, "text-anchor": "middle", text: `${t * 100} %` }, ax);
  }
  el("text", { class: "axis-title", x: m.l + iw, y: H - 4, "text-anchor": "end", text: "Anteil Ladepunkte, aufsteigend nach Energie →" }, svg);
  el("line", { x1: x(0), y1: y(0), x2: x(1), y2: y(1), stroke: cssVar("--axis"), "stroke-width": 1 }, svg);
  el("line", { class: "baseline", x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0) }, svg);
  for (const s of series) {
    const d = s.pts.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    el("path", { d, class: "series-line", stroke: s.color }, svg);
  }
  const hover = el("g", { style: "display:none" }, svg);
  const cross = el("line", { class: "crosshair", y1: m.t, y2: m.t + ih }, hover);
  const overlay = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
  overlay.addEventListener("mousemove", (evt) => {
    const r = svg.getBoundingClientRect();
    const px = x.invert(((evt.clientX - r.left) / r.width) * W);
    const q = Math.max(0, Math.min(1, px));
    hover.style.display = "";
    cross.setAttribute("x1", x(q));
    cross.setAttribute("x2", x(q));
    const rows = series.map((s) => {
      let yv = 0;
      for (let i = 1; i < s.pts.length; i++) {
        const [x0, y0] = s.pts[i - 1], [x1, y1] = s.pts[i];
        if (q >= x0 && q <= x1) { yv = y0 + (y1 - y0) * ((q - x0) / (x1 - x0 || 1)); break; }
      }
      return { label: s.label, color: s.color, value: `${fmt((1 - yv) * 100, 0)} %` };
    });
    showTip(evt, tipRows(`Die oberen ${fmt((1 - q) * 100, 0)} % der Ladepunkte`, rows, "laden diesen Anteil der Energie"));
  });
  overlay.addEventListener("mouseleave", () => { hover.style.display = "none"; hideTip(); });
  container.append(svg);
  container.append(legend(series.map((s) => ({ ...s, label: `${s.label} · Gini ${fmt(s.gini, 2)}` }))));
}

// ------------------------------------------------------------------ Perzentil-Streifen

/** items: [{label, color, q:[p10,p25,p50,p75,p90]}] */
export function spreadStrips(container, items, opts = {}) {
  container.innerHTML = "";
  const W = container.clientWidth || 400;
  const rowH = 38;
  const fmtV = opts.format || ((v) => fmt(v));
  const labelW = Math.max(...items.map((i) => textWidth(i.label, 12.5))) + 14;
  const H = items.length * rowH + 30;
  const max = Math.max(...items.map((i) => i.q[4] || 0));
  const ticks = niceTicks(0, max * 1.05, 5);
  const x = linear(0, ticks[ticks.length - 1], labelW, W - 16);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  const g = el("g", { class: "grid" }, svg), ax = el("g", { class: "axis" }, svg);
  for (const t of ticks) {
    el("line", { x1: x(t), x2: x(t), y1: 4, y2: H - 26 }, g);
    el("text", { x: x(t), y: H - 8, "text-anchor": "middle", text: fmtV(t) }, ax);
  }
  const surface = cssVar("--surface");
  items.forEach((it, i) => {
    const cy = i * rowH + rowH / 2 + 4;
    const [p10, p25, p50, p75, p90] = it.q;
    el("text", { class: "cat-label", x: labelW - 10, y: cy + 4, "text-anchor": "end", text: it.label }, svg);
    el("line", { x1: x(p10), x2: x(p90), y1: cy, y2: cy, stroke: it.color, "stroke-width": 2, "stroke-linecap": "round", "stroke-opacity": 0.55 }, svg);
    el("rect", { x: x(p25), y: cy - 6, width: Math.max(2, x(p75) - x(p25)), height: 12, rx: 4, fill: it.color }, svg);
    el("circle", { cx: x(p50), cy, r: 5, fill: surface, stroke: it.color, "stroke-width": 2.5 }, svg);
    const hit = el("rect", { x: 0, y: cy - rowH / 2, width: W, height: rowH, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (evt) => showTip(evt, tipRows(it.label, [
      { label: "90. Perzentil", value: fmtV(p90, true) },
      { label: "75. Perzentil", value: fmtV(p75, true) },
      { label: "Median", value: fmtV(p50, true), color: it.color },
      { label: "25. Perzentil", value: fmtV(p25, true) },
      { label: "10. Perzentil", value: fmtV(p10, true) },
    ], it.foot)));
    hit.addEventListener("mouseleave", hideTip);
  });
  container.append(svg);
}

// ------------------------------------------------------------------ Kachelkarte Bundesländer

export const STATE_TILES = {
  "Schleswig-Holstein": ["SH", 2, 0],
  "Hamburg": ["HH", 2, 1],
  "Mecklenburg-Vorpommern": ["MV", 3, 1],
  "Bremen": ["HB", 1, 1],
  "Niedersachsen": ["NI", 1, 2],
  "Sachsen-Anhalt": ["ST", 2, 2],
  "Brandenburg": ["BB", 3, 2],
  "Berlin": ["BE", 4, 2],
  "Nordrhein-Westfalen": ["NW", 0, 2],
  "Hessen": ["HE", 1, 3],
  "Thüringen": ["TH", 2, 3],
  "Sachsen": ["SN", 3, 3],
  "Rheinland-Pfalz": ["RP", 0, 3],
  "Saarland": ["SL", 0, 4],
  "Baden-Württemberg": ["BW", 1, 4],
  "Bayern": ["BY", 2, 4],
};

export function tileMap(container, values, opts = {}) {
  container.innerHTML = "";
  const W = Math.min(container.clientWidth || 400, 460);
  const cols = 5, rows = 5, gap = 4;
  const size = (W - gap * (cols - 1)) / cols;
  const H = rows * size + gap * (rows - 1);
  const vals = Object.values(values).filter((v) => v != null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", style: `max-width:${W}px;margin:0 auto` });
  const fmtV = opts.format || ((v) => fmt(v));
  const ink = cssVar("--ink"), page = cssVar("--page");
  for (const [name, [abbr, c, r]] of Object.entries(STATE_TILES)) {
    const v = values[name];
    const t = v == null || hi === lo ? 0 : (v - lo) / (hi - lo);
    const g = el("g", { class: "tile", tabindex: 0 }, svg);
    const xx = c * (size + gap), yy = r * (size + gap);
    el("rect", { x: xx, y: yy, width: size, height: size, rx: 6, fill: v == null ? cssVar("--surface-2") : seqColor(0.08 + t * 0.92) }, g);
    const txt = t > 0.55 ? page : ink;
    el("text", { class: "tile__abbr", x: xx + 9, y: yy + 20, fill: txt, text: abbr }, g);
    if (v != null && size > 56) el("text", { class: "tile__val", x: xx + 9, y: yy + size - 10, fill: txt, text: fmtV(v) }, g);
    const tipHtml = tipRows(name, [{ label: opts.label || "Wert", value: v == null ? "keine Daten" : fmtV(v, true) }], opts.tipFoot ? opts.tipFoot(name) : "");
    g.addEventListener("mousemove", (evt) => showTip(evt, tipHtml));
    g.addEventListener("mouseleave", hideTip);
    g.addEventListener("focus", () => { const b = g.getBoundingClientRect(); showTip({ clientX: b.right, clientY: b.top }, tipHtml); });
    g.addEventListener("blur", hideTip);
  }
  container.append(svg);
  const bar = h("span", { class: "seq-legend__bar", style: { background: `linear-gradient(90deg, ${seqColor(0.08)}, ${seqColor(1)})` } });
  container.append(h("div", { class: "seq-legend", style: { justifyContent: "center" } }, [h("span", { text: fmtV(lo) }), bar, h("span", { text: fmtV(hi) })]));
}

// ------------------------------------------------------------------ Sparkline

export function sparkline(values, color, W = 200) {
  const H = 34;
  const v = values.filter((a) => a != null);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  if (v.length < 2) return svg;
  const lo = Math.min(...v), hi = Math.max(...v);
  const x = linear(0, values.length - 1, 1, W - 4), y = linear(lo, hi === lo ? lo + 1 : hi, H - 3, 3);
  const pts = values.map((a, i) => (a == null ? null : [x(i), y(a)])).filter(Boolean);
  el("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(""), fill: "none", stroke: cssVar("--muted"), "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }, svg);
  const last = pts[pts.length - 1];
  el("circle", { cx: last[0], cy: last[1], r: 3, fill: color || cssVar("--accent") }, svg);
  return svg;
}

// ------------------------------------------------------------------ Gestapelte horizontale Balken

/** items: [{label, parts: [value, ...]}]; keys: [{label, color}] in derselben Reihenfolge wie parts */
export function stackedHBars(container, items, keys, opts = {}) {
  container.innerHTML = "";
  const W = container.clientWidth || 600;
  const rowH = opts.rowH || 24;
  const fmtV = opts.format || ((v) => fmt(v, 0));
  const labelW = Math.min(W * 0.4, Math.max(...items.map((i) => textWidth(i.label, 12.5))) + 12);
  const maxChars = Math.floor((labelW - 12) / (12.5 * 0.56));
  const clip = (str) => (str.length > maxChars ? str.slice(0, Math.max(3, maxChars - 1)) + "…" : str);
  const totals = items.map((i) => i.parts.reduce((a, b) => a + b, 0));
  const valW = Math.max(...totals.map((t) => textWidth(fmtV(t)))) + 10;
  const max = Math.max(...totals, 1);
  const x = linear(0, max, labelW, W - valW);
  const H = items.length * rowH + 8;
  const bw = Math.min(14, rowH - 9);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  const g = el("g", { class: "grid" }, svg);
  for (const t of niceTicks(0, max, 4)) if (t && t <= max) el("line", { x1: x(t), x2: x(t), y1: 2, y2: H - 4 }, g);
  items.forEach((it, i) => {
    const cy = i * rowH + rowH / 2 + 2;
    const lab = el("text", { class: "cat-label", x: labelW - 10, y: cy + 4, "text-anchor": "end", text: clip(it.label) }, svg);
    if (clip(it.label) !== it.label) el("title", { text: it.label }, lab);
    let acc = 0;
    const segs = it.parts.map((v, k) => ({ v, k })).filter((s) => s.v > 0);
    segs.forEach((s, j) => {
      const x0 = x(acc) + (j ? 1 : 0);
      acc += s.v;
      const x1 = x(acc) - (j < segs.length - 1 ? 1 : 0);
      const w = Math.max(0, x1 - x0);
      if (!w) return;
      const last = j === segs.length - 1;
      const r = last ? Math.min(4, w, bw / 2) : 0;
      const y0 = cy - bw / 2;
      const d = r
        ? `M${x0},${y0}H${x0 + w - r}Q${x0 + w},${y0} ${x0 + w},${y0 + r}V${y0 + bw - r}Q${x0 + w},${y0 + bw} ${x0 + w - r},${y0 + bw}H${x0}Z`
        : `M${x0},${y0}H${x0 + w}V${y0 + bw}H${x0}Z`;
      el("path", { d, fill: keys[s.k].color }, svg);
    });
    el("text", { class: "bar-label", x: x(totals[i]) + 6, y: cy + 4, text: fmtV(totals[i]) }, svg);
    const hit = el("rect", { x: 0, y: i * rowH, width: W, height: rowH, fill: "transparent" }, svg);
    const tipHtml = tipRows(it.label, keys.map((k, j) => ({ label: k.label, color: k.color, value: fmtV(it.parts[j]) })), `Summe: ${fmtV(totals[i])}`);
    hit.addEventListener("mousemove", (evt) => showTip(evt, tipHtml));
    hit.addEventListener("mouseleave", hideTip);
  });
  el("line", { class: "baseline", x1: labelW, x2: labelW, y1: 2, y2: H - 4 }, svg);
  container.append(svg, legend(keys, true));
}

// ------------------------------------------------------------------ Tagesprofil (24 Stunden)

/** series: [{label, color, values: [24 Werte], width?}] */
export function hourLines(container, series, opts = {}) {
  container.innerHTML = "";
  const W = container.clientWidth || 600;
  const H = opts.height || 280;
  const yFormat = opts.yFormat || ((v) => fmt(v));
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) {
    container.append(h("div", { class: "empty", text: "Keine Werte für diese Auswahl." }));
    return;
  }
  const yt = niceTicks(0, Math.max(...all) * 1.08, 5);
  const yMax = yt[yt.length - 1];
  const m = { t: 12, r: 16, b: 26, l: Math.max(...yt.map((t) => textWidth(yFormat(t)))) + 14 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = linear(0, 23, m.l, m.l + iw), y = linear(0, yMax, m.t + ih, m.t);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img" });
  const g = el("g", { class: "grid" }, svg), ax = el("g", { class: "axis" }, svg);
  for (const t of yt) {
    if (t) el("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t) }, g);
    el("text", { x: m.l - 8, y: y(t) + 4, "text-anchor": "end", text: yFormat(t) }, ax);
  }
  for (let hh = 0; hh < 24; hh += W < 480 ? 4 : 2) el("text", { x: x(hh), y: H - 6, "text-anchor": "middle", text: `${hh} Uhr` }, ax);
  el("line", { class: "baseline", x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0) }, svg);
  for (const s of series) {
    const d = s.values.map((v, i) => (v == null ? "" : `${i && s.values[i - 1] != null ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join("");
    el("path", { d, class: "series-line", stroke: s.color, "stroke-width": s.width || 2 }, svg);
  }
  if (opts.mark) {
    const { i, v, label } = opts.mark;
    el("circle", { cx: x(i), cy: y(v), r: 5, fill: opts.markColor || cssVar("--ink"), class: "hover-dot" }, svg);
    el("text", { class: "end-label end-label--value", x: x(i), y: y(v) - 10, "text-anchor": i > 18 ? "end" : "middle", text: label }, svg);
  }
  const hover = el("g", { style: "display:none" }, svg);
  const cross = el("line", { class: "crosshair", y1: m.t, y2: m.t + ih }, hover);
  const dots = series.map((s) => el("circle", { r: 4.5, fill: s.color, class: "hover-dot" }, hover));
  const overlay = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent", tabindex: 0, style: "outline:none" }, svg);
  let idx = -1;
  const show = (i, evt) => {
    idx = Math.max(0, Math.min(23, i));
    hover.style.display = "";
    cross.setAttribute("x1", x(idx));
    cross.setAttribute("x2", x(idx));
    const rows = [];
    series.forEach((s, k) => {
      const v = s.values[idx];
      if (v == null) { dots[k].style.display = "none"; return; }
      dots[k].style.display = "";
      dots[k].setAttribute("cx", x(idx));
      dots[k].setAttribute("cy", y(v));
      rows.push({ label: s.label, color: s.color, value: yFormat(v, true) });
    });
    const r = svg.getBoundingClientRect();
    showTip(evt || { clientX: r.left + x(idx), clientY: r.top + m.t }, tipRows(`${idx}:00 bis ${idx + 1}:00 Uhr`, rows, opts.tooltipFoot || ""));
  };
  overlay.addEventListener("mousemove", (evt) => {
    const r = svg.getBoundingClientRect();
    show(Math.round(x.invert(((evt.clientX - r.left) / r.width) * W)), evt);
  });
  const leave = () => { hover.style.display = "none"; hideTip(); };
  overlay.addEventListener("mouseleave", leave);
  overlay.addEventListener("blur", leave);
  overlay.addEventListener("focus", () => show(idx < 0 ? 18 : idx));
  overlay.addEventListener("keydown", (evt) => {
    if (evt.key === "ArrowRight") { show(idx + 1); evt.preventDefault(); }
    if (evt.key === "ArrowLeft") { show(idx - 1); evt.preventDefault(); }
  });
  container.append(svg);
  if (series.length > 1) container.append(legend(series));
}
