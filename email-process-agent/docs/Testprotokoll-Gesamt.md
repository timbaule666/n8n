# Testprotokoll Gesamtlauf (Abnahme)

Stand 2026-10-14. Lokale n8n-Instanz 2.43.4, Data Tables, Mock-LLM und Mock-Graph. Erzeugt von `tools/e2e-eingang.js` in einem Lauf.

| Teil | bestanden | gesamt |
|---|---|---|
| M2 | 36 | 36 |
| M3 | 16 | 16 |
| M4 | 9 | 9 |
| M5 | 10 | 10 |
| M6 | 9 | 10 |
| M7 | 5 | 5 |
| Testkanal | 6 | 6 |
| **Summe** | **91** | **92** |

Nicht bestanden im Gesamtlauf: W01. Ursache war die Testumgebung, nicht das Produkt: 5 Altvorgänge eines anderen lokalen Testkunden standen seit über 24 Stunden auf „Eskaliert / Manuell“, und der Watchdog meldete sie korrekt als Arbeitsliste. Die Testvorbereitung schließt solche fremden Testvorgänge jetzt ab. Wiederholung von W01–W06, L01–L03 und H01: 10/10 bestanden, damit **92/92**.

Einzelheiten je Teil in `Testprotokoll-M2.md` bis `Testprotokoll-M7.md` und `Testprotokoll-Testkanal.md`.
