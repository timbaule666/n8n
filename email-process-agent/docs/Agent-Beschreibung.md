# Config-Driven Email Process Agent – ausführliche Beschreibung (zum Weitergeben, z. B. an eine andere KI)

Stand: 10. November 2026. Enthält keine Zugangsdaten, Links, IDs oder Kundendaten.

---

## 1. Was der Agent ist (Kurzfassung)

Ein KI-gestützter Agent auf **n8n Cloud**, der ein geschäftliches E-Mail-Postfach (**Microsoft 365 / Outlook**) bearbeitet. Er nimmt dem Innendienst die Vorarbeit bei eingehenden Kundenanfragen ab:

1. erkennt, **was** eine Mail ist (Angebotsanfrage, Bestellung, Terminanfrage, Reklamation – oder keine Anfrage),
2. liest die nötigen **Angaben** aus Mailtext und PDF-Anhängen aus,
3. prüft, ob alle **Pflichtangaben** vollständig und plausibel sind,
4. meldet vollständige Vorgänge im Microsoft-Teams-Kanal zur Bearbeitung,
5. bereitet bei fehlenden oder widersprüchlichen Angaben eine **Rückfrage an den Kunden** vor – die erst nach **Freigabe durch einen Mitarbeiter** rausgeht,
6. ordnet die **Antwort des Kunden** dem Vorgang zu, übernimmt neue Angaben und fragt ggf. erneut nach,
7. **erinnert** den Kunden und die Freigeber, wenn nichts passiert, und **eskaliert** nach einer festen Rundenzahl an einen Menschen.

Grundsätze:
- **Keine Mail geht ohne menschliche Freigabe raus.**
- **Keine Mail wird gelöscht.** Unklares wird gemeldet, Newsletter u. Ä. höchstens archiviert.
- **Config-Driven:** Alles Kundenspezifische (Vorgangsarten, Pflichtfelder, Textbausteine, Fristen, Sprachen, Teams-Kanäle, Kalender, Freigeber) steht in einer Konfiguration. Ein neuer Kunde braucht keinen neuen Code.
- Der Agent bearbeitet die Vorarbeit; **fachliche Entscheidungen** (Preis, Zusage, Ersatz, Gutschrift, Stornierung) trifft immer ein Mitarbeiter.

---

## 2. Technik

| Bereich | Umsetzung |
|---|---|
| Plattform | n8n Cloud, Workflows + Sub-Workflows |
| Datenhaltung | n8n Data Tables (eine PostgreSQL-Variante existiert für den Kern) |
| KI | OpenAI gpt-4o-mini über HTTP; Temperatur 0 für Klassifizierung und Extraktion, 0,2 für Entwürfe; Timeouts und Token-Limits je Aufgabe in der Config |
| Postfach | Microsoft Graph: Mails lesen, Antwortentwürfe im Thread, Senden, Outlook-Kategorien, Kalender |
| Meldungen und Freigaben | Microsoft Teams (Team mit 5 festen Kanälen je Kunde) |
| Optional | Google Sheets (Kunde pflegt Regeln selbst), Telegram (Alarm an den Betreiber, interne Tests), Gmail (nur Betreiber-Prüfpostfach für Zustelltests) |
| Code | reine JavaScript-Module (`src/`, ca. 29 Module) mit 305 Unit-Tests; die n8n-Workflows werden aus Generatoren erzeugt, die diese Module in Code-Nodes einbetten, und automatisch geprüft |

**Rolle der KI:** Die KI hat **keine Werkzeuge** und kann nichts auslösen. Sie bekommt Text und liefert ein festes JSON-Format zurück, das gegen ein Schema geprüft wird. Mailinhalte gelten als **nicht vertrauenswürdig**. Alle Entscheidungen (Status, Versand, Zuordnung) trifft deterministischer Code.

