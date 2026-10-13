# M1-Bericht: Fundament

Stand 2026-10-13. Zielversion n8n 2.43.4, PostgreSQL ≥ 13.

## Fertig
| Bereich | Ergebnis |
|---|---|
| Datenmodell | `config/sql/001_schema.sql`: Config-Tabellen, Vorgänge (Status-CHECK, Version, Lock, Löschfrist), Dedupe-Tabelle, Freigaben (nur Token-Hash), append-only Audit-Log (per Trigger erzwungen), Fehlerlog, Systemstatus, Prompt-Registry, kollisionsfreie Vorgangs-ID `V-JJJJ-NNNN` |
| Configs | Beispiel „Transportanfrage“ (10 Felder) und leere Vorlage für neue Kunden (`002`, `003`) |
| Kernmodule (`src/`) | `statusMatrix` (Übergänge inkl. erlaubter Auslöser), `fehlerklassen` (Statuscode-Mapping, Bereinigung personenbezogener Daten, Eskalationsregel), `fristen` (Zeitzone, Geschäftszeiten, Feiertage aller 16 Bundesländer, Zeitumstellung), `configValidator` (harter Abbruch bei jeder Lücke) |
| Sub-Workflows | `EPA SW Config laden`, `EPA SW Audit schreiben`, `EPA SW Status setzen`, `EPA SW Vorgang verwalten` (lesen, anlegen, aktualisieren, Kandidaten suchen, sperren, entsperren) |
| Error-Handler | `EPA-05 Error-Handler`: Fehler klassifizieren, ins Fehlerlog schreiben, Vorgang auf „Eskaliert / Manuell“ sichern (nicht bei Versionskonflikt, Sperre, Duplikat), Teams-Alarm, Alarmstatus vermerken |
| Werkzeuge | `npm run build` (bettet Module und SQL in die Workflows ein), `validate-workflows`, `deploy.js` (Public API, verknüpft und veröffentlicht), `e2e-test.js` |
| Doku | `docs/Inbetriebnahme-M1.md` |

## Getestet
1. **69 Unit- und Integrationstests** (`npm test`, davon 14 gegen echtes PostgreSQL 16). Sie prüfen die Statusmatrix, Fehlerklassen, Fristen und Feiertage, den Config-Validator und das Deploy-Skript. Außerdem jede SQL-Abfrage mit genau dem Parameterweg des Postgres-Nodes (pg-promise 11.9.1, wie in n8n-nodes-base 2.43.2). Dazu kommen die Code-Nodes aus den gebauten Workflow-JSONs, Mandantentrennung, SQL-Injection und parallele ID-Vergabe.
2. **End-to-End in einer lokalen n8n-2.43.4-Instanz** mit Postgres: Deploy-Skript (Erstanlage und Update), Veröffentlichen, Error-Workflow-Verknüpfung und 12 Szenarien:

| Szenario | erwartet | tatsächlich | bestanden |
|---|---|---|---|
| Config laden (gültige Config) | config mit Vorgangstyp transport | 10 Felder, Frist 48 h | ja |
| Config laden (unbekannter Kunde) | Abbruch 404 + Fehlerlog-Eintrag | HTTP 500, Fehlerlog 404 KONFIG_NICHT_GEFUNDEN (Node Config validieren) | ja |
| Vorgang anlegen | Status Neu, ID V-JJJJ-NNNN | V-2026-0001 (Neu) | ja |
| Status setzen erlaubt (Neu -> In Prüfung, KI) | ok, Version 2, Audit | ok, Version 2, Audit 2 | ja |
| Vorgang aktualisieren mit falscher Version | 409 VERSIONSKONFLIKT | HTTP 500, Fehlerlog 409 VERSIONSKONFLIKT, Vorgang unverändert („In Prüfung“) | ja |
| Vorgang aktualisieren korrekt | Version 3, Status unverändert | Version 3, 2 Message-IDs | ja |
| Kandidaten suchen | Vorgang wird über Message-ID gefunden | 1 Kandidat | ja |
| Sperren | zweiter Inhaber bekommt keine Sperre | A gesperrt, B abgewiesen, A entsperrt | ja |
| Audit schreiben | Eintrag angelegt | Audit 4 | ja |
| Unzulässiger Statuswechsel (In Prüfung -> Abgeschlossen) | 409, Fehlerlog, Vorgang auf Eskaliert / Manuell | HTTP 500, Fehlerlog 409, Status „Eskaliert / Manuell“, Audit-Auslöser System | ja |
| Status setzen nur_wenn_erlaubt bei unzulässigem Übergang | übersprungen, kein Fehler | übersprungen (UNZULAESSIGER_STATUSWECHSEL) | ja |
| Fehlerlog ohne Mail-Inhalte, Alarmstatus | nur IDs/Codes | 3 Einträge, 0 alarmiert, 1 mit Eskalation | ja |

„0 alarmiert“ ist erwartet: Lokal gab es nur einen Teams-Dummy-Zugang. Die Ausführungen von EPA-05 laufen bis „Entwickler-Kanal alarmieren“ und scheitern erst dort („Unable to sign without access token“). Alle vorherigen Schritte sind erfolgreich.

## Durch die Tests gefundene und behobene Fehler
1. Der E-Mail-Check akzeptierte Platzhalter wie `<freigeber@ihre-domain.de>`. Eine nicht ausgefüllte Config wäre durchgerutscht. → strengere Prüfung.
2. Ein Versionskonflikt hat den Vorgang eskaliert. Damit wäre eine parallel laufende, korrekte Verarbeitung gestört worden. → bei Konflikt, Sperre und Duplikat keine Eskalation.
3. Die Eskalation wurde nur vermerkt, wenn Teams erreichbar war. → wird jetzt unabhängig davon vermerkt.
4. n8n-2.x-Verhalten, das im Deploy berücksichtigt ist:
   - Ein Error Workflow muss veröffentlicht sein.
   - Veröffentlichen geht nur mit zugewiesenen Credentials.
   - Ein veröffentlichter Workflow lässt sich nicht mit einem neuen Node ohne Credential aktualisieren.
   - Die Teams-Team-ID muss eine GUID sein.

## Offen / zu verifizieren
- Live-Test in **deiner** Cloud-Instanz steht aus. Dafür brauche ich einen API-Key oder den autorisierten n8n-MCP-Connector, eine Test-Datenbank und das Teams-Dienstkonto.
- Erreichbarkeit der Postgres-Datenbank aus n8n Cloud (Firewall, TLS).
- Pruning der Ausführungsdaten im Cloud-Tarif.
- Fragen F7–F12 aus dem Bauplan laufen bis zu deinem Einspruch mit meinen Defaults (Transport-Felder, „Sie“, Mo–Fr 8–17 Uhr NRW, OCR über Azure, Freigeber-Liste, Ablage in diesem Repo).

## Hinweise für M2
- Retries: Lesende DB- und Netzwerk-Nodes wiederholen 3× mit 3 s Abstand. Schreibende, nicht idempotente DB-Nodes wiederholen bewusst nicht, ein Fehler geht an EPA-05. Für Graph und OpenAI in M2 baue ich eine Retry-Logik, die 429 und 5xx unterscheidet.
- Fehlermeldungen tragen ein Suffix wie „[line 42]“ aus dem Code-Node. Die Erkennung des EPA-Codes ist dagegen robust.
