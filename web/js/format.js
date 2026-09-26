// Deutsche Zahlen- und Datumsformate

const nfCache = new Map();
function nf(digits) {
  if (!nfCache.has(digits)) {
    nfCache.set(digits, new Intl.NumberFormat("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
  }
  return nfCache.get(digits);
}

/** Zahl mit sinnvoller Stellenzahl: große Werte ganzzahlig, kleine mit Nachkommastellen */
export function fmt(v, digits) {
  if (v == null || !isFinite(v)) return "–";
  if (digits == null) {
    const a = Math.abs(v);
    if (Number.isInteger(v)) return nf(0).format(v);
    digits = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 1 : a === 0 ? 0 : 2;
  }
  return nf(digits).format(v);
}

/** Kompakt: 1.284 / 12,9 Tsd. / 4,2 Mio. */
export function fmtCompact(v) {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e9) return `${fmt(v / 1e9, a >= 1e10 ? 0 : 1)} Mrd.`;
  if (a >= 1e6) return `${fmt(v / 1e6, a >= 1e7 ? 0 : 1)} Mio.`;
  if (a >= 1e4) return `${fmt(v / 1e3, 0)} Tsd.`;
  return fmt(v, 0);
}

export function fmtEnergy(kwh) {
  if (kwh == null) return "–";
  const a = Math.abs(kwh);
  if (a >= 1e6) return { v: fmt(kwh / 1e6, a >= 1e7 ? 0 : 1), u: "GWh" };
  if (a >= 1e3) return { v: fmt(kwh / 1e3, a >= 1e4 ? 0 : 1), u: "MWh" };
  return { v: fmt(kwh, 0), u: "kWh" };
}

/** Stunden als "2 h 15 min" bzw. "45 min" */
export function fmtHours(h, long = false) {
  if (h == null || !isFinite(h)) return "–";
  const min = Math.round(h * 60);
  if (!long) return h >= 10 ? `${fmt(h, 0)} h` : h >= 1 ? `${fmt(h, 1)} h` : `${min} min`;
  const hh = Math.floor(min / 60), mm = min % 60;
  return hh ? `${hh} h ${String(mm).padStart(2, "0")} min` : `${mm} min`;
}

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

export function fmtPeriod(d, grain) {
  if (grain === "year") return String(d.getFullYear());
  if (grain === "quarter") return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d || 1);
}
