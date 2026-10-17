# Betriebshandbuch: Email Process Agent

Stand 2026-10-14 (M6). Für die Person, die das System betreut: Was läuft wann, was bedeuten Meldungen, was ist zu tun?

## 1. Was läuft automatisch?
| Workflow | Wann | Aufgabe |
|---|---|---|
| EPA-00 (Kopie je Postfach) | jede Minute | holt neue Mails und übergibt sie an EPA-01 |
| EPA-01 … EPA-03 | bei jeder Mail | Einordnen, Auslesen, Rückfrage vorbereiten, Antworten zusammenführen |
| EPA-07 | bei Klick auf einen Freigabe-Link | Freigabeseite, Versand nach Freigabe |
| EPA-04 | stündlich (Minute 5) | Erinnerungen an Kunden (mit Freigabe), Eskalation, Erinnerungen an Freigeber, neue Links |
| EPA-06 Watchdog | 07:30 und 13:30 | Prüft, ob alles läuft; einmal täglich „Alles in Ordnung“ |
| EPA-08 Löschjob | 02:15 | Löscht Daten nach Ablauf der Aufbewahrung |
| EPA-05 | bei jedem Fehler | Fehlerlog, Alarm im Betriebskanal, Vorgang sichern |

**Grundregel:** Es geht nie eine Mail an einen Kunden ohne Klick auf „Freigeben“. Eingegangene Mails werden nie gelöscht.

## 2. Tägliche Routine (5 Minuten)
1. Im Betriebskanal nach der Watchdog-Meldung sehen. **Fehlt die „Alles in Ordnung“-Meldung bis ca. 08:00, ist der Watchdog selbst ausgefallen:** in n8n prüfen, ob EPA-06 veröffentlicht ist und die letzte Ausführung erfolgreich war.
2. Im Kundenkanal offene Punkte abarbeiten: „Zuordnung unklar“, „Klassifizierung unklar“, „Eskaliert / Manuell“, Widersprüche (Konflikte).
3. Offene Freigaben: Wer hat noch nicht freigegeben? Die Erinnerungen laufen automatisch.

## 3. Watchdog-Meldungen und was zu tun ist
| Code | Bedeutung | Was tun |
|---|---|---|
| CRON_NIE | EPA-04 ist noch nie gelaufen | EPA-04 veröffentlichen (Reihenfolge in der Inbetriebnahme) |
| CRON_AUS | EPA-04 seit über 3 h ohne Lauf | n8n: EPA-04 veröffentlicht? Letzte Ausführungen ansehen. Ein hängender Lauf-Lock (`epa_system_status`, Zeile `epa04_lauf`) gibt sich nach 55 Minuten selbst frei. |
| VORGANG_HAENGT | Vorgang steht seit über 1 h in „Neu“, „In Prüfung“ oder „Lücken erkannt“ | Fehlerlog bzw. Ausführung zum Vorgang ansehen. Vorgang manuell weiterführen oder auf „Eskaliert / Manuell“ setzen. Meist steht schon eine EPA-05-Meldung im Kanal. |
| FREIGABE_OFFEN | Freigabe seit über 72 h offen | Freigeber oder Vertretung ansprechen. Links werden automatisch erneuert. |
| ARBEITSLISTE (Info) | Vorgänge warten seit über 24 h auf einen Mitarbeiter | im Tagesgeschäft abarbeiten |
| STILLE | im Postfach seit `stille_alarm_stunden` Geschäftsstunden keine Mail | EPA-00-Kopie veröffentlicht? Outlook-Credential gültig? Wenn wirklich nichts kam: ignorieren. |
| VERBINDUNG_TEAMS | Teams-Testaufruf fehlgeschlagen (401 = Token abgelaufen) | n8n → Credentials → Teams-Dienstkonto neu verbinden. Bis dahin gehen keine Links und Meldungen raus (Fehler stehen im Fehlerlog). |
| VERBINDUNG_LLM | KI-Anbieter nicht erreichbar (401 Schlüssel, 429 Limit/Guthaben) | OpenAI-Konto prüfen (Schlüssel, Guthaben, Limits). Neue Mails scheitern bis dahin mit Fehlermeldung und können danach neu verarbeitet werden. |
| VERBINDUNG_POSTFACH | Postfach nicht lesbar (401/403) | Outlook-Credential der EPA-00-Kopie neu verbinden bzw. Postfachrechte des Dienstkontos prüfen. |
| FEHLER_OHNE_ALARM | Fehler konnten nicht nach Teams gemeldet werden | `epa_fehler_log` ansehen (Spalte `alarmiert_am` leer). Meist zusammen mit VERBINDUNG_TEAMS. |

## 4. Fehlermeldungen von EPA-05 (Auswahl)
| Code | Typische Ursache | Was tun |
|---|---|---|
| 424 KONFIGURATIONSFEHLER | Config unvollständig (Platzhalter, fehlender Textbaustein, keine Freigeber, `postfach_workflow_id` fehlt) | Config in `epa_config_allgemein` bzw. `epa_config_pflichtfelder` korrigieren. Bei „Nachfassen blockiert“ hängen Erinnerungen dieses Kunden, bis die Config gültig ist. |
| 401/403 AUTH_FEHLER / KEINE_BERECHTIGUNG | Credential abgelaufen oder Rechte entzogen | Credential neu verbinden |
| 409 VERSIONSKONFLIKT / GESPERRT | zwei Vorgänge gleichzeitig (z. B. Kundenantwort während Freigabe) | meist erledigt sich das selbst. Vorgang prüfen. |
| 422 EXTRAKTION_UNGUELTIG | KI hat zweimal kein gültiges Ergebnis geliefert | Vorgang ist „Eskaliert / Manuell“: Mail selbst lesen und bearbeiten |
| 429/502/503/504 | Anbieter überlastet oder nicht erreichbar | wurde automatisch wiederholt. Bei Häufung Anbieterstatus prüfen. |

