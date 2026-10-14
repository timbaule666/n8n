# M6-Bericht: Watchdog, Heartbeats, Löschjob, Härtung (Phase F)

Stand 2026-10-14. n8n 2.43.4, Data Tables.

## Fertig
| Bereich | Ergebnis |
|---|---|
| EPA-06 Watchdog | Läuft täglich um 07:30 und 13:30 (Europe/Berlin), zusätzlich manuell mit `jetzt` aufrufbar. Prüft Folgendes: **Heartbeat von EPA-04** (älter als 3 h = Alarm, nie gelaufen = Warnung). **Hängende Vorgänge** („Neu“, „In Prüfung“, „Lücken erkannt“ über 1 h; „Freigabe ausstehend“ über 72 h; Arbeitslisten über 24 h werden gezählt). **Stille im Postfach** (`stille_alarm_stunden` in Geschäftsstunden, nur während der Geschäftszeit). **Aktive Testaufrufe** für Teams (`/me`), KI-Anbieter (`/models`) und jedes Postfach (neue EPA-00-Aktion `verbindung_pruefen`). **Fehler ohne Alarm** (letzte 24 h). Jeder Befund kommt mit einer konkreten Handlungsempfehlung. |
| Heartbeat | Ohne Befund kommt einmal täglich „Alles in Ordnung“. Bleibt diese Meldung aus, ist der Watchdog selbst ausgefallen. Das Ergebnis (nur Codes und Zähler) steht in `epa_system_status`, Zeile `watchdog`. |
| EPA-08 Löschjob | Läuft täglich um 02:15. Gelöscht werden: abgeschlossene oder ignorierte Vorgänge nach `aufbewahrung_tage` samt Audit, Freigaben und Links; Dedupe-Einträge nach `aufbewahrung_tage`; Fehlerlog nach 90 Tagen; **ersetzte Rückfrage-Entwürfe im Postfach**. Gelöscht wird nur, was nachweislich ein Entwurf mit der passenden Freigabe-Kennung ist (neue EPA-00-Aktion `entwurf_loeschen`). Offene und eskalierte Vorgänge sowie eingegangene Mails werden nie gelöscht. Mit `probelauf = true` wird nur angezeigt. |
| Sicherungen im Löschjob | Ein Vorgang wird nur gelöscht, wenn er seit der Frist unverändert ist (Bedingung direkt im Löschbefehl). Abhängige Daten werden nur für tatsächlich gelöschte Vorgänge entfernt. Liegt noch ein ersetzter Entwurf im Postfach, wird der Vorgang zurückgestellt, bis der Entwurf weg ist. Je Lauf höchstens 200 Vorgänge und 50 Entwürfe. |
| Härtung | Workflows mit Klartext-Links (EPA-02, EPA-07, SW Freigabe senden, SW Nachfassen) speichern erfolgreiche Ausführungen nicht mehr. Die Freigabeseite sendet zusätzlich `X-Frame-Options: DENY` und `nosniff` (Schutz vor Clickjacking). Eine eigene Content-Security-Policy überschreibt n8n mit seiner Sandbox-Policy; das ist im Test H01 festgehalten. Neue automatische Prüfungen beim Build: Suche nach Klartext-Secrets, öffentlicher Webhook nur in EPA-07, `callerPolicy` überall, Löschen nur mit „alle Bedingungen“. |
| Dokumentation | `docs/Datenschutz-und-KI-Checkliste.md` (DSGVO, EU AI Act, minimale Microsoft-Rechte, offene Punkte vor Produktivstart), `docs/Betriebshandbuch.md` (Routine, alle Meldungen mit Maßnahmen, Notfall, Datenschutzanfragen), Inbetriebnahme Abschnitt 9. |
| Config | Neu ist `stille_alarm_stunden` (optional, 0 = aus; Beispiel 24). |

