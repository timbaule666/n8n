# Testprotokoll Gesamtlauf (Abnahme)

Stand 2026-10-14. Lokale n8n-Instanz 2.43.4, Data Tables, Mock-LLM und Mock-Graph. Erzeugt von `tools/e2e-eingang.js` in einem Lauf.

| Teil | bestanden | gesamt |
|---|---|---|
| M2 | 36 | 36 |
| M3 | 16 | 16 |
| M4 | 9 | 9 |
| M5 | 10 | 10 |
| M6 | 10 | 10 |
| M7 | 4 | 4 |
| **Summe** | **85** | **85** |

Alle Szenarien bestanden.

Einzelheiten je Teil in `Testprotokoll-M2.md` bis `Testprotokoll-M7.md`.

## Wiederholung nach der Testphase (2026-10-14)
Nach den Änderungen aus Stufe 1 (Auswahlfelder tolerant, Regel `person`) wurden alle Szenarien lokal erneut ausgeführt, in zwei Teilen (T/F/A/N01–N06, danach N/G/Q/W/L/H). Ergebnis: **86 von 86 bestanden**, also 85 plus Q01 (KI-Prüfstand).

Q01 schlug beim ersten Versuch fehl. Ursache war ein Fehler im Test, nicht im Produkt: Der Test zählte die Ergebnisse früherer Läufe mit derselben `lauf_id` mit. Der Test entfernt diese Zeilen jetzt vorher.
