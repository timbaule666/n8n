# Config-Driven Email Process Agent – Beschreibung (zum Weitergeben, z. B. an eine andere KI)

Stand: November 2026. Enthält keine Zugangsdaten, Links oder Kundendaten.

## Was der Agent ist
Ein KI-gestützter Agent auf **n8n (Cloud)**, der ein geschäftliches E-Mail-Postfach (Microsoft 365 / Outlook) bearbeitet. Er erkennt eingehende **Angebotsanfragen, Bestellungen und Terminanfragen**, liest die Angaben aus Mailtext und PDF-Anhängen aus, prüft sie auf Vollständigkeit, bereitet Rückfragen an den Kunden vor, ordnet Antworten zu und erinnert, wenn der Kunde nicht antwortet. **Keine Mail geht ohne Freigabe durch einen Mitarbeiter raus.** Alles Kundenspezifische (Pflichtfelder, Texte, Fristen, Vorgangsarten, Sprachen, Kalender) steht in einer Konfiguration – daher „Config-Driven“. Ein neuer Kunde braucht keinen neuen Code.

## Technik
- **Plattform:** n8n Cloud; Daten in n8n Data Tables (eine PostgreSQL-Variante existiert für den Kern).
- **KI:** OpenAI (gpt-4o-mini) über HTTP, drei Aufgaben: Klassifizierung, Datenextraktion, Entwurf der Rückfrage. Prompts sind versioniert (v1, v2, v3) mit Prüfsumme, je Kunde wählbar. Die KI hat **keine Werkzeuge** und kann nichts auslösen; Mailinhalte gelten als nicht vertrauenswürdig.
- **Microsoft 365:** Outlook über Microsoft Graph (Mails lesen, Antwortentwürfe, Senden, Kategorien, Kalender), Microsoft Teams für Meldungen und Freigabe-Links. Je Kunde eine eigene Postfach-Workflow-Kopie mit den Zugangsdaten aus dessen Microsoft-Konto.
- **Optional:** Google Sheets (Kunde pflegt Regeln selbst), Telegram (Alarm an den Betreiber, interne Tests), Gmail (nur Betreiber-Prüfpostfach für Zustelltests).
- **Code:** reine JavaScript-Module (src/) mit über 280 Unit-Tests; die Workflows werden daraus erzeugt und geprüft.

## Ablauf einer Mail
1. **Postfach (EPA-00):** holt jede Minute neue Mails, lädt Header und Anhänge, liest PDF-Text.
2. **Eingang (EPA-01):** Duplikat-/Newsletter-/Abwesenheitsfilter, Unzustellbarkeitsmeldungen erkennen, Zuordnung zu bestehenden Vorgängen (Antwort oder neue Anfrage), KI-Klassifizierung (welche Vorgangsart oder keine Anfrage), Datenextraktion, Pflichtfeldprüfung.
3. **Vollständig:** Status „Bereit zur Bearbeitung“, Meldung in Teams, Outlook-Kategorie. Bei Terminanfragen zusätzlich Kalenderprüfung.
4. **Lücken:** Rückfrage-Entwurf (EPA-02) im Outlook-Thread, Freigabe-Link an die Freigeber in Teams.
5. **Freigabe (EPA-07):** Mitarbeiter sieht den Entwurf, kann ihn freigeben und senden, bearbeiten oder ablehnen.
6. **Antwort des Kunden (EPA-03):** wird zugeordnet und ausgewertet, neue Angaben werden übernommen, Widersprüche/Stornierungen/Zusatzinfos gemeldet, ggf. nächste Rückfrage.
7. **Nachfassen (EPA-04):** Erinnerungen bei ausbleibender Antwort und bei offenen Freigaben, Eskalation nach der eingestellten Rundenzahl.

## Was der Agent fachlich kann
- **Angebotsanfragen** (beim Testkunden: Transportanfragen): Orte/PLZ, Datum, Gewicht (Tonnen → kg), Packstücke, Ladungsart, Kontakt; Widerspruch Mailtext ↔ PDF; zwei Daten als mehrdeutig; Telefonformat „+49 (0)“.
- **Bestellungen:** Ware/Leistung, Menge, Liefertermin, Lieferadresse, Bestellnummer, Kontakt.
- **Terminanfragen:** Anlass, Wunschtermin, Uhrzeit, Ort, Kontakt; **Kalenderprüfung** im Outlook-Kalender des Postfachs (frei/belegt, freie Zeiten bei „vormittags“ usw.), Eintragen erst nach Klick im Team (EPA-15).
- **Vorgangsarten frei konfigurierbar:** ein, zwei oder alle drei Bereiche je Kunde, weitere (z. B. Reklamation) über Konfiguration möglich.
- **Sprachen:** liest Mails in verschiedenen Sprachen; Rückfragen auf Deutsch und Englisch (Textbausteine je Sprache).
- **Wichtige Nicht-Anfragen** (Stornierung, Rückrufbitte, Statusfrage, nur Anhang) werden gemeldet statt ignoriert.
- **Unklare Mails werden nie gelöscht**, nur gemeldet oder (Newsletter etc.) archiviert.