## Entscheidungen
1. **Löschjob nicht automatisch scharf:** In der Cloud ist EPA-08 eingespielt, aber bewusst nicht veröffentlicht. Löschen ist nicht umkehrbar, deshalb erst nach einem Probelauf mit echten Daten und deiner Freigabe.
2. **Watchdog meldet an den Betriebskanal** (wie EPA-05), nicht an die Kundenkanäle. Kundenbezogene Hinweise (z. B. Stille) nennen nur die `kunde_id`.
3. **Erneute Meldung statt Unterdrückung:** Befunde werden bei jedem Lauf gemeldet, solange sie bestehen (zweimal täglich). Das „Alles in Ordnung“ kommt einmal am Tag.

## Getestet
1. **Unit-Tests:** 164 grün (1 weiterer braucht eine Test-Postgres und wurde übersprungen), davon 14 neu für M6. Abgedeckt:
   - Watchdog: alle Prüfungen, Grenzwerte, Geschäftszeit, Escaping, täglicher Heartbeat über die Tagesgrenze
   - Löschplan: nur Endstatus, Frist, Zurückstellen, Limits
   - Entwurfsprüfung: kein Entwurf, fremde Kennung, 404, 401
   - Härtungsregeln
2. **End-to-End lokal (M6):** Matrix in `docs/Testprotokoll-M6.md`. Die Ausfall-Simulationen:
   - W01 alles ok mit Heartbeat
   - W02 Cronjob ausgefallen
   - W03 hängender Vorgang
   - W04 Stille im Postfach
   - W05 Teams-Token ungültig (401), KI-Limit (429) und Postfachrechte entzogen (403) gleichzeitig
   - W06 Fehler ohne Alarm
   - L01 Probelauf
   - L02 ersetzte Entwürfe: nur der richtige wird gelöscht, die Kundenmail und ein Entwurf mit fremder Kennung bleiben
   - L03 Löschen nach Frist: offene und eskalierte Vorgänge bleiben
   - H01 Sicherheits-Header
3. **Gesamtlauf:** siehe Abschnitt „Regression“ unten.
4. **Cloud:** Alle 17 Workflows sind auf dem Stand von Commit `f3a7fb3`. Der Abgleich jedes Nodes mit der Quelle ergab 0 Abweichungen. Die Einstellungen (keine Erfolgsdaten speichern, Zeitzone) sind übernommen, die neuen Spalten angelegt.

## Offen / zu verifizieren
- **Lokal nicht prüfbar:** Die Watchdog-Meldung im Teams-Kanal wurde lokal nur als Zustellversuch geprüft (Dummy-Credential).
- **Echte Microsoft-Antworten:** Ob Graph beim Löschen eines Entwurfs und bei `$expand` der Extended Property genau so antwortet wie der Mock, ist mit dem echten Postfach zu bestätigen (Testpostfach).
- **Von dir:**
  - Betriebskanal (Team- und Kanal-ID) für EPA-05 und EPA-06 nennen.
  - EPA-00-Kopien nach dem Update neu aus der Vorlage erzeugen.
  - Aufbewahrung der n8n-Ausführungsdaten in der Instanz einstellen.
  - EPA-08 nach einem Probelauf freigeben.
- **Juristisch:** Die Punkte in der Checkliste (AVV, Drittland, KI-Hinweis, Aufbewahrungsfrist) sind keine Rechtsberatung und müssen geprüft werden.
- **Leere Config-Vorlage und Verkaufs-Kurzbeschreibung** folgen in M7.

## Regression

Gesamtlauf lokal: **81 Szenarien** (M2 36/36, M3 16/16, M4 9/9, M5 10/10, M6 10/10). Die M1-Regression ist grün. H01 war im ersten Gesamtlauf rot (eigene CSP von n8n überschrieben, siehe Testprotokoll-M6); nach der Korrektur wurde H01 zusammen mit F01–F03 erneut ausgeführt und bestanden.
