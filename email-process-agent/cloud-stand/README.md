# Cloud-Stand vom 15.11.2026

Abzug aller laufenden Workflows des Email Process Agent aus n8n Cloud (Projekt des Testkunden epa-m365), Stand
15.11.2026 nach den Live-Tests. 35 Workflows, jeweils mit Knoten, Verbindungen und Einstellungen.

**Nicht enthalten:** Zugangsdaten (n8n speichert in Workflows nur die Credential-IDs, keine Passwörter oder Tokens),
Ausführungsdaten, Testdaten (pinData) und interne Zwischenstände (staticData). Die einzige persönliche Adresse
(Prüfadresse des Zustelltests in EPA-11) ist durch einen Platzhalter ersetzt. Die Hilfs-Workflows „EPA-TEST …“ sind
nicht exportiert.

**Wofür:** Sicherung und Nachweis, was tatsächlich läuft. **Quelle der Wahrheit bleibt der Bauplan**
(`workflows-src/` → `npm run build` → `workflows/`). Diese Dateien werden nicht gebaut und nicht deployt.

## Vergleich mit dem Bauplan (`workflows/`)

Verglichen wurden alle Knoten, ihr Code und ihre Parameter.

**Ergebnis: In der Cloud gibt es keine Logik, die im Repo fehlt.** Die Unterschiede sind:

| Art | Bedeutung | Workflows |
|---|---|---|
| Gleich | identisch | SW Audit schreiben, SW Benachrichtigen, SW Config laden, SW Freigabe-Karte, SW LLM aufrufen, SW Log-Karte, EPA-01, EPA-02, EPA-06, EPA-08, EPA-16, EPA-T2 |
| Workflow-IDs | Im Repo stehen Platzhalter `EPA_REF:<Name>`, in der Cloud die echten IDs (gewollt) | u. a. SW Freigabe senden, SW Status setzen, SW Regeln abgleichen, EPA-01/02/05/09/16 |
| Ältere eingebettete Bausteine | Die Cloud enthält eine ältere Kopie gemeinsamer Module (z. B. `freigabe`, `kanaele`, `fristen`); die Knotenlogik selbst ist gleich. Die betroffenen Teile werden dort nicht gebraucht, das Verhalten ist gleich. | SW Kalender prüfen, SW Nachfassen, SW Teams einrichten, EPA-03, EPA-04, EPA-07, EPA-10, EPA-12, EPA-13, EPA-14, EPA-15 |
| Nur Formatierung | Zeilenumbrüche/Kommentarkopf im Code | SW PLZ nachschlagen, SW Vorgang verwalten |
| Eingetragene Werte | In der Cloud gesetzt statt Platzhalter (gewollt) | EPA-11 (Prüfadresse), SW Teams einrichten (Kunde) |
| **Veraltet** | **EPA-00 Postfach (Vorlage) in der Cloud hat 67 statt 86 Knoten**: es fehlen u. a. Kanal-Karte ändern/entfernen/lesen, Kalender lesen/eintragen. Die Kopie des Testkunden (EPA-00 Postfach demo@…) ist aktuell. | EPA-00 Postfach (Vorlage) |
| Nur in der Cloud | Kundenkopie bzw. Test-Helfer, gehört nicht in den Bauplan | EPA-00 Postfach demo@tb-agenttest.de (Test), EPA-T4 Nachfass-Test (Test) |
| Nur im Repo | nie in die Cloud übertragen | EPA-T1 KI-Qualität prüfen |

**Wichtig für den nächsten Kunden:** Die Postfach-Kopie nicht aus der veralteten Cloud-Vorlage duplizieren, sondern
aus `workflows/EPA-00_Postfach_Vorlage.json` (oder die Vorlage in der Cloud vorher aus dem Repo aktualisieren).