**Drei KI-Aufgaben, versionierte Prompts:**
1. **Klassifizierung:** Welche Vorgangsart ist es, oder keine Anfrage? Liefert Konfidenz, Sprache und Manipulationsverdacht.
2. **Extraktion:** Liest die konfigurierten Felder aus Mailtext und PDF-Text aus.
3. **Entwurf:** Formuliert die Rückfrage rund um feste Textbausteine.

Prompts liegen versioniert vor (v1–v4) mit Prüfsumme. Die Version wird je Kunde in der Config gewählt; aktuell Klassifizierung v4 mit Reklamation.

---

## 3. Ablauf einer Mail im Detail

### 3.1 Postfach (EPA-00, eine Kopie je Kunde)
- Holt jede Minute neue Mails über Microsoft Graph, mit Headern und Anhängen.
- Liest den Text aus PDF-Anhängen.
- Führt die Postfach-Aktionen aus, die andere Workflows anfordern: Entwurf anlegen, senden, Kategorie setzen, Kalender lesen und eintragen, Teams-Nachricht senden.
- Je Kunde gibt es eine eigene Kopie mit den Microsoft-Zugangsdaten dieses Kunden (als n8n-Credentials, nie im Code).

### 3.2 Eingang (EPA-01)
1. **Config laden und prüfen.** Ist die Config fehlerhaft, stoppt die Verarbeitung hart.
2. **Vorfilter:**
   - Duplikate (bereits verarbeitete Mail-ID)
   - Newsletter, Abwesenheitsnotizen
   - Allow- und Blocklist der Absender
   - Unzustellbarkeitsmeldungen (Bounces). Diese werden dem Vorgang zugeordnet und lösen einen Alarm aus.
3. **Zuordnung:** Antwort auf einen bestehenden Vorgang oder neue Anfrage?
   - Punktesystem aus Thread-ID, genannter Vorgangsnummer, Absender und Betreff.
   - Schwellen: eindeutig ab 80 Punkten mit Abstand zum Zweitplatzierten, neu unter 40, dazwischen „unklar“.
   - Passt der Thread, aber der Absender ist fremd, entsteht nie automatisch ein neuer Vorgang. Der Fall wird als „Zuordnung unklar“ gemeldet.
4. **Klassifizierung (KI) + Musterprüfung:**
   - Ist es eine konfigurierte Vorgangsart? Unter der Konfidenzschwelle (Standard 0,75) gilt der Fall als „Klassifizierung unklar“ und wird gemeldet.
   - Keine Anfrage, aber wichtig: Stornierung, Reklamation (wenn nicht als Vorgangsart eingerichtet), Rückrufbitte, Statusfrage, nur Anhang ohne Text. Diese Fälle werden im Kanal „Bitte ansehen“ gemeldet. Sonstiges wird ignoriert, aber nicht gelöscht.
5. **Extraktion (KI)** der Felder dieser Vorgangsart.
6. **Pflichtfeldprüfung (Code):**
   - Typen: Text, PLZ, Datum, Zahl, E-Mail, Telefon, Auswahl.
   - Regeln je Feld, z. B.:
     - Längen
     - Ziffernzahl
     - Datum im Bereich X bis Y Tage ab heute
     - Platzhalter-Muster wie „folgt noch“
     - Person statt Firmenname
   - Normalisierung, z. B. Tonnen → kg und „+49 (0)“ bei Telefonnummern.
   - PLZ-Nachschlagen: Passt die PLZ zum Ort?
   - **Widerspruch Mailtext ↔ PDF** (z. B. 600 kg im Text, 900 kg im PDF): Das Feld gilt als fehlend und wird mit beiden Werten zur Bestätigung zurückgefragt.
   - Zwei verschiedene Daten gelten als mehrdeutig.
7. **Ergebnis:**
   - **Vollständig:** Status „Bereit zur Bearbeitung“, Meldung im Kanal „1 Vollständige Anfragen“, Outlook-Kategorie „AI Geprüft“ (grün). Bei Terminanfragen folgt zusätzlich die Kalenderprüfung (3.7).
   - **Lücken:** Status „Lücken erkannt“, weiter zu EPA-02. Outlook-Kategorie „AI Rückfragen“ (rot).
   - **Manipulationsverdacht:** Siehe Abschnitt 6.