**Versand nach Freigabe fehlgeschlagen** (z. B. Postfach vom Anbieter gesperrt): Es wurde nichts gesendet. Die Freigabe steht auf „fehler“ (mit Grund), alle bisherigen Links gelten nicht mehr. EPA-04 prüft stündlich, ob das Postfach wieder erreichbar ist (15 Minuten bis 72 Stunden nach dem Fehler). Dann kommt die Nachricht mit „🔁 Erneut zur Freigabe“, Grund und neuem Link wieder an die Freigeber. Nach der Freigabe geht der Vorgang von „Eskaliert / Manuell“ zurück auf „Warten auf Kunde“. Doppelversand ist ausgeschlossen, weil EPA-00 vor jedem Versand den Entwurf bzw. „Gesendete Elemente“ prüft. Grenze: Die Prüfung liest den Posteingang. Ist nur der Versand gesperrt, kann der neue Versuch erneut scheitern; dann wiederholt sich der Ablauf.

**🚫 „Postfach versendet keine Mails“ (EPA-11 Zustelltest):** Jeden Morgen um 07:40 schickt jedes Kundenpostfach eine Kontrollmail („EPA-Zustelltest …“) an das Prüfpostfach des Betreibers. Kommt sie nach 10 Minuten nicht an, meldet Microsoft zwar „gesendet“, stellt aber nicht zu. Das passiert z. B. bei einem Konto, das nach einer Sperre eingeschränkt ist. Rückfragen erreichen dann keine Kunden. Was tun: Im Postfach anmelden und auf Sperr- oder Bestätigungshinweise achten (account.microsoft.com → Sicherheit). Bis zur Klärung wichtige Rückfragen telefonisch stellen. Ergebnis je Kunde steht in `epa_system_status` (Zeile `zustelltest:<kunde_id>`). Manuell prüfen: EPA-11 öffnen und „Manuell starten“ ausführen.

**Mail erneut verarbeiten:** Nach einem Fehler gilt die Mail nicht als „verarbeitet“. Die fehlgeschlagene Ausführung von EPA-00 in n8n erneut ausführen; ein Duplikat entsteht nicht.

## 5. Häufige Handgriffe
- **Widerspruch (Konflikt) klären:** Am Vorgang steht in `konflikte`, welches Feld abweicht. Den richtigen Wert in `extrahierte_daten` eintragen, den Eintrag aus `konflikte` entfernen und den Kunden ggf. selbst kontaktieren.
- **Vorgang abschließen:** Status auf „Abgeschlossen“ setzen (Mitarbeiter-Auslöser). Danach greift nach `aufbewahrung_tage` der Löschjob.
- **Freigeber ändern:** `freigeber` (JSON-Liste) in der Config. Wer dort nicht mehr steht, kann keine offenen Links mehr nutzen (403).
- **System anhalten (Notfall):** EPA-00-Kopien „unpublish“ (es werden keine Mails mehr abgeholt). Zusätzlich EPA-04 (keine Erinnerungen) und EPA-07 (keine Freigaben). Eingehende Mails bleiben im Postfach und werden nach dem Wiedereinschalten abgeholt.
- **Entwurf direkt in Outlook gesendet:** Mitarbeiter dürfen einen Rückfrage-Entwurf auch direkt im Postfach („Entwürfe“) öffnen, ändern und senden. EPA-04 erkennt das beim nächsten stündlichen Lauf an der Freigabe-Kennung in „Gesendete Elemente“: Die Freigabe gilt als gesendet (`entscheidung = manuell_gesendet`), alle Links werden gesperrt, der Vorgang wartet auf den Kunden (Frist ab dem tatsächlichen Versand), und im Kanal erscheint „📤 Rückfrage direkt in Outlook gesendet“. Den gesendeten Text prüft der Agent dabei nicht.
- **Löschjob testen:** EPA-08 manuell mit `probelauf = true` aufrufen. Er zeigt nur an, was gelöscht würde.

## 6. Datenschutzanfragen (Auskunft, Löschung)
1. In `epa_vorgaenge` nach `absender_adresse` filtern und die `vorgangs_id`s notieren.
2. **Auskunft:** Zeilen aus `epa_vorgaenge`, `epa_audit_log` (Filter `vorgangs_id`) und `epa_freigaben` exportieren. Die Mails selbst liegen im Postfach.
3. **Löschung:** Vorgang auf „Abgeschlossen“ setzen. Für eine sofortige Löschung die Zeilen in `epa_freigabe_tokens` (über `freigabe_id`), `epa_freigaben`, `epa_audit_log`, `epa_verarbeitete_mails` und zuletzt `epa_vorgaenge` löschen. Die Mails im Postfach löscht der Kunde nach seinen Regeln.
4. Die Anfrage und ihre Erledigung dokumentieren (beim Verantwortlichen, nicht im System).

## 7. Wichtige Stellen
| Was | Wo |
|---|---|
| Config je Kunde | Data Table `epa_config_allgemein`, Pflichtfelder in `epa_config_pflichtfelder` |
| Vorgänge, Audit | `epa_vorgaenge`, `epa_audit_log` |
| Fehler | `epa_fehler_log` (90 Tage) |
| Heartbeats, Lauf-Lock, Ergebnisse von Watchdog und Löschjob | `epa_system_status` |
| Prompts (versioniert) | `epa_prompts` bzw. Repository `prompts/` |
