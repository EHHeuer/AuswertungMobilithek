# Ladebilanz · Auswertung OBELISöffentlich

Dashboard zu den Ladevorgängen an geförderten öffentlichen Ladepunkten in Deutschland
(Datensatz *OBELISöffentlich* der NOW GmbH / Nationale Leitstelle Ladeinfrastruktur).

Live: https://ehheuer.github.io/AuswertungMobilithek/

Die mitgelieferte `web/data/obelis.json` ist aus den Originaldaten gebaut (Datenstand bis
Dezember 2025, 39,2 Mio. Ladevorgänge, 18.527 Stationen, 19.581 Preismodelle). Mit
`--demo` erzeugte Dateien zeigen oben ein Band "Demodaten".

## Schnellstart

```bash
pip install -r pipeline/requirements.txt

# 1. Daten laden und aggregieren (lädt df_lv.csv, df_ls.csv, df_lp.csv, df_pm.csv nach data/raw/)
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
| 10 Stammdaten | Stationskarte mit Zeitraffer, Inbetriebnahmen kumuliert, Bundesland, Förderprogramm, Betreiber nach AC/DC |
| 11 Preise | Ad-hoc-Arbeitspreise Normal/Schnell, Zeit- und Vorgangsgebühren, Kohorten nach "kostenpflichtig seit" (df_pm.csv) |
| 12 Methodik | Aussortierte Zeilen je Regel, Annahmen, Grenzen |

Globale Filter: Zeitraster (Monat/Quartal/Jahr), Median/Mittelwert, Ausschnitt (Bundesland oder
Lage), Leistungsklassen. Jede Karte hat eine Tabellenansicht, Hell- und Dunkelmodus.

## Methodik in Kürze

- **Leistungsklassen** nach `maxladeleistunginkilowatt` des Ladepunkts: ≤ 11, 12–22, 23–50,
  51–150, > 150 kW.
- **Plausibilisierung** (erste zutreffende Regel zählt, Grenzen in `pipeline/build.py`, `RULES`):
  Beginn 2017 bis Ende Berichtszeitraum (`--end`, Standard: automatisch aus den Daten), Dauer 1 min bis 48 h,
  Energie 0,1 bis 300 kWh, Nennleistung > 0 und ≤ 1 MW, mittlere Leistung ≤ 115 % der
  Nennleistung + 1 kW.
- **Quantile** per t-digest (`approx_quantile`), typisch < 1 % Abweichung.
- Zeiträume mit < 30 Vorgängen je Klasse werden nicht gezeichnet.

## Grenzen der Daten

- Die Preismodelle sind eine Momentaufnahme je Station, keine Preishistorie. Offensichtliche
  Einheitenfehler werden korrigiert ("Cent" unter 2 wird als Euro gelesen, "Euro" über 5 als Cent).
- Betreiber: Ohne `df_lp.csv` zählt die Auswertung **Stationen**, nicht Ladepunkte. AC/DC kommt aus
  dem Preismodell der Station (Normal- oder Schnellladepunkt). Mit `df_lp.csv` schaltet die Pipeline
  automatisch auf Ladepunkte um (AC bis 22 kW, DC darüber). Namen werden nur um Rechtsformen
  bereinigt, Konzerntöchter (z. B. mehrere EnBW-Gesellschaften) bleiben getrennt.
- In `df_ls.csv` ist `anschlussleistungInKilowatt` der Netzanschluss der Station und wird nicht als
  Ladeleistung verwendet. Förderprogramme liegen nur als ID vor (Namen stünden in `df_fp.csv`).

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

## Veröffentlichung

`.github/workflows/pages.yml` veröffentlicht `web/` bei jedem Push auf `main` (nur wenn sich
`web/` ändert) auf GitHub Pages. In den Repo-Einstellungen unter *Pages → Source* muss
"GitHub Actions" ausgewählt sein.