### 3.3 Rückfrage anfordern (EPA-02)
- Baut den Rückfrage-Entwurf:
  - Anrede
  - für jede fehlende Angabe der **feste Textbaustein** aus der Config, wortgleich
  - bei Widerspruch ein Bestätigungssatz („Wir haben „A“ und „B“ erhalten. Welche ist richtig?“)
  - Signatur
  - KI-Hinweis
- Die KI darf nur den Rahmen formulieren. Eine **Sperrliste** verhindert Zusagen wie Preis, Termin, Ersatz, Gutschrift, Erstattung, Kulanz oder Schadensersatz, auf Deutsch und Englisch. Trifft die Sperrliste, wird ein fester Ersatztext genutzt.
- Sprache: Der Entwurf folgt der Sprache der Kundenmail, wenn für diese Sprache Textbausteine konfiguriert sind (aktuell Deutsch und Englisch). Sonst geht er in der Standardsprache raus.
- Der Entwurf wird als **Antwortentwurf im Outlook-Thread** angelegt.
- Der Status wird „Freigabe ausstehend“, und eine Freigabe-Nachricht geht in den Teams-Kanal „2 Rückfragen“ (Abschnitt 4).

### 3.4 Freigabe (EPA-07, Web-Endpunkt)
- Der Mitarbeiter öffnet den Link aus Teams und sieht den Vorgang, die erkannten Angaben, die fehlenden Punkte und den Entwurf.
- Er wählt seinen Namen aus der Freigeber-Liste. Das wird protokolliert.
- Er hat drei Möglichkeiten:
  - **Freigeben und senden**
  - **Bearbeiten und senden**: Text ändern, die Sperrliste gilt auch hier
  - **Ablehnen**: Der Vorgang geht an einen Menschen.
- Schutz:
  - Links sind einmalig verwendbar und laufen ab (Standard 48 h).
  - Gespeichert wird nur ein Hash.
  - Die Übernahme ist atomar, es gibt keinen Doppelversand bei Doppelklick.
  - Ausführungen mit Links werden nicht gespeichert.
- Nach dem Versand wird der Status „Warten auf Kunde“ und die Antwortfrist läuft (Standard 48 h, wahlweise nur Geschäftszeit, Feiertage je Bundesland).
- Wird ein Entwurf manuell in Outlook gesendet, erkennt der Agent das und setzt den Status entsprechend.

### 3.5 Antwort des Kunden (EPA-03)
- Die Antwort wird über die Zuordnung (3.2) dem Vorgang zugeordnet. Die KI extrahiert erneut.
- **Zusammenführen** mit den bisherigen Angaben:
  - Das Feld, nach dem gefragt wurde, übernimmt den neuen Wert, auch wenn es vorher einen widersprüchlichen Wert hatte.
  - **Gruppenregel:** Fehlte z. B. die PLZ des Abholorts und der Kunde nennt PLZ **und** einen anderen Ort, wird beides zusammen übernommen.
  - Ein neuer Wert, der einem bestehenden Pflichtfeld widerspricht und nicht angefragt war, wird nicht still überschrieben. Er wird als Widerspruch zurückgefragt.
- Mögliche Ergebnisse:
  - **bereit:** Vorgang ist jetzt vollständig, Meldung im Kanal „1 Vollständige Anfragen“.
  - **luecken:** Es fehlt weiterhin etwas, das führt zur nächsten Rückfrage-Runde.
  - **keine_daten:** Die Antwort enthält nichts Verwertbares (z. B. nur „Danke“). Die Frist wird verlängert, Meldung im Kanal „Rückfragen“.
  - **storno:** Der Kunde storniert in der Antwort. Status „Eskaliert / Manuell“, eine offene Freigabe wird ersetzt, Meldung im Kanal „Bitte ansehen“.
  - **zusatzinfo:** Der Kunde nennt zusätzliche Wünsche oder Besonderheiten. Diese werden als Hinweis gemeldet und nicht automatisch übernommen.
  - **manipulation:** Die Antwort enthält Manipulationsversuche, Meldung und Sperre (Abschnitt 6).
