# Email Process Agent (n8n)

Config-gesteuerter E-Mail-Prozess-Agent von **TIM Agent Systems**. Er liest ein Microsoft-365-Postfach mit, erkennt Anfragen, prüft Pflichtangaben, bereitet Rückfragen vor (Versand nur nach Freigabe durch einen Mitarbeiter), führt Antworten zusammen, fasst nach und eskaliert. Je Kunde gelten eigene Regeln, ohne Änderung an den Workflows.

- Plattform: n8n 2.43.x, Speicher n8n Data Tables
- KI: OpenAI, ohne Werkzeuge, nur strukturierte Ausgabe
- Microsoft 365: Outlook (Postfach), Teams (Meldungen, Freigabe-Links)

## Schnellstart
```bash
npm install
npm run check                                   # Workflows bauen, Strukturprüfung, Unit-Tests
N8N_URL=… N8N_API_KEY=… node tools/datatables-setup.js --prompts
N8N_URL=… N8N_API_KEY=… node tools/deploy.js
```
Danach Credentials zuweisen und in der richtigen Reihenfolge veröffentlichen: siehe [docs/Inbetriebnahme.md](docs/Inbetriebnahme.md).

## Dokumente
| Dokument | Inhalt |
|---|---|
| [Verkauf-Kurzbeschreibung](docs/Verkauf-Kurzbeschreibung.md) | Eine Seite für Interessenten, ohne Technik |
| [Architektur](docs/Architektur.md) | Workflows, Statusmodell, Sicherheitsprinzipien, Code-Organisation |
| [Inbetriebnahme](docs/Inbetriebnahme.md) | Setup Schritt für Schritt, Credentials, Reihenfolge, Abnahmetest |
| [Onboarding-Neukunde](docs/Onboarding-Neukunde.md) | Workshop-Fragen, Einrichtung, Checkliste, Datentrennung |
| [Betriebshandbuch](docs/Betriebshandbuch.md) | Routine, alle Meldungen mit Maßnahme, Notfall, Datenschutzanfragen |
| [Datenschutz-und-KI-Checkliste](docs/Datenschutz-und-KI-Checkliste.md) | DSGVO, EU AI Act, Microsoft-Rechte, offene Punkte |
| [Grenzen-und-Risiken](docs/Grenzen-und-Risiken.md) | Was das System nicht kann, was noch zu prüfen ist |
| [Testphase](docs/Testphase.md) | Drehbuch für die Tests mit den echten Diensten, KI-Prüfstand |
| [Abnahme-Testmatrix](docs/Abnahme-Testmatrix.md) | Anforderungen aus dem Auftrag ↔ Testfälle |
| [Testprotokoll-Gesamt](docs/Testprotokoll-Gesamt.md) | Ergebnis des letzten Gesamtlaufs (Details in Testprotokoll-M2 … M7) |
| [M0-Bauplan](docs/M0-Bauplan.md) | Ursprünglicher Bauplan und Entscheidungen |
| M1–M7-Berichte | Fortschritt je Meilenstein |
| [Instanz-timbaule](docs/Instanz-timbaule.md) | Stand in der Cloud-Instanz (IDs) |

## Ordner
| Ordner | Inhalt |
|---|---|
| `src/` | Fachlogik (rein, getestet), wird in die Code-Nodes eingebettet |
| `workflows-src/datatable/` | Workflow-Definitionen als Code |
| `workflows/` | erzeugte n8n-JSON-Dateien (nicht von Hand ändern, `npm run build`) |
| `prompts/v1/` | Systemprompts (Klassifizierung, Extraktion, Entwurf) |
| `config/` | Data-Table-Schema, Beispiel-Config, leere Vorlage, CSV-Vorlagen |
| `test/` | Unit-Tests (`npm test`) und Testmails |
| `tools/` | Build, Prüfung, Deploy, Setup, Import eigener KI-Testfälle (`testfaelle-import.js`), End-to-End-Tests mit Mock-KI und Mock-Graph |

## Grundregeln
1. Keine Mail an Kunden ohne Freigabe durch einen Menschen.
2. Keine Secrets im Repository; Zugangsdaten nur als n8n-Credentials.
3. Eingegangene Mails werden nie gelöscht.
4. Logs enthalten keine Mail-Inhalte.
5. Änderungen an Logik in `src/` bzw. `workflows-src/`, nie direkt in `workflows/`.
