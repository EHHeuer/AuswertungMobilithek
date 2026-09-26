#!/usr/bin/env python3
"""
Erzeugt SYNTHETISCHE Demodaten im Schema von OBELISöffentlich, damit Pipeline und Dashboard
ohne Zugriff auf die Originaldateien getestet werden können.

Die Werte sind erfunden. Sie haben nur plausible Größenordnungen, damit die Diagramme etwas
zeigen. Für echte Aussagen immer `python pipeline/build.py` mit den Originaldaten laufen lassen.

  df_lv.csv  Schema belegt durch die offizielle Metadaten-Datei der NOW (10 Spalten, ';')
  df_ls.csv  Schema ANGENOMMEN (Originaldatei war beim Erstellen nicht erreichbar)
  df_lp.csv  Schema ANGENOMMEN
"""
from __future__ import annotations

import csv
import datetime as dt
import math
import random
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "demo"
rng = random.Random(20260926)

START = dt.date(2018, 7, 1)
END = dt.date(2025, 1, 1)
DAYS = (END - START).days

BL = {  # Gewicht ~ Größenordnung Bevölkerung; Mittelpunkt, Streuung
    "Nordrhein-Westfalen": (18, 51.45, 7.45, 0.9),
    "Bayern": (13, 48.9, 11.5, 1.2),
    "Baden-Württemberg": (11, 48.6, 9.0, 0.8),
    "Niedersachsen": (8, 52.7, 9.2, 1.1),
    "Hessen": (6.3, 50.55, 8.8, 0.6),
    "Rheinland-Pfalz": (4.1, 49.9, 7.4, 0.55),
    "Sachsen": (4.0, 51.05, 13.2, 0.55),
    "Berlin": (3.7, 52.51, 13.40, 0.12),
    "Schleswig-Holstein": (2.9, 54.2, 9.8, 0.45),
    "Brandenburg": (2.5, 52.4, 13.3, 0.7),
    "Sachsen-Anhalt": (2.1, 51.95, 11.7, 0.55),
    "Thüringen": (2.1, 50.9, 11.1, 0.45),
    "Hamburg": (1.9, 53.56, 10.0, 0.1),
    "Mecklenburg-Vorpommern": (1.6, 53.8, 12.5, 0.7),
    "Saarland": (1.0, 49.38, 6.95, 0.15),
    "Bremen": (0.7, 53.08, 8.8, 0.07),
}
LAGE = ["Öffentlicher Parkplatz", "Kundenparkplatz", "Parkhaus", "Park & Ride", "Sonstige",
        "Sonstige Tankstelle", "Tankstelle an einer Bundesautobahn"]
LAGE_W = {
    "ac": [44, 30, 10, 6, 8, 2, 0],
    "dc": [22, 38, 4, 2, 6, 18, 10],
    "hpc": [8, 30, 1, 1, 4, 26, 30],
}

# (Anteil der Ladepunkte, Nennleistungen, Gruppe)
LP_TYPES = [
    (0.05, [3.7, 11], "ac"),
    (0.66, [22], "ac"),
    (0.13, [43, 50], "dc"),
    (0.10, [75, 100, 150], "dc"),
    (0.06, [300, 350], "hpc"),
]


def pick(weights):
    return rng.choices(range(len(weights)), weights=weights)[0]


def hour_weights(group):
    if group == "ac":
        base = [1, .6, .4, .3, .3, .6, 2, 5, 8, 7, 6, 6, 6, 6, 6, 7, 8, 9, 8, 6, 4, 3, 2, 1.5]
    else:
        base = [1, .6, .4, .3, .3, .5, 1.5, 3, 5, 6, 7, 8, 9, 9, 9, 9, 9, 9, 8, 6, 4.5, 3, 2, 1.4]
    return base


def lognorm(median, sigma):
    return median * math.exp(rng.gauss(0, sigma))


def make_lps(n):
    lps = []
    for i in range(n):
        t = pick([x[0] for x in LP_TYPES])
        share, kws, group = LP_TYPES[t]
        kw = rng.choice(kws)
        # Inbetriebnahme: Förderwellen, DC/HPC eher später
        bias = {0: 0.35, 1: 0.35, 2: 0.45, 3: 0.55, 4: 0.72}[t]
        pos = min(0.97, max(0.0, rng.gauss(bias, 0.22)))
        start = START + dt.timedelta(days=int(pos * DAYS * 0.95))
        stop = END
        if rng.random() < 0.10:  # meldet irgendwann nicht mehr
            stop = start + dt.timedelta(days=rng.randint(200, 1200))
        bl = rng.choices(list(BL), weights=[v[0] for v in BL.values()])[0]
        lage = LAGE[pick(LAGE_W[group])]
        lps.append({"id": i, "kw": kw, "group": group, "type": t, "start": start, "stop": min(stop, END),
                    "bl": bl, "lage": lage})
    return lps