- Nach **max. Runden** (Standard 3) wird eskaliert, der Status wird „Eskaliert / Manuell“.

### 3.6 Nachfassen (EPA-04 + SW Nachfassen)
- Läuft zeitgesteuert.
- **Kunde antwortet nicht:** Erinnerung nach dem eingestellten Intervall (Standard 24 h, max. 2 Erinnerungen). Auch jede Erinnerung geht nur nach Freigabe raus. Danach folgt die Meldung „keine Reaktion“ bzw. die Eskalation.
- **Freigabe bleibt liegen:** Erinnerung an die Freigeber (Standard nach 4 h). Ist der Link abgelaufen, wird automatisch ein neuer erstellt.

### 3.7 Terminanfragen: Kalender (SW Kalender prüfen + EPA-15)
- Ist eine Terminanfrage vollständig, prüft der Agent den Outlook-Kalender des Postfachs:
  - Ist der Wunschtermin frei oder belegt?
  - Bei unscharfen Angaben wie „vormittags“ oder bei belegtem Termin schlägt er freie Zeiten vor.
- In Teams kommt eine Meldung mit Button. **Eingetragen wird erst nach Klick** (EPA-15).
- Es wird nur der Kalender des Postfachs genutzt.

---

## 4. Microsoft Teams: 5 feste Kanäle je Kunde

Jeder Kunde bekommt dasselbe Team-Layout. Der Baustein „Teams einrichten“ legt die Kanäle an. Jede Meldung trägt einen „Anlass“, und eine feste Tabelle (`src/kanaele.js`) bestimmt den Kanal. Ein Test stellt sicher, dass jeder Anlass im Code einem Kanal zugeordnet ist.

| Kanal | Inhalt |
|---|---|
| **1 Vollständige Anfragen** | Anfragen, Bestellungen, Termine, Reklamationen mit allen Pflichtangaben – bereit zur Bearbeitung; Kalenderergebnis bei Terminen |
| **2 Rückfragen** | **Freigaben** (Entwurf prüfen, freigeben, bearbeiten, ablehnen), Kundenantworten mit weiter fehlenden Angaben, leere Antworten, Kunden, die nicht reagieren |
| **3 Bitte ansehen** | Keine normale Anfrage, aber ein Mensch muss entscheiden: Stornierung (auch in einer Antwort), Reklamation ohne eingerichtete Vorgangsart, Rückrufbitte, Statusfrage, Manipulationsverdacht, unklare Zuordnung/Klassifizierung, fehlgeschlagene Extraktion, maximale Rundenzahl erreicht, unzustellbare Rückfrage |
| **4 Systemmeldungen** | Technik und Betrieb: Zustellfehler von Freigabe-Nachrichten, Zustelltest, Regel-Abgleich, Tagesübersicht, Kalenderfehler |
| **5 Logs** | Eine Abschlusskarte pro Vorgang (Protokoll) |

Unbekannte Anlässe landen im Systemkanal und nicht bei den Sachbearbeitern.

---

## 5. Vorgangsarten und Felder (Beispielkunde)

Vorgangsarten werden je Kunde in der Config festgelegt, mit Name und Beschreibung für die KI. Jede Kombination ist möglich, weitere Arten lassen sich ohne Code anlegen. Je Feld werden festgelegt:
- Typ und Pflicht/optional
- Prüfregel und Extraktionshinweis für die KI
- fester Rückfrage-Textbaustein
- Gruppe und Kurzname für die Darstellung in Teams

