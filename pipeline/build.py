#!/usr/bin/env python3
"""
OBELISöffentlich -> aggregierte JSON-Datei für das Dashboard in web/.

Ablauf
  1. Rohdaten laden (df_lv.csv, df_ls.csv, optional df_lp.csv) - lokal oder per Download
  2. Ladevorgänge in DuckDB einlesen, Plausibilitätsregeln anwenden
  3. Kennzahlen nach Zeitraum x Leistungsklasse (x Bundesland / Lage) aggregieren
  4. Stammdaten generisch profilieren (Spalten werden per Namensmuster erkannt)
  5. Alles als eine JSON-Datei nach web/data/obelis.json schreiben

Aufruf
  python pipeline/build.py                  # lädt fehlende Rohdaten nach data/raw/ und baut
  python pipeline/build.py --lv pfad/df_lv.csv --ls pfad/df_ls.csv
  python pipeline/build.py --no-lp          # df_lp.csv (Ladepunkt-Stammdaten) weglassen

Datenquelle: "OBELISöffentlich: Stamm- und Betriebsdaten geförderter öffentlich zugänglicher
Ladestationen für Elektrofahrzeuge" / NOW GmbH (Nationale Leitstelle Ladeinfrastruktur),
Lizenz CC BY 4.0, https://mobilithek.info/offers/714073450865197056
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import re
import sys
import urllib.request
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
OUT_DEFAULT = ROOT / "web" / "data" / "obelis.json"

BASE_URL = "https://d1269bxe5ubfat.cloudfront.net/obelisoe/rawData/"
FILES = {"lv": "df_lv.csv", "ls": "df_ls.csv", "lp": "df_lp.csv", "pm": "df_pm.csv"}

SOURCE_NOTE = (
    '"OBELISöffentlich: Stamm- und Betriebsdaten geförderter öffentlich zugänglicher '
    'Ladestationen für Elektrofahrzeuge" / NOW GmbH (Nationale Leitstelle Ladeinfrastruktur), '
    "Lizenz CC BY 4.0"
)

# Leistungsklassen nach maxladeleistunginkilowatt des Ladepunkts (obere Grenze inklusive)
CLASSES = [
    {"id": 1, "key": "ac11", "label": "bis 11 kW", "short": "≤ 11", "hi": 11},
    {"id": 2, "key": "ac22", "label": "12–22 kW", "short": "≤ 22", "hi": 22},
    {"id": 3, "key": "dc50", "label": "23–50 kW", "short": "≤ 50", "hi": 50},
    {"id": 4, "key": "dc150", "label": "51–150 kW", "short": "≤ 150", "hi": 150},
    {"id": 5, "key": "hpc", "label": "über 150 kW", "short": "> 150", "hi": 1000},
]

# Plausibilitätsregeln, in dieser Reihenfolge geprüft (erste zutreffende Regel zählt)
RULES = {
    "min_seconds": 60,  # kürzer als 1 min: Abbruch/Testvorgang
    "max_seconds": 48 * 3600,  # länger als 48 h: Datenfehler oder Dauerparker
    "min_wh": 100,  # weniger als 0,1 kWh: keine echte Ladung
    "max_wh": 300_000,  # mehr als 300 kWh: jenseits realer Pkw/Transporter-Akkus
    "max_kw": 1000,  # Ladepunkte über 1 MW: Tippfehler (Maximum im Rohdatensatz 400.555 kW)
    "power_tolerance": 1.15,  # mittlere Leistung darf Nennleistung um 15 % (+1 kW) übersteigen
}

DROP_LABELS = {
    "zeit_fehlt": "Beginn oder Ende fehlt",
    "zeit_ausserhalb": "Beginn außerhalb des Berichtszeitraums",
    "dauer_kurz": "Dauer unter 1 Minute",
    "dauer_lang": "Dauer über 48 Stunden",
    "energie_gering": "Energie unter 0,1 kWh",
    "energie_hoch": "Energie über 300 kWh",
    "leistung_ungueltig": "Nennleistung fehlt, 0 oder über 1 MW",
    "leistung_unplausibel": "Mittlere Leistung über Nennleistung",
}


# --------------------------------------------------------------------------- Hilfen


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def download(name: str, dest: Path, force: bool = False) -> Path:
    if dest.exists() and dest.stat().st_size > 10_000 and not force:
        return dest
    url = f"{BASE_URL}{name}?v=1"
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"Lade {url}")
    tmp = dest.with_suffix(".part")
    with urllib.request.urlopen(url) as resp, open(tmp, "wb") as fh:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            fh.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r  {done / 1e6:,.0f} / {total / 1e6:,.0f} MB", end="", flush=True)
        print()
    with open(tmp, "rb") as fh:
        head = fh.read(200).lower()
    if b"<html" in head or b"<!doctype" in head:
        tmp.unlink()
        sys.exit(
            f"Download von {name} liefert eine HTML-Fehlerseite (CloudFront blockt manche Regionen). "
            "Datei bitte manuell herunterladen und mit --lv/--ls/--lp übergeben."
        )
    tmp.rename(dest)
    return dest


def r3(x):
    """Auf 3-4 signifikante Stellen runden, hält die JSON-Datei klein."""
    if x is None:
        return None
    if isinstance(x, float):
        if math.isnan(x) or math.isinf(x):
            return None
        if x == 0:
            return 0
        digits = max(0, 3 - int(math.floor(math.log10(abs(x)))))
        return round(x, digits)
    return x


def iso(d) -> str | None:
    if d is None:
        return None
    return d.strftime("%Y-%m-%d")


def date_trunc_month(d) -> dt.datetime:
    return dt.datetime(d.year, d.month, 1)


def class_case(col: str) -> str:
    parts = [f"WHEN {col} <= {c['hi']} THEN {c['id']}" for c in CLASSES]
    return "CASE " + " ".join(parts) + " END"


# --------------------------------------------------------------------------- Ladevorgänge


def load_lv(con: duckdb.DuckDBPyConnection, path: Path, start: str, end: str) -> dict:
    log(f"Lese {path.name}")
    src = (f"read_csv('{path.as_posix()}', delim=';', header=true, all_varchar=true, "
           "quote='\"', ignore_errors=true)")
    cols = [r[0] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()]
    needed = ["beginn", "ende", "dauer_sekunden", "energie_wh", "lp_id", "ls_id",
              "bundesland", "lage", "maxladeleistunginkilowatt"]
    missing = [c for c in needed if c not in cols]
    if missing:
        sys.exit(f"df_lv.csv: Spalten fehlen {missing}. Gefunden: {cols}")

    num = lambda c: f"TRY_CAST(replace({c}, ',', '.') AS DOUBLE)"  # noqa: E731
    R = RULES
    if end == "auto":
        # Erster Monat nach dem letzten Ladebeginn, der nicht in der Zukunft liegt
        last = con.execute(
            f"SELECT max(b) FROM (SELECT TRY_CAST(beginn AS TIMESTAMP) AS b FROM {src}) "
            "WHERE b <= current_timestamp::TIMESTAMP"
        ).fetchone()[0]
        end = (date_trunc_month(last) + dt.timedelta(days=32)).replace(day=1).strftime("%Y-%m-%d")
        log(f"  Berichtszeitraum endet automatisch vor {end}")
    # Typisieren und Regeln prüfen in einem Durchlauf, ohne Rohtabelle zu materialisieren
    con.execute(
        f"""
        CREATE OR REPLACE TABLE lv_flag AS
        WITH t AS (
          SELECT
            TRY_CAST(beginn AS TIMESTAMP) AS b,
            TRY_CAST(ende AS TIMESTAMP) AS e,
            COALESCE({num('dauer_sekunden')},
                     date_diff('second', TRY_CAST(beginn AS TIMESTAMP), TRY_CAST(ende AS TIMESTAMP))) AS sec,
            {num('energie_wh')} AS wh,
            {num('maxladeleistunginkilowatt')} AS kw,
            lp_id AS lp, ls_id AS ls,
            NULLIF(trim(bundesland), '') AS bl,
            COALESCE(NULLIF(trim(lage), ''), 'Ohne Angabe') AS lage
          FROM {src}
        )
        SELECT *,
          CASE
            WHEN b IS NULL OR e IS NULL THEN 'zeit_fehlt'
            WHEN b < TIMESTAMP '{start}' OR b >= TIMESTAMP '{end}' THEN 'zeit_ausserhalb'
            WHEN sec IS NULL OR sec < {R['min_seconds']} THEN 'dauer_kurz'
            WHEN sec > {R['max_seconds']} THEN 'dauer_lang'
            WHEN wh IS NULL OR wh < {R['min_wh']} THEN 'energie_gering'
            WHEN wh > {R['max_wh']} THEN 'energie_hoch'
            WHEN kw IS NULL OR kw <= 0 OR kw > {R['max_kw']} THEN 'leistung_ungueltig'
            WHEN (wh / 1000.0) / (sec / 3600.0) > kw * {R['power_tolerance']} + 1 THEN 'leistung_unplausibel'
          END AS drop_reason
        FROM t
        """
    )

    total = con.execute("SELECT count(*) FROM lv_flag").fetchone()[0]
    drops = dict(con.execute(
        "SELECT drop_reason, count(*) FROM lv_flag WHERE drop_reason IS NOT NULL GROUP BY 1"
    ).fetchall())

    con.execute(
        f"""
        CREATE OR REPLACE TABLE lvc AS
        SELECT
            date_trunc('month', b)::DATE AS month,
            date_trunc('quarter', b)::DATE AS quarter,
            date_trunc('year', b)::DATE AS year,
            year(b) AS y,
            {class_case('kw')} AS cls,
            wh / 1000.0 AS kwh,
            sec / 3600.0 AS h,
            (wh / 1000.0) / (sec / 3600.0) AS kwavg,
            LEAST(((wh / 1000.0) / (sec / 3600.0)) / kw, 1.5) AS util,
            kw, lp, ls, bl, lage,
            hour(b) AS hod,
            isodow(b) AS dow,
            CAST(epoch(b) AS BIGINT) AS t0,
            CAST(epoch(b) AS BIGINT) + CAST(sec AS BIGINT) AS t1
        FROM lv_flag WHERE drop_reason IS NULL
        """
    )
    con.execute("DROP TABLE lv_flag")
    kept = con.execute("SELECT count(*) FROM lvc").fetchone()[0]
    log(f"  {total:,} Zeilen gelesen, {kept:,} plausibel ({kept / max(total, 1):.1%})")
    return {
        "rows_raw": total,
        "rows_kept": kept,
        "drops": [
            {"key": k, "label": DROP_LABELS[k], "n": drops.get(k, 0)}
            for k in DROP_LABELS
        ],
    }


SERIES_COLS = [
    "p", "dim", "val", "cls", "n", "e_sum",
    "e_mean", "e_p25", "e_med", "e_p75",
    "h_mean", "h_p25", "h_med", "h_p75",
    "kw_ratio", "kw_mean", "kw_p25", "kw_med", "kw_p75",
    "util_med", "lps", "lss",
]


def series(con, grain: str) -> list[list]:
    rows: list[list] = []
    dims = {"all": "'Alle'", "bl": "bl", "lage": "lage"}
    for dim, expr in dims.items():
        q = f"""
        SELECT {grain} AS p, '{dim}' AS dim, {expr} AS val, COALESCE(cls, 0) AS cls,
               count(*) AS n, sum(kwh) AS e_sum,
               avg(kwh), approx_quantile(kwh, [0.25, 0.5, 0.75]),
               avg(h), approx_quantile(h, [0.25, 0.5, 0.75]),
               sum(kwh) / sum(h), avg(kwavg), approx_quantile(kwavg, [0.25, 0.5, 0.75]),
               approx_quantile(util, 0.5),
               count(DISTINCT lp), count(DISTINCT ls)
        FROM lvc
        WHERE {expr} IS NOT NULL
        GROUP BY GROUPING SETS (({grain}, {expr}, cls), ({grain}, {expr}))
        ORDER BY 1, 3, 4
        """
        for r in con.execute(q).fetchall():
            p, d, v, c, n, esum, emean, eq, hmean, hq, kwr, kwmean, kwq, util, lps, lss = r
            rows.append([
                iso(p), d, v, c, n, r3(esum),
                r3(emean), *[r3(x) for x in eq],
                r3(hmean), *[r3(x) for x in hq],
                r3(kwr), r3(kwmean), *[r3(x) for x in kwq],
                r3(util), lps, lss,
            ])
    return rows


def week_profile(con) -> dict:
    """Startzeitpunkte nach Wochentag x Stunde, je Leistungsklasse (0 = alle)."""
    q = """
    SELECT COALESCE(cls, 0), dow, hod, count(*), avg(kwh), avg(h)
    FROM lvc GROUP BY GROUPING SETS ((cls, dow, hod), (dow, hod))
    """
    out: dict[str, list] = {}
    for c, dow, hod, n, ekwh, h in con.execute(q).fetchall():
        out.setdefault(str(c), []).append([dow, hod, n, r3(ekwh), r3(h)])
    for v in out.values():
        v.sort()
    return {"cols": ["dow", "hod", "n", "e_mean", "h_mean"], "data": out}


HIST = {
    # edges: linke Bin-Ränder; bin: SQL-Ausdruck für den Bin-Index (letzter Bin = Überlauf)
    "kwh": {"edges": [i * 2 for i in range(0, 76)], "bin": "floor(kwh / 2)", "unit": "kWh"},  # 0..150 kWh
    "h": {"edges": [i * 0.25 for i in range(0, 97)], "bin": "floor(h * 4)", "unit": "h"},  # 0..24 h
    "kwavg": {"edges": [round(10 ** (i / 16), 3) for i in range(0, 43)],
              "bin": "floor(16 * log10(GREATEST(kwavg, 1)))", "unit": "kW"},  # 1..~480 kW, log
}


def histograms(con) -> dict:
    out = {}
    for key, spec in HIST.items():
        edges = spec["edges"]
        q = f"""
        WITH b AS (
          SELECT y, cls, CAST(GREATEST(0, LEAST({spec['bin']}, {len(edges) - 1})) AS INTEGER) AS bin FROM lvc
        )
        SELECT y, COALESCE(cls, 0), bin, count(*)
        FROM b GROUP BY GROUPING SETS ((y, cls, bin), (y, bin))
        """
        data: dict[str, dict[str, list[int]]] = {}
        for y, c, b, n in con.execute(q).fetchall():
            arr = data.setdefault(str(y), {}).setdefault(str(c), [0] * len(edges))
            arr[b] += n
        out[key] = {"edges": edges, "unit": spec["unit"], "data": data}
    return out


def lp_level(con) -> dict:
    """Kennzahlen je Ladepunkt: Einstieg in die Meldungen, Konzentration (Lorenz), Auslastung."""
    con.execute(
        """
        CREATE OR REPLACE TABLE lp_stats AS
        SELECT lp, mode(cls) AS cls, min(month) AS first, max(month) AS last
        FROM lvc GROUP BY lp
        """
    )
    first = con.execute(
        """
        SELECT first, COALESCE(cls, 0), count(*) FROM lp_stats
        GROUP BY GROUPING SETS ((first, cls), (first)) ORDER BY 1
        """
    ).fetchall()
    new_lps: dict[str, list] = {}
    for m, c, n in first:
        new_lps.setdefault(str(c), []).append([iso(m), n])

    # Konzentration und Auslastung je Jahr: nur Ladepunkte, die in dem Jahr gemeldet haben
    per_year = con.execute(
        """
        WITH a AS (
          SELECT y, lp, mode(cls) AS cls, count(*) AS n, sum(kwh) AS e,
                 count(DISTINCT month) AS months
          FROM lvc GROUP BY y, lp
        )
        SELECT y, cls, list(e ORDER BY e), list(n / (months * 30.44) ORDER BY n / (months * 30.44)),
               list(e / (months * 30.44) ORDER BY e / (months * 30.44))
        FROM a GROUP BY GROUPING SETS ((y, cls), (y))
        """
    ).fetchall()
    lorenz: dict = {}
    load: dict = {}
    for y, c, energies, sess_day, kwh_day in per_year:
        key_c = str(c or 0)
        tot = sum(energies) or 1
        cum, pts, nlp = 0.0, [[0, 0]], len(energies)
        step = max(1, nlp // 50)
        for i, e in enumerate(energies, 1):
            cum += e
            if i % step == 0 or i == nlp:
                pts.append([round(i / nlp, 4), round(cum / tot, 4)])
        # Gini-Koeffizient aus der aufsteigend sortierten Liste
        s, acc = 0.0, 0.0
        for e in energies:
            acc += e
            s += acc
        gini = 1 - 2 * (s / (tot * nlp)) + 1 / nlp if nlp else None
        lorenz.setdefault(str(y), {})[key_c] = {"n": nlp, "gini": r3(gini), "pts": pts}

        def q(lst, p):
            if not lst:
                return None
            k = (len(lst) - 1) * p
            f = math.floor(k)
            c2 = min(f + 1, len(lst) - 1)
            return lst[f] + (lst[c2] - lst[f]) * (k - f)

        load.setdefault(str(y), {})[key_c] = {
            "sess_day": [r3(q(sess_day, p)) for p in (0.1, 0.25, 0.5, 0.75, 0.9)],
            "kwh_day": [r3(q(kwh_day, p)) for p in (0.1, 0.25, 0.5, 0.75, 0.9)],
        }
    return {"new_lps": new_lps, "lorenz": lorenz, "load": load}


def incomplete_months(month_rows: list[list]) -> list[str]:
    """Randmonate markieren, in denen deutlich weniger Ladepunkte melden als im Umfeld."""
    ser = [(r[0], r[20]) for r in month_rows if r[1] == "all" and r[3] == 0]
    ser.sort()
    flagged = []
    vals = [v for _, v in ser]
    for idx, (m, v) in enumerate(ser):
        window = vals[max(0, idx - 6): idx] + vals[idx + 1: idx + 7]
        if not window:
            continue
        med = sorted(window)[len(window) // 2]
        edge = idx < 3 or idx >= len(ser) - 3
        if edge and v < 0.5 * med:
            flagged.append(m)
    return flagged


# --------------------------------------------------------------------------- Stammdaten

PATTERNS = {
    "id": r"^(ls|lp)_id$",
    "ls_ref": r"^ls_id$",
    "date": r"inbetriebnahme|datum|date",
    "bundesland": r"bundesland",
    "lage": r"^lage",
    "power": r"leistung|kw",
    "n_lp": r"anzahl.*(ladepunkt|lp)",
    "lat": r"breitengrad|latitude|^lat$|^lat_|_lat$|^y$",
    "lon": r"l(ae|ä)ngengrad|longitude|^lon$|^lng$|^lon_|_lon$|^x$",
    "program": r"f(oe|ö)rderprogramm|^fp_id$|programm",
}


def detect(cols: list[str], overrides: dict) -> dict:
    found = {}
    lower = {c.lower(): c for c in cols}
    for role, pat in PATTERNS.items():
        if role in overrides:
            found[role] = overrides[role]
            continue
        for lc, orig in lower.items():
            if re.search(pat, lc):
                found[role] = orig
                break
    return found


def profile_master(con, path: Path, kind: str, overrides: dict) -> dict:
    log(f"Profiliere {path.name}")
    tbl = f"m_{kind}"
    con.execute(
        f"CREATE OR REPLACE TABLE {tbl} AS SELECT * FROM read_csv_auto('{path.as_posix()}', all_varchar=true, header=true)"
    )
    cols = [r[0] for r in con.execute(f"DESCRIBE {tbl}").fetchall()]
    m = detect(cols, overrides)
    if kind == "ls" and "power" not in overrides:
        # In df_ls ist "anschlussleistungInKilowatt" der Netzanschluss der Station, keine Ladepunktleistung
        m.pop("power", None)
    log(f"  erkannte Spalten: {m}")
    rows = con.execute(f"SELECT count(*) FROM {tbl}").fetchone()[0]
    out: dict = {"file": path.name, "rows": rows, "columns": cols, "detected": m}

    def qi(c):
        return '"' + c.replace('"', '""') + '"'

    num = lambda c: f"TRY_CAST(replace({qi(c)}, ',', '.') AS DOUBLE)"  # noqa: E731
    date_expr = None
    if "date" in m:
        c = qi(m["date"])
        date_expr = (
            f"COALESCE(TRY_CAST({c} AS DATE), TRY_CAST(TRY_CAST({c} AS TIMESTAMP) AS DATE), "
            f"TRY_CAST(try_strptime({c}, '%d.%m.%Y') AS DATE))"
        )
    weight = num(m["n_lp"]) if "n_lp" in m and kind == "ls" else "1"
    power_cls = class_case(num(m["power"])) if "power" in m else "NULL"
    power_valid = f"{num(m['power'])} > 0 AND {num(m['power'])} <= {RULES['max_kw']}" if "power" in m else "TRUE"

    out["units_label"] = "Ladepunkte" if kind == "lp" else "Ladestationen"
    if "n_lp" in m and kind == "ls":
        out["lp_total"] = r3(con.execute(f"SELECT sum({weight}) FROM {tbl}").fetchone()[0])

    if date_expr:
        res = con.execute(
            f"""
            SELECT date_trunc('month', {date_expr})::DATE AS mo,
                   COALESCE(CASE WHEN {power_valid} THEN {power_cls} END, 0) AS cls, count(*)
            FROM {tbl}
            WHERE {date_expr} BETWEEN DATE '2015-01-01' AND current_date
            GROUP BY 1, 2 ORDER BY 1
            """
        ).fetchall()
        tl: dict[str, list] = {}
        for mo, c, n in res:
            tl.setdefault(str(c), []).append([iso(mo), n])
        out["commissioning"] = tl
        out["date_range"] = [
            iso(x) for x in con.execute(
                f"SELECT min({date_expr}), max({date_expr}) FROM {tbl} "
                f"WHERE {date_expr} BETWEEN DATE '2015-01-01' AND current_date"
            ).fetchone()
        ]

    for role in ("bundesland", "lage"):
        if role in m:
            out[role] = [
                [v, n] for v, n in con.execute(
                    f"SELECT COALESCE(NULLIF(trim({qi(m[role])}), ''), 'Ohne Angabe'), count(*) "
                    f"FROM {tbl} GROUP BY 1 ORDER BY 2 DESC"
                ).fetchall()
            ]

    if "power" in m:
        out["power_classes"] = [
            [c, n] for c, n in con.execute(
                f"SELECT {power_cls} AS c, count(*) FROM {tbl} WHERE {power_valid} GROUP BY 1 ORDER BY 1"
            ).fetchall()
        ]
        out["power_top"] = [
            [r3(v), n] for v, n in con.execute(
                f"SELECT {num(m['power'])} AS v, count(*) FROM {tbl} WHERE {power_valid} "
                "GROUP BY 1 ORDER BY 2 DESC LIMIT 12"
            ).fetchall()
        ]

    if "lat" in m and "lon" in m:
        lat, lon = num(m["lat"]), num(m["lon"])
        yexpr = f"year({date_expr})" if date_expr else "NULL"
        pts = con.execute(
            f"""
            SELECT round({lat}, 3), round({lon}, 3), {yexpr},
                   COALESCE(CASE WHEN {power_valid} THEN {power_cls} END, 0)
            FROM {tbl}
            WHERE {lat} BETWEEN 47 AND 55.2 AND {lon} BETWEEN 5.5 AND 15.5
            """
        ).fetchall()
        out["points"] = {"cols": ["lat", "lon", "year", "cls"], "data": [list(p) for p in pts]}

    if "program" in m:
        out["program"] = [
            [v, n] for v, n in con.execute(
                f"SELECT COALESCE(NULLIF(trim({qi(m['program'])}), ''), 'Ohne Angabe'), count(*) "
                f"FROM {tbl} GROUP BY 1 ORDER BY 2 DESC LIMIT 15"
            ).fetchall()
        ]
    con.execute(f"DROP TABLE {tbl}")
    return out





# --------------------------------------------------------------------------- Belegung und Top-Stationen

AC_MAX_KW = 22  # AC = Nennleistung bis 22 kW, DC = darüber


def occupancy(con) -> dict:
    """Anteil belegter Ladepunkte je Kalenderstunde.

    Jeder Ladevorgang belegt seinen Ladepunkt von Beginn bis Ende (inkl. Standzeit). Die belegten
    Sekunden je Stunde werden durch (meldende Ladepunkte im Monat x 3600 s) geteilt. Daraus:
    Mittel je Jahr x Wochentag x Stunde und die Spitzenstunden."""
    log("Belegung je Stunde")
    con.execute(
        f"""
        CREATE OR REPLACE TABLE occ_h AS
        WITH s AS (
          SELECT t0, t1, CASE WHEN kw <= {AC_MAX_KW} THEN 'ac' ELSE 'dc' END AS typ,
                 unnest(range(t0 // 3600, (t1 - 1) // 3600 + 1)) AS k
          FROM lvc WHERE t1 > t0
        )
        SELECT k, typ, sum(LEAST(t1, (k + 1) * 3600) - GREATEST(t0, k * 3600)) AS occ_s
        FROM s GROUP BY GROUPING SETS ((k, typ), (k))
        """
    )
    con.execute(
        f"""
        CREATE OR REPLACE TABLE occ_lps AS
        SELECT month, COALESCE(typ, 'all') AS typ, count(DISTINCT lp) AS lps
        FROM (SELECT month, lp, CASE WHEN kw <= {AC_MAX_KW} THEN 'ac' ELSE 'dc' END AS typ FROM lvc)
        GROUP BY GROUPING SETS ((month, typ), (month))
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TABLE occ AS
        SELECT h.k, CAST(to_timestamp(h.k * 3600) AS TIMESTAMP) AS ts, COALESCE(h.typ, 'all') AS typ,
               h.occ_s, l.lps, h.occ_s / (l.lps * 3600.0) AS share
        FROM occ_h h
        JOIN occ_lps l ON l.typ = COALESCE(h.typ, 'all')
                      AND l.month = date_trunc('month', CAST(to_timestamp(h.k * 3600) AS TIMESTAMP))::DATE
        """
    )
    prof: dict = {}
    for y, typ, dow, hod, share, n in con.execute(
        """
        SELECT year(ts), typ, isodow(ts), hour(ts), avg(share), count(*) FROM occ
        GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4
        """
    ).fetchall():
        prof.setdefault(str(y), {}).setdefault(typ, [[None] * 24 for _ in range(7)])[dow - 1][hod] = r3(share)
    peaks: dict = {}
    for y, typ, ts, share, occ_s, lps in con.execute(
        """
        SELECT y, typ, ts, share, occ_s, lps FROM (
          SELECT year(ts) AS y, typ, ts, share, occ_s, lps,
                 row_number() OVER (PARTITION BY year(ts), typ ORDER BY share DESC) AS rn
          FROM occ
        ) WHERE rn = 1
        """
    ).fetchall():
        peaks.setdefault(str(y), {})[typ] = {
            "ts": ts.strftime("%Y-%m-%d %H:00"), "share": r3(share), "busy": r3(occ_s / 3600), "lps": lps,
        }
    con.execute("DROP TABLE occ_h; DROP TABLE occ_lps; DROP TABLE occ")
    return {"profile": prof, "peaks": peaks, "ac_max_kw": AC_MAX_KW}


def top_points(con, prices: dict | None, n: int = 10) -> dict:
    """Top-Ladepunkte nach geladener Energie je Jahr, getrennt AC (bis 22 kW) und DC. Normiert auf
    den einzelnen Ladepunkt, damit große Stationen nicht allein durch ihre Punktzahl vorn liegen.
    Umsatz = Energie x Ad-hoc-Arbeitspreis (P25/Median/P75 aus df_pm) als grobe Schätzung.
    IDs sind in den Rohdaten anonymisiert."""
    log("Top-Ladepunkte")
    price = {}
    if prices:
        for typ, key in (("ac", "normal"), ("dc", "schnell")):
            q = (prices["types"].get(key) or {}).get("q")
            if q:
                price[typ] = [q[1], q[2], q[3]]
    out: dict = {"price_ct": price, "years": {}}
    rows = con.execute(
        f"""
        WITH p AS (
          SELECT y, lp, any_value(ls) AS ls, any_value(bl) AS bl, any_value(lage) AS lage, max(kw) AS kw,
                 count(*) AS n, sum(kwh) AS kwh, sum(h) AS hours, count(DISTINCT month) AS months
          FROM lvc GROUP BY y, lp
        ), r AS (
          SELECT *, CASE WHEN kw <= {AC_MAX_KW} THEN 'ac' ELSE 'dc' END AS typ,
                 row_number() OVER (PARTITION BY y, CASE WHEN kw <= {AC_MAX_KW} THEN 'ac' ELSE 'dc' END
                                    ORDER BY kwh DESC) AS rn
          FROM p
        )
        SELECT y, typ, rn, lp, ls, bl, lage, kw, n, kwh, hours, months FROM r WHERE rn <= {n} ORDER BY y, typ, rn
        """
    ).fetchall()
    for y, typ, rn, lp, ls, bl, lage, kw, cnt, kwh, hours, months in rows:
        pr = price.get(typ)
        out["years"].setdefault(str(y), {}).setdefault(typ, []).append({
            "rank": rn, "id": lp, "ls": ls, "bl": bl, "lage": lage, "kw": r3(kw), "n": cnt,
            "kwh": r3(kwh), "hours": r3(hours), "months": months,
            "eur": [r3(kwh * c / 100) for c in pr] if pr else None,
        })
    return out


# --------------------------------------------------------------------------- Betreiber

LEGAL_FORMS = (r"\b(gmbh|mbh|ag|se|kg|kgaa|co|ug|ohg|gbr|eg|ev|e\.v|aktiengesellschaft|"
               r"haftungsbeschr(ae|ä)nkt|und|u)\b")


def operators(con, ls_path: Path, pm_path: Path | None, lp_path: Path | None, top: int = 40) -> dict | None:
    """Geförderte Ladeinfrastruktur je Betreiber, getrennt nach AC und DC.

    Mit df_lp.csv: Ladepunkte je Betreiber, AC = Nennleistung bis 22 kW, DC = darüber.
    Ohne df_lp.csv: Stationen je Betreiber, Typ aus df_pm.csv (Normal- bzw. Schnellladepunkt
    im Preismodell der Station). Nur die größten Betreiber werden ausgegeben."""
    con.execute(
        f"CREATE OR REPLACE TABLE op_ls AS SELECT * FROM read_csv_auto('{ls_path.as_posix()}', delim=';', "
        "header=true, all_varchar=true)"
    )
    cols = {r[0] for r in con.execute("DESCRIBE op_ls").fetchall()}
    if not {"id", "betreiber"} <= cols:
        log("  Betreiber: Spalten id/betreiber fehlen in df_ls, übersprungen")
        return None
    # Schlüssel: Rechtsformen und Satzzeichen entfernen, damit "X GmbH" und "X Gmbh." zusammenfallen
    con.execute(
        f"""
        CREATE OR REPLACE TABLE op_map AS
        SELECT TRY_CAST(id AS DOUBLE) AS ls_id, betreiber,
               trim(regexp_replace(regexp_replace(lower(betreiber), '{LEGAL_FORMS}', ' ', 'g'),
                                   '[^a-z0-9äöüß]+', ' ', 'g')) AS okey
        FROM op_ls WHERE NULLIF(trim(betreiber), '') IS NOT NULL
        """
    )
    basis = None
    if lp_path:
        lcols = [r[0] for r in con.execute(
            f"DESCRIBE SELECT * FROM read_csv_auto('{lp_path.as_posix()}', all_varchar=true, header=true)"
        ).fetchall()]
        lref = next((c for c in lcols if re.search(r"^(ls_id|ladestation_id)$", c.lower())), None)
        lpow = next((c for c in lcols if re.search(r"leistung", c.lower())), None)
        if lref and lpow:
            basis = "lp"
            con.execute(
                f"""
                CREATE OR REPLACE TABLE op_units AS
                SELECT TRY_CAST("{lref}" AS DOUBLE) AS ls_id,
                       CASE WHEN TRY_CAST(replace("{lpow}", ',', '.') AS DOUBLE) <= 22 THEN 'ac' ELSE 'dc' END AS typ
                FROM read_csv_auto('{lp_path.as_posix()}', all_varchar=true, header=true)
                WHERE TRY_CAST(replace("{lpow}", ',', '.') AS DOUBLE) > 0
                """
            )
    if basis is None and pm_path:
        basis = "ls"
        con.execute(
            f"""
            CREATE OR REPLACE TABLE op_units AS
            SELECT TRY_CAST(ladestation_id AS DOUBLE) AS ls_id,
                   CASE string_agg(DISTINCT lower(normalOderSchnellLadepunkt), '+' ORDER BY lower(normalOderSchnellLadepunkt))
                     WHEN 'normal' THEN 'ac' WHEN 'schnell' THEN 'dc' ELSE 'both' END AS typ
            FROM read_csv_auto('{pm_path.as_posix()}', delim=';', header=true, all_varchar=true)
            GROUP BY 1
            """
        )
    if basis is None:
        log("  Betreiber: weder df_lp noch df_pm vorhanden, übersprungen")
        return None
    rows = con.execute(
        """
        WITH j AS (SELECT m.okey, m.betreiber, u.typ FROM op_units u JOIN op_map m USING (ls_id)),
        names AS (SELECT okey, mode(betreiber) AS name FROM j GROUP BY 1)
        SELECT n.name, count(*) FILTER (typ = 'ac'), count(*) FILTER (typ = 'dc'), count(*) FILTER (typ = 'both'),
               count(*) AS total
        FROM j JOIN names n USING (okey) GROUP BY 1 ORDER BY total DESC
        """
    ).fetchall()
    total = sum(r[4] for r in rows)
    tot_types = [sum(r[i] for r in rows) for i in (1, 2, 3)]
    out = {
        "basis": basis,
        "units_label": "Ladepunkte" if basis == "lp" else "Ladestationen",
        "n_operators": len(rows),
        "total": total,
        "totals": {"ac": tot_types[0], "dc": tot_types[1], "both": tot_types[2]},
        "top10_share": r3(sum(r[4] for r in rows[:10]) / total) if total else None,
        "top": [[r[0], r[1], r[2], r[3]] for r in rows[:top]],
        "rest": [sum(r[i] for r in rows[top:]) for i in (1, 2, 3)],
    }
    log(f"  Betreiber: {len(rows):,} Betreiber, Basis {out['units_label']}")
    con.execute("DROP TABLE op_ls; DROP TABLE op_map; DROP TABLE op_units")
    return out

# --------------------------------------------------------------------------- Preismodelle


def profile_prices(con, path: Path) -> dict | None:
    """Ad-hoc-Preismodelle (df_pm.csv): Arbeitspreis in ct/kWh je Normal-/Schnellladepunkt.
    Momentaufnahme des gemeldeten Preismodells, keine Preishistorie."""
    log(f"Profiliere {path.name}")
    con.execute(
        f"CREATE OR REPLACE TABLE pm AS SELECT * FROM read_csv_auto('{path.as_posix()}', delim=';', "
        "header=true, all_varchar=true)"
    )
    cols = {r[0] for r in con.execute("DESCRIBE pm").fetchall()}
    need = {"normalOderSchnellLadepunkt", "gebuehrProArbeit", "gebuehrProArbeitEinheit", "kostenlos"}
    if not need <= cols:
        log(f"  df_pm: Spalten fehlen {need - cols}, übersprungen")
        return None
    num = lambda c: f"TRY_CAST(replace({c}, ',', '.') AS DOUBLE)"  # noqa: E731
    has = lambda c: f"COALESCE({num(c)}, 0) > 0" if c in cols else "FALSE"  # noqa: E731
    con.execute(
        f"""
        CREATE OR REPLACE TABLE pmc AS
        SELECT lower(trim(normalOderSchnellLadepunkt)) AS typ,
               -- offensichtliche Einheitenverwechslung korrigieren: "0,39 Cent" = 39 ct, "39 Euro" = 39 ct
               CASE
                 WHEN gebuehrProArbeitEinheit = 'Euro pro kWh' AND {num('gebuehrProArbeit')} > 5 THEN {num('gebuehrProArbeit')}
                 WHEN gebuehrProArbeitEinheit = 'Euro pro kWh' THEN {num('gebuehrProArbeit')} * 100
                 WHEN gebuehrProArbeitEinheit = 'Cent pro kWh' AND {num('gebuehrProArbeit')} < 2 THEN {num('gebuehrProArbeit')} * 100
                 WHEN gebuehrProArbeitEinheit = 'Cent pro kWh' THEN {num('gebuehrProArbeit')}
               END AS ct,
               COALESCE({num('kostenlos')}, 0) = 1 AS frei,
               {has('gebuehrProZeit')} AS zeit,
               {has('gebuehrProLadevorgang')} AS vorgang,
               {"year(TRY_CAST(kostenpflichtigSeit AS TIMESTAMP))" if "kostenpflichtigSeit" in cols else "NULL"} AS seit
        FROM pm WHERE normalOderSchnellLadepunkt IS NOT NULL
        """
    )
    edges = [i * 5 for i in range(0, 25)]  # 0..120 ct, letzter Bin = Überlauf
    out = {"rows": con.execute("SELECT count(*) FROM pmc").fetchone()[0], "edges": edges, "types": {}, "cohorts": {}}
    valid = "NOT frei AND ct > 0 AND ct <= 200"
    for typ, n, frei, zeit, vorgang, q in con.execute(
        f"""
        SELECT typ, count(*), avg(frei::INT), avg(zeit::INT), avg(vorgang::INT),
               quantile_cont(ct, [0.1, 0.25, 0.5, 0.75, 0.9]) FILTER ({valid})
        FROM pmc GROUP BY 1 ORDER BY 1
        """
    ).fetchall():
        hist = [0] * len(edges)
        for b, c in con.execute(
            f"SELECT LEAST(CAST(floor(ct / 5) AS INTEGER), {len(edges) - 1}), count(*) FROM pmc "
            f"WHERE typ = ? AND {valid} GROUP BY 1", [typ]
        ).fetchall():
            hist[b] += c
        out["types"][typ] = {
            "n": n, "free_share": r3(frei), "time_fee_share": r3(zeit), "session_fee_share": r3(vorgang),
            "q": [r3(x) for x in q] if q else None, "hist": hist,
        }
        out["cohorts"][typ] = [
            [y, c, [r3(x) for x in qq]] for y, c, qq in con.execute(
                f"SELECT seit, count(*), quantile_cont(ct, [0.1, 0.25, 0.5, 0.75, 0.9]) FROM pmc "
                f"WHERE typ = ? AND {valid} AND seit BETWEEN 2015 AND year(current_date) "
                "GROUP BY 1 HAVING count(*) >= 20 ORDER BY 1", [typ]
            ).fetchall()
        ]
    con.execute("DROP TABLE pm; DROP TABLE pmc")
    return out

# --------------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lv", type=Path, help="Pfad zu df_lv.csv (sonst Download nach data/raw)")
    ap.add_argument("--ls", type=Path, help="Pfad zu df_ls.csv")
    ap.add_argument("--lp", type=Path, help="Pfad zu df_lp.csv")
    ap.add_argument("--pm", type=Path, help="Pfad zu df_pm.csv (Ad-hoc-Preismodelle)")
    ap.add_argument("--no-lp", action="store_true", help="Ladepunkt-Stammdaten nicht verwenden")
    ap.add_argument("--no-download", action="store_true", help="Nichts herunterladen")
    ap.add_argument("--force-download", action="store_true")
    ap.add_argument("--start", default="2017-01-01", help="Frühester gültiger Ladebeginn")
    ap.add_argument("--end", default="auto",
                    help="Erster Tag nach dem Berichtszeitraum (Standard: aus den Daten ermittelt)")
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    ap.add_argument("--db", type=Path, default=ROOT / "data" / "work.duckdb",
                    help="DuckDB-Arbeitsdatei (auf Platte, damit 20 Mio. Zeilen nicht in den RAM müssen)")
    ap.add_argument("--demo", action="store_true", help="Ausgabe als Demodaten kennzeichnen")
    ap.add_argument("--map", action="append", default=[], metavar="ROLLE=SPALTE",
                    help="Stammdaten-Spalte manuell zuordnen, z. B. --map date=inbetriebnahme")
    args = ap.parse_args()

    def resolve(key: str, given: Path | None, optional: bool = False) -> Path | None:
        if given:
            return given
        dest = RAW_DIR / FILES[key]
        if args.no_download:
            return dest if dest.exists() else (None if optional else sys.exit(f"{dest} fehlt"))
        try:
            return download(FILES[key], dest, args.force_download)
        except Exception as exc:  # noqa: BLE001
            if optional:
                log(f"  {FILES[key]} übersprungen: {exc}")
                return None
            raise

    lv_path = resolve("lv", args.lv)
    ls_path = resolve("ls", args.ls, optional=True)
    lp_path = None if args.no_lp else resolve("lp", args.lp, optional=True)
    pm_path = resolve("pm", args.pm, optional=True)

    overrides = dict(kv.split("=", 1) for kv in args.map)

    args.db.parent.mkdir(parents=True, exist_ok=True)
    if args.db.exists():
        args.db.unlink()
    con = duckdb.connect(str(args.db))
    con.execute("SET preserve_insertion_order = false")
    con.execute("SET TimeZone = 'UTC'")  # Zeitstempel der Rohdaten sind ohne Zone, nichts umrechnen

    quality = load_lv(con, lv_path, args.start, args.end)
    rng = con.execute("SELECT min(month), max(month), count(DISTINCT lp), count(DISTINCT ls) FROM lvc").fetchone()

    log("Aggregiere Zeitreihen")
    grains = {g: series(con, g) for g in ("month", "quarter", "year")}
    log("Wochenprofil, Verteilungen, Ladepunkt-Ebene")
    week = week_profile(con)
    hist = histograms(con)
    lpl = lp_level(con)

    lage_vals = [r[0] for r in con.execute("SELECT lage, count(*) FROM lvc GROUP BY 1 ORDER BY 2 DESC").fetchall()]
    bl_vals = [r[0] for r in con.execute("SELECT bl FROM lvc WHERE bl IS NOT NULL GROUP BY 1 ORDER BY 1").fetchall()]

    master = {}
    if ls_path:
        master["ls"] = profile_master(con, ls_path, "ls", overrides)
    if lp_path:
        master["lp"] = profile_master(con, lp_path, "lp", overrides)
    prices = profile_prices(con, pm_path) if pm_path else None
    ops = operators(con, ls_path, pm_path, lp_path) if ls_path else None
    occ = occupancy(con)
    tops = top_points(con, prices)
    con.close()

    out = {
        "meta": {
            "generated": dt.datetime.now().isoformat(timespec="seconds"),
            "demo": args.demo,
            "source": SOURCE_NOTE,
            "source_url": "https://mobilithek.info/offers/714073450865197056",
            "range": [iso(rng[0]), iso(rng[1])],
            "lps_total": rng[2],
            "lss_total": rng[3],
            "rules": RULES,
            "quality": quality,
            "incomplete": incomplete_months(grains["month"]),
            "bundeslaender": bl_vals,
            "lagen": lage_vals,
            "median_note": "Quartile per t-digest (approx_quantile), Abweichung typischerweise < 1 %",
        },
        "classes": CLASSES,
        "series": {"cols": SERIES_COLS, **grains},
        "week": week,
        "hist": hist,
        "lp": lpl,
        "master": master,
        "prices": prices,
        "operators": ops,
        "occupancy": occ,
        "top_points": tops,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    log(f"Geschrieben: {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)")
    try:
        args.db.unlink()
    except OSError:
        pass


if __name__ == "__main__":
    main()
