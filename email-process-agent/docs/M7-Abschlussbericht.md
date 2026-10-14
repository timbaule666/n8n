# M7-Abschlussbericht: Abnahme

Stand 2026-10-14. Config-Driven Email Process Agent für n8n 2.43.4, Speicher n8n Data Tables, KI OpenAI, Microsoft 365.

## 1. Lieferumfang gegen den Auftrag (Masterprompt Abschnitt 9)
| Nr. | Erwartet | Geliefert |
|---|---|---|
| 1 | Bauplan und Architekturübersicht (Mermaid) | `M0-Bauplan.md`, aktuell: `Architektur.md` (Workflows, Statusmodell, Sicherheitsprinzipien) |
| 2 | Alle Workflows inkl. Sub-Workflows, Error-Handler, Watchdog | 17 Workflows in `workflows/`: EPA-00 bis EPA-08 und 8 Sub-Workflows. In der Cloud-Instanz eingespielt und mit der Quelle abgeglichen (`Instanz-timbaule.md`). |
| 3 | Excel-Vorlagen für Vorgänge, Config, Audit (mit Beispieldaten) | **Abweichung (deine Entscheidung in M1):** n8n Data Tables statt Excel. Stattdessen gibt es das Schema `config/datatables/schema.json`, die Beispiel-Config `beispiel-transport.json`, die leere Vorlage `vorlage-leer.json` und CSV-Vorlagen in `config/vorlagen/` (leer und mit Beispieldaten). Das Setup-Skript legt alle Tabellen an. |
| 4 | Prompts versioniert, JS-Code als eigene Dateien mit Unit-Tests | `prompts/v1/` (in `epa_prompts` mit Prüfsumme), Fachlogik in `src/` (16 Module), 166 Unit-Tests |
| 5 | ≥ 25 Testmails und Testprotokoll | 36 Testmails (`test/daten/testmails.js`) und insgesamt 85 End-to-End-Szenarien, Protokolle `Testprotokoll-M2` bis `-M7`, `Testprotokoll-Gesamt.md`, `Abnahme-Testmatrix.md` |
| 6 | Inbetriebnahme-Anleitung, Credentials und Berechtigungen, Betriebshandbuch | `Inbetriebnahme.md`, `Onboarding-Neukunde.md`, `Betriebshandbuch.md`, Microsoft-Rechte in `Datenschutz-und-KI-Checkliste.md` Abschnitt 6 |
| 7 | Kundenfreundliche Kurzbeschreibung (1 Seite) und Liste bekannter Grenzen und offener Risiken | `Verkauf-Kurzbeschreibung.md`, `Grenzen-und-Risiken.md` |

Außerdem: `README.md` als Einstieg, `Datenschutz-und-KI-Checkliste.md` (DSGVO, EU AI Act).

## 2. Abnahmetest
| Prüfung | Ergebnis |
|---|---|
| Unit-Tests (`npm test`) | **166 bestanden**, 0 fehlgeschlagen, 1 übersprungen (braucht eine Test-Postgres) |
| Strukturprüfung (`tools/validate-workflows.js`) | 22 Workflow-Dateien ohne Befund (17 Data Tables, 5 Postgres-Variante M1), inklusive Härtungsregeln |
| End-to-End Gesamtlauf (`tools/e2e-eingang.js`) | **85 von 85** in einem Lauf: M2 36, M3 16, M4 9, M5 10, M6 10, M7 4 |
| End-to-End Fundament (`tools/e2e-test.js`) | 14 von 14 |

Neu in M7 sind vier Fehlerfälle aus Abschnitt 10 des Auftrags, die vorher nicht eigens abgedeckt waren. Alle bestanden beim ersten Lauf:
- G01: Graph nicht erreichbar → 3 Versuche, Fehlerlog 503, Mail bleibt unverarbeitet und wird danach normal verarbeitet
- G02: abgelaufenes Token → 401
- G03: KI-Timeout → 3 Versuche, 504, Vorgang gesichert
- G04: fehlender Textbaustein → 424, kein geratener Entwurf

**Wichtig:** KI und Microsoft-Schnittstellen sind in allen End-to-End-Tests simuliert. Geprüft ist die Verarbeitungskette, nicht die echte Modellqualität und nicht das genaue Verhalten der echten Microsoft-APIs.

## 3. Entscheidungen im Projektverlauf (Abweichungen vom Auftrag)
1. **Speicher:** n8n Data Tables statt Excel/SharePoint (auf deinen Wunsch). Concurrency über Versionsfeld und bedingte Updates, getestet. Die Postgres-Variante blieb auf dem Stand von M1.
2. **Freigabe Variante B:** persönlicher, einmaliger Link per Teams-1:1-Chat auf eine Freigabeseite (EPA-07) statt Adaptive Cards (die bräuchten einen Bot oder Power Automate).
3. **Erinnerungen ohne KI:** Feste Vorlage statt KI-Hülle. Sicherer und günstiger, und der Auftrag lässt das ausdrücklich zu.
4. **Statuswechsel erst nach Auswertung** einer Antwort (M4): Eine Vertröstung lässt den Vorgang unverändert.
5. **Löschjob nicht automatisch scharf:** EPA-08 wird erst nach einem Probelauf veröffentlicht.

## 4. Offene Punkte bis zum Produktivstart
**Von dir:**
1. Credentials zuweisen: OpenAI, Teams-Dienstkonto, Outlook je Postfach.
2. Teams-IDs nennen bzw. eintragen: Betriebskanal (EPA-05, EPA-06) und Kundenkanal (Config).
3. Config `beispiel-transport` ausfüllen oder den ersten echten Kunden nach `Onboarding-Neukunde.md` anlegen; EPA-00 je Postfach duplizieren.
4. Veröffentlichen in der Reihenfolge aus `Inbetriebnahme.md` Abschnitt 6.
5. Aufbewahrung der n8n-Ausführungsdaten einstellen, 2FA für alle n8n-Konten.
6. Rechtliches: AVV-Kette, Drittlandübermittlung OpenAI (oder EU-Anbieter), Wortlaut des KI-Hinweises.

**Gemeinsam (Testphase mit Testpostfach):**
1. Echte Microsoft-Pfade durchspielen: Entwurf, Versand, Gesendet-Suche, Entwurf löschen, Teams-Chats und Kanal.
2. 50–100 echte, anonymisierte Mails: Trefferquote der KI je Feld messen, Prompts ggf. als v2 nachschärfen.
3. EPA-08 Probelauf, danach veröffentlichen.
4. Repository privat schalten (das ist noch offen; das Repo ist öffentlich).

## 5. Empfohlene Erweiterungen (nicht im Umfang)
- Konflikte per Teams-Aktion klären (Wert übernehmen/verwerfen)
- OCR für gescannte PDFs, Virenscan-Anbindung
- Freigabe mit verifizierter Identität (Teams-Bot oder Power Automate)
- Postgres-Variante auf den aktuellen Stand bringen, wenn Volumen oder Mandantenzahl wachsen
- Kennzahlen-Dashboard (Durchlaufzeit, Rückfragequote, Trefferquote der KI)