| Vorgangsart | Felder (Beispiel) |
|---|---|
| **Angebotsanfrage** (Testkunde: Transport) | Abhol-PLZ/Ort, Liefer-PLZ/Ort, Abholdatum, Gewicht (Tonnen → kg), Packstücke, Ladungsart, Ansprechpartner, Telefon |
| **Bestellung** | Ware/Leistung, Menge, Bestellnummer (optional), Liefertermin, Liefer-PLZ/Ort, Ansprechpartner, Telefon |
| **Terminanfrage** | Anlass, Wunschtermin, Uhrzeit (optional), Ort (optional), Ansprechpartner, Telefon; Kalenderprüfung |
| **Reklamation** (neu) | Problem/Grund, betroffene Ware und Menge, Datum der Lieferung (muss in der Vergangenheit liegen, max. 1 Jahr), Lieferschein-/Bestellnummer (optional), Ansprechpartner, Telefon. Rückfragen versprechen nie Ersatz, Gutschrift oder Erstattung. Eine Stornierung ist keine Reklamation. |

**Statusmodell** (Statusmatrix im Code, nur erlaubte Übergänge):
- Neu
- In Prüfung
- Bereit zur Bearbeitung
- Lücken erkannt
- Freigabe ausstehend
- Warten auf Kunde
- Zuordnung unklar
- Klassifizierung unklar
- Eskaliert / Manuell
- Abgeschlossen
- Ignoriert

Jeder Wechsel wird im Audit protokolliert.

---

## 6. Sicherheit und Datenschutz

- **Keine Mail ohne Freigabe**, inklusive Erinnerungen.
- **Prompt-Injection-Schutz:**
  - Die KI hat keine Werkzeuge.
  - Mailinhalte werden als Daten markiert übergeben.
  - Die Antwort muss ins Schema passen.
  - Rückfragen bestehen aus festen Textbausteinen.
  - Sperrliste für Zusagen.
  - **Manipulationserkennung doppelt:** Die KI meldet einen Verdacht, zusätzlich läuft eine Musterprüfung im Code (z. B. „ignoriere alle Anweisungen“, Systemprompt-Imitation). Starke Muster sperren den Vorgang und lösen eine Meldung aus. Ein reiner KI-Verdacht ohne Muster erscheint nur als Hinweis.
- **Freigabe-Links:** einmalig, ablaufend, nur als Hash gespeichert, atomar. Die Namensauswahl wird protokolliert.
- **Keine personenbezogenen Daten in Logs.** Das Fehlerprotokoll enthält keine Mailinhalte. Ausführungen mit Links werden nicht gespeichert.
- **Konfiguration wird bei jedem Lauf geprüft.** Platzhalter oder Fehler stoppen die Verarbeitung.
- **Audit-Protokoll** für Statuswechsel, Freigaben, Zuordnungen und Systemereignisse.
- **Zugangsdaten** liegen nur als n8n-Credentials vor, nie in Dateien oder Code.

---

## 7. Überwachung und Betrieb

| Baustein | Aufgabe |
|---|---|
| **Watchdog (EPA-06)** | Prüft regelmäßig Postfach-Verbindung, Teams, KI-Dienst, hängende Vorgänge, Fehlerprotokoll und „Stille“ (zu lange keine Mail) und meldet Störungen. |
| **Error-Handler (EPA-05)** | Zentrale Fehlerbehandlung mit Fehlerklassen: Vorgang sichern, Fehler protokollieren (ohne Inhalte), Alarm auslösen. |
| **Zustelltest (EPA-11)** | Schickt eine Kontrollmail an ein Prüfpostfach. Nach einer Unzustellbarkeit werden betroffene Rückfragen nach erfolgreichem Test erneut zur Freigabe gestellt. |
| **Tagesübersicht (EPA-13)** und **Übersicht-Seite je Kunde (EPA-12)** | Überblick über die Vorgänge. Ein Betreiber-Dashboard (EPA-14) ist gebaut, aber nicht aktiv. |
| **Löschjob (EPA-08)** | Löscht Daten nach der Aufbewahrungsfrist. Gebaut, **noch nicht aktiv**. |
| **Regeln aus Google Sheets (EPA-09/10, SW Regeln abgleichen)** | Der Kunde ändert Pflichtfelder, Texte und Fristen in einem Sheet. Der Agent prüft die Änderungen und übernimmt nur gültige. |
| **KI-Qualitäts-Prüfstand (EPA-T1)** | Testet Prompt-Versionen gegen Testfälle, ohne Nebenwirkungen. |
| **Sub-Workflows (Bausteine)** | Config laden, LLM aufrufen, Vorgang verwalten, Status setzen, Audit schreiben, Benachrichtigen (Kanalwahl), Freigabe senden, Nachfassen, Outlook-Kategorie, Kalender prüfen, PLZ nachschlagen, Log-Karte, Teams einrichten |