## Überwachung und Betrieb
- **Watchdog (EPA-06):** prüft regelmäßig Postfach-Verbindung, Teams, KI-Dienst, hängende Vorgänge, Fehlerprotokoll und „Stille“ (zu lange keine Mail); meldet Störungen.
- **Error-Handler (EPA-05):** zentrale Fehlerbehandlung mit Fehlerklassen, Fehlerprotokoll ohne Mailinhalte, Vorgang sichern, Alarm.
- **Zustelltest (EPA-11):** Kontrollmail an ein Prüfpostfach; nach Unzustellbarkeit werden Rückfragen nach erfolgreichem Test erneut zur Freigabe gestellt.
- **Tagesübersicht (EPA-13)** und **Übersicht-Seite je Kunde (EPA-12)**; ein Betreiber-Dashboard (EPA-14) ist vorhanden, aber nicht aktiv.
- **Löschjob (EPA-08):** löscht Daten nach der Aufbewahrungsfrist – vorhanden, **noch nicht aktiv**.
- **Regeln aus Google Sheets (EPA-09/EPA-10, SW Regeln abgleichen):** Kunde ändert Pflichtfelder, Texte, Fristen im Sheet; der Agent übernimmt geprüfte Änderungen.
- **KI-Qualitäts-Prüfstand (EPA-T1):** testet Prompts gegen Testfälle ohne Nebenwirkungen.
- **Bausteine (Sub-Workflows):** Config laden (prüft die Konfiguration, harter Stopp bei Fehlern), LLM aufrufen, Vorgang verwalten, Status setzen (Statusmatrix), Audit schreiben, Benachrichtigen, Freigabe senden, Nachfassen, Outlook-Kategorie, Kalender prüfen.

## Daten (Data Tables)
Konfiguration allgemein und Pflichtfelder je Kunde, Vorgänge, verarbeitete Mails, Freigaben und Freigabe-Tokens, Audit-Log, Fehler-Log, Prompts, Systemstatus, Kalender-Termine.

## Sicherheit und Datenschutz
- Keine Mail ohne Freigabe; Freigabe-Links einmalig, mit Ablaufzeit, nur als Hash gespeichert, atomar übernommen (kein Doppelversand).
- Manipulationsschutz: KI-Verdacht plus Musterprüfung; starke Muster sperren, reiner KI-Verdacht nur als Hinweis.
- Keine personenbezogenen Daten in Logs; Ausführungen mit Links werden nicht gespeichert.
- Konfiguration wird bei jedem Lauf geprüft; fehlerhafte Konfiguration stoppt die Verarbeitung.
- Audit-Protokoll für Statuswechsel, Freigaben, Zuordnungen und Systemereignisse.

## Stand und Grenzen
- Am weitesten erprobt: Transport-Angebotsanfragen (Härtetest mit 121 Fällen, Nachtest 19/20 OK). Bestellung und Termin sind gebaut und live getestet, die Auswertung der Testrunde steht aus.
- Kalender: nur der Kalender des Postfachs; der Eintragen-Link steht im Teams-Kanal.
- Offen vor Pilotkunden: Löschjob aktivieren, Auftragsverarbeitungsvertrag/Datenschutz, Kontingent-/Pufferregel, Ablauf des 14-tägigen Testlaufs, allgemeine (nicht-transportbezogene) Angebotsvorlage.

## Pakete (Vorschlag, netto)
Basis 249 €/Monat + 2.490 € Einrichtung (150 Vorgänge), Business 549 € + 2.990 € (400 Vorgänge, Google Sheet, Englisch), Premium 949 € + 4.990 € (1.000 Vorgänge, bis 3 Postfächer), Individuell auf Anfrage. Alle Bereiche in jedem Paket, 14 Tage Testlauf.
