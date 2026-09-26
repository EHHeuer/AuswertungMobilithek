# Ladebilanz · Auswertung OBELISöffentlich

Dashboard zu den Ladevorgängen an geförderten öffentlichen Ladepunkten in Deutschland
(Datensatz *OBELISöffentlich* der NOW GmbH / Nationale Leitstelle Ladeinfrastruktur).

**Wichtig:** Die mitgelieferte `web/data/obelis.json` enthält **synthetische Demodaten** im
Originalschema. Die Originaldateien waren beim Erstellen aus der Build-Umgebung nicht abrufbar
(CloudFront blockt Zugriffe aus manchen Regionen). Die Seite zeigt dann oben ein Band
"Demodaten". Für echte Zahlen einmal lokal die Pipeline laufen lassen (siehe unten).

## Schnellstart

```bash
pip install -r pipeline/requirements.txt

# 1. Echte Daten laden und aggregieren (lädt df_lv.csv, df_ls.csv, df_lp.csv nach data/raw/)
python pipeline/build.py

# 2. Dashboard ansehen
python -m http.server 8000 -d web
# -> http://localhost:8000
```

Laufzeit mit ca. 25 Mio. Ladevorgängen: wenige Minuten (DuckDB, arbeitet auf Platte).
Schlägt der Download fehl, die Dateien im Browser herunterladen und übergeben:

```bash
python pipeline/build.py --lv ~/Downloads/df_lv.csv --ls ~/Downloads/df_ls.csv --lp ~/Downloads/df_lp.csv
```

Demodaten neu erzeugen: `python pipeline/make_demo.py && python pipeline/build.py --no-download --demo --lv data/demo/df_lv.csv --ls data/demo/df_ls.csv --lp data/demo/df_lp.csv`

## Was das Dashboard zeigt

| Abschnitt | Frage |
|---|---|
| 01 Energie | Wie entwickelt sich die Energie je Ladevorgang, nach Leistungsklasse? (Median/Mittelwert, IQR-Band bei Einzelklasse, optional Gesamtlinie für den Mix-Effekt) |
| 02 Dauer | Wie lange dauern Ladevorgänge (inkl. Standzeit)? |
| 03 Leistung | Effektive Leistung = Energie / Dauer, und Ausnutzung der Nennleistung |
| 04 Ladepunkte | Wie viele Ladepunkte melden je Zeitraum? Neu meldende Punkte, Meldequote ggü. Stammdaten |
| 05 Auslastung | Vorgänge und kWh je Ladepunkt und Tag, Streuung (P10 bis P90), Lorenzkurve und Gini |
| 06 Mix | Anteil der Energie nach Leistungsklasse |
| 07 Rhythmus | Heatmap Wochentag × Startstunde (Starts, Dauer, Energie) |
| 08 Verteilungen | Ridgeline je Jahr für Energie, Dauer, Leistung |
| 09 Regionen | Kachelkarte und Rangfolge der Bundesländer, Profil nach Lage |
| 10 Stammdaten | Stationskarte mit Zeitraffer, Inbetriebnahmen kumuliert, Bundesland, Förderprogramm |
| 11 Methodik | Aussortierte Zeilen je Regel, Annahmen, Grenzen |

Globale Filter: Zeitraster (Monat/Quartal/Jahr), Median/Mittelwert, Ausschnitt (Bundesland oder
Lage), Leistungsklassen. Jede Karte hat eine Tabellenansicht, Hell- und Dunkelmodus.

## Methodik in Kürze

- **Leistungsklassen** nach `maxladeleistunginkilowatt` des Ladepunkts: ≤ 11, 12–22, 23–50,
  51–150, > 150 kW.
- **Plausibilisierung** (erste zutreffende Regel zählt, Grenzen in `pipeline/build.py`, `RULES`):
  Beginn 2017 bis Ende Berichtszeitraum (`--end`, Standard 2025-01-01), Dauer 1 min bis 48 h,
  Energie 0,1 bis 300 kWh, Nennleistung > 0 und ≤ 1 MW, mittlere Leistung ≤ 115 % der
  Nennleistung + 1 kW.
- **Quantile** per t-digest (`approx_quantile`), typisch < 1 % Abweichung.
- Zeiträume mit < 30 Vorgängen je Klasse werden nicht gezeichnet.

## Grenzen der Daten

- Die IDs in `df_lv.csv` sind zufällig neu vergeben (`_shuffled`). **Ladevorgänge lassen sich nicht
  mit den Stammdaten verknüpfen.** Die Stammdaten stehen deshalb als eigene Sicht daneben.
- Nur geförderte Ladepunkte mit Berichtspflicht, halbjährliche Meldung. Zählwerte (Anzahl Vorgänge,
  meldende Punkte) hängen an der Meldedisziplin, Kennzahlen je Vorgang deutlich weniger.
- Zeitzone der Zeitstempel ist nicht dokumentiert.
- Das Schema von `df_lv.csv` ist durch die offizielle Metadaten-Datei belegt. Die Spalten von
  `df_ls.csv` / `df_lp.csv` werden **automatisch über Namensmuster erkannt** (Inbetriebnahme,
  Bundesland, Lage, Leistung, Koordinaten, Förderprogramm). Das Log zeigt die Zuordnung; bei
  Bedarf korrigieren mit z. B. `--map date=inbetriebnahme_datum --map lat=breitengrad`.

## Aufbau

```
pipeline/build.py      Rohdaten -> web/data/obelis.json (DuckDB)
pipeline/make_demo.py  synthetische Testdaten im Originalschema
web/index.html         statische Seite, kein Build-Schritt
web/js/charts.js       eigene SVG-Diagramme (Linie, Fläche, Säulen, Heatmap, Ridgeline, Lorenz, Kacheln)
web/js/app.js          Datenaufbereitung, Filter, Karten
web/css/style.css      Layout und Farb-Tokens (hell/dunkel)
```

Die Farben der Leistungsklassen sind auf Unterscheidbarkeit bei Farbfehlsichtigkeit geprüft
(hell und dunkel getrennt).

## Quelle und Lizenz der Daten

"OBELISöffentlich: Stamm- und Betriebsdaten geförderter öffentlich zugänglicher Ladestationen für
Elektrofahrzeuge" / NOW GmbH (Nationale Leitstelle Ladeinfrastruktur), Lizenz
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/),
[Mobilithek](https://mobilithek.info/offers/714073450865197056). Bei Weitergabe von Auswertungen
diese Quellenangabe mit Jahr des Datenbezugs nennen.