**Data Tables:**
- Config allgemein und Pflichtfelder je Kunde
- Vorgänge
- verarbeitete Mails
- Freigaben und Freigabe-Tokens
- Audit-Log, Fehler-Log
- Prompts
- Systemstatus
- Kalender-Termine

**Neuer Kunde (Onboarding):**
1. Config aus der Vorlage füllen.
2. Postfach-Workflow kopieren und die Microsoft-Credentials des Kunden hinterlegen.
3. „Teams einrichten“ legt Team und Kanäle an.
4. Zustelltest durchführen.
5. Testmails schicken und erst danach `aktiv = true` setzen.

---

## 8. Erprobung und Stand

- **Unit-Tests:** 305 bestanden.
- **Härtetests mit echten Mails** über Microsoft 365, Teams und Freigaben:
  - Härtetest 2: 121 Fälle, Nachtest 19/20.
  - **Finaler Härtetest** (60 neue Mails im 30-Sekunden-Takt plus zweite Runde mit Kundenantworten): 66 von 75 Prüfpunkten erfüllt (88 %). Sicherheit: keine Mail ohne Freigabe, 0 Fehlalarme.
- **Nachtest der vier Korrekturen** (Storno in Antwort, Reklamation melden, Widerspruch Text/PDF, PLZ/Ort-Konflikt): 4/4 bestanden.
- **Reklamation als eigene Vorgangsart:** eingebaut und in der Cloud aktiv. Ein Live-Test mit 5 Mails läuft (vollständig, unvollständig mit Ersatzforderung, Englisch, Stornierung, gemischt). Das Ergebnis steht noch aus.
- **Eigene Einschätzung:** Agent ca. 8/10, Pilotreife ca. 7/10.

**Grenzen / offen vor dem ersten Pilotkunden:**
- Auftragsverarbeitungsvertrag (AVV) und Datenschutzunterlagen
- Aufbewahrung der n8n-Ausführungsdaten einstellen
- Löschjob aktivieren
- Testdaten löschen
- 1–2 Tage fehlerfreier Lauf
- Kalender: nur der Kalender des Postfachs
- Mischmails (z. B. Reklamation plus Neubestellung in einer Mail) werden einer Vorgangsart zugeordnet; der Rest erscheint höchstens als Hinweis.
- Die KI-Qualität hängt von gpt-4o-mini ab. Fehler fängt der Code ab, indem er im Zweifel nachfragt oder meldet, statt zu raten.

**Ideen (nicht umgesetzt):**
- Button „Stornierung bestätigen“
- Datamarking im Prompt
- Erkennung von verstecktem Text in Mails

---

## 9. Pakete (Vorschlag, netto)

| Paket | Monatlich | Einrichtung | Umfang |
|---|---|---|---|
| Basis | 249 € | 2.490 € | 150 Vorgänge |
| Business | 549 € | 2.990 € | 400 Vorgänge, Google Sheet, Englisch |
| Premium | 949 € | 4.990 € | 1.000 Vorgänge, bis 3 Postfächer |
| Individuell | auf Anfrage | auf Anfrage | – |

14 Tage Testlauf. Ob Reklamation als eigener Bereich mit eigenem Preis geführt wird, ist noch offen.