def sessions_for(lp, writer, counter, ls_id):
    group, kw = lp["group"], lp["kw"]
    hw = hour_weights(group)
    popularity = lognorm(1.0, 0.55)
    skip_halves = {h for h in range(14) if rng.random() < 0.08}
    d = lp["start"]
    while d < lp["stop"]:
        half = (d.year - 2018) * 2 + (0 if d.month <= 6 else 1)
        if half in skip_halves:
            d += dt.timedelta(days=1)
            continue
        yrs = (d - START).days / 365.25
        season = 1 + 0.12 * math.cos((d.timetuple().tm_yday - 200) / 365.25 * 2 * math.pi)
        if group == "ac":
            rate = (0.35 + 0.09 * yrs) * popularity
        elif group == "dc":
            rate = (0.9 + 0.35 * yrs) * popularity
        else:
            rate = (1.6 + 0.55 * yrs) * popularity
        rate *= 0.55 * (0.8 if d.weekday() == 6 else 1)
        k = 0
        lam = rate * season
        # Poisson
        L, p = math.exp(-lam), 1.0
        while True:
            p *= rng.random()
            if p <= L:
                break
            k += 1
        for _ in range(k):
            hod = rng.choices(range(24), weights=hw)[0]
            begin = dt.datetime.combine(d, dt.time(hod, rng.randint(0, 59), rng.randint(0, 59)))
            if group == "ac":
                e = lognorm(9.5 + 0.55 * yrs, 0.6)
                pavg = min(kw, 11) * rng.uniform(0.35, 0.85)
                sec = e / pavg * 3600
                if rng.random() < 0.35:  # Standzeit nach Ladeende
                    sec += lognorm(2.5, 0.8) * 3600
            else:
                e = lognorm((17 if kw <= 50 else 24 if kw <= 150 else 29) + 1.3 * yrs, 0.5)
                cap = kw if kw <= 50 else min(kw, 60 + 9 * yrs + (40 if kw > 150 else 0))
                pavg = cap * rng.uniform(0.45, 0.8)
                sec = e / pavg * 3600 + rng.uniform(60, 400)
            sec = max(30, sec)
            end = begin + dt.timedelta(seconds=sec)
            counter[0] += 1
            row = [counter[0], begin.strftime("%Y-%m-%d %H:%M:%S"), end.strftime("%Y-%m-%d %H:%M:%S"),
                   float(round(sec)), float(round(e * 1000)), f"{lp['id'] + 1}_shuffled", f"{ls_id}_shuffled",
                   lp["bl"], lp["lage"], float(kw)]
            # Messfehler wie im Original
            r = rng.random()
            if r < 0.004:
                row[4] = float(rng.choice([-2093973000, 0, 12, 3265396736]))
            elif r < 0.007:
                row[1] = "1809-04-12 07:20:18"
            elif r < 0.009:
                row[9] = float(rng.choice([0, 400555.0]))
            elif r < 0.012:
                row[3] = float(rng.choice([5, 400000]))
            elif r < 0.013:
                row[2] = ""
            writer.writerow(row)
        d += dt.timedelta(days=1)


def jitter_coord(bl):
    _, lat, lon, s = BL[bl]
    return round(lat + rng.gauss(0, s * 0.55), 5), round(lon + rng.gauss(0, s * 0.85), 5)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    lps = make_lps(620)
    # Ladestationen der Ladevorgänge (ls_id gemischt, 1-4 LP je Station)
    counter = [0]
    with open(OUT / "df_lv.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["lv_id", "beginn", "ende", "dauer_sekunden", "energie_wh", "lp_id", "ls_id",
                    "bundesland", "lage", "maxladeleistunginkilowatt"])
        for lp in lps:
            sessions_for(lp, w, counter, ls_id=lp["id"] // 2 + 1)
    print(f"df_lv.csv: {counter[0]:,} Ladevorgänge")

    # Stammdaten (eigene, größere Grundgesamtheit, nicht verknüpfbar mit df_lv)
    stations = []
    lp_rows = []
    lp_id = 0
    for s in range(1, 2401):
        t = pick([x[0] for x in LP_TYPES])
        _, kws, group = LP_TYPES[t]
        kw = rng.choice(kws)
        bias = {0: 0.35, 1: 0.35, 2: 0.45, 3: 0.55, 4: 0.72}[t]
        pos = min(0.99, max(0.0, rng.gauss(bias, 0.22)))
        day = dt.date(2017, 3, 1) + dt.timedelta(days=int(pos * (dt.date(2025, 6, 30) - dt.date(2017, 3, 1)).days))
        bl = rng.choices(list(BL), weights=[v[0] for v in BL.values()])[0]
        lat, lon = jitter_coord(bl)
        n_lp = 2 if group == "ac" else rng.choice([1, 2, 2, 4])
        prog = rng.choices(["Bundesprogramm LIS 2017-2020", "Bundesprogramm LIS 2021-2025",
                            "Ladeinfrastruktur vor Ort", "Landesprogramm"], weights=[5, 3, 1.5, 1.2])[0]
        stations.append([s, day.isoformat(), bl, LAGE[pick(LAGE_W[group])], n_lp, lat, lon, prog])
        for _ in range(n_lp):
            lp_id += 1
            lp_rows.append([lp_id, s, float(kw), day.isoformat()])
    with open(OUT / "df_ls.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["ls_id", "inbetriebnahmedatum", "bundesland", "lage", "anzahl_ladepunkte",
                    "breitengrad", "laengengrad", "foerderprogramm"])
        w.writerows(stations)
    with open(OUT / "df_lp.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, delimiter=";")
        w.writerow(["lp_id", "ls_id", "maxladeleistunginkilowatt", "inbetriebnahmedatum"])
        w.writerows(lp_rows)
    print(f"df_ls.csv: {len(stations):,} Stationen, df_lp.csv: {len(lp_rows):,} Ladepunkte")


if __name__ == "__main__":
    main()
