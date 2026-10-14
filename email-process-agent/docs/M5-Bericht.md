# M5-Bericht: Nachfassen und Eskalation (Phase E)

Stand 2026-10-14. n8n 2.43.4, Data Tables.

## Fertig
| Bereich | Ergebnis |
|---|---|
| EPA-04 Nachfassen und Eskalation | Zeitplan stündlich (Minute 5) plus Aufruf-Trigger mit `jetzt` für Tests und manuelle Läufe. Liest überfällige Vorgänge („Warten auf Kunde“, Frist abgelaufen) und offene Freigaben, plant im Code (`src/nachfassen.js`) und gibt jede Aufgabe einzeln an „EPA SW Nachfassen“. Ein Fehler bei einem Vorgang hält die anderen nicht auf. |
| Fall 1: Erinnerung | Solange `erinnerungen_gesendet < anzahl_erinnerungen`: Erinnerungsentwurf über EPA-02 (`art = erinnerung`). Der Text kommt aus einer festen Vorlage (Sie/Du/Englisch) mit den Bausteinen der noch offenen Felder, ohne KI. Der Status wechselt auf „Freigabe ausstehend“ (Auslöser Cronjob). Gesendet wird erst nach Klick auf „Freigeben“. Danach: „Warten auf Kunde“, Erinnerungszähler +1, neue Frist = `erinnerung_intervall_stunden`, Rundenzähler bleibt. |
| Fall 2: Eskalation | Alle Erinnerungen gesendet und die Frist erneut verpasst: Status „Eskaliert / Manuell“ (Auslöser Cronjob, mit Versionsprüfung). Die Teams-Nachricht lautet „Kunde … reagiert seit N Tagen nicht auf Nachfragen … bitte telefonisch kontaktieren“, mit Name, Adresse, Telefon (falls bekannt) und den offenen Feldern. Danach gehen keine automatischen Nachfragen mehr raus. |
| Erinnerung an Freigeber | Ist eine Freigabe seit `freigabe_erinnerung_stunden` offen (bei Geschäftszeit-Modus in Geschäftsstunden), bekommt jeder Freigeber einmal eine Erinnerung mit neuem persönlichem Link. Alte Links bleiben gültig. |
| Abgelaufene Freigabe | Nach `freigabe_ablauf_stunden` erhält die Freigabe eine neue Ablaufzeit. **Alle alten Links werden gesperrt (410)**, und jeder Freigeber bekommt einen neuen Link. Damit gilt das Versprechen der 410-Seite aus M3 („Ein neuer Link wird automatisch verschickt“). Es wird nie automatisch gesendet. |
| Geschäftszeiten | Aufgaben eines Kunden laufen nur innerhalb seiner Geschäftszeiten (Wochentage, Uhrzeit, Feiertage der Region). Was nachts oder am Wochenende fällig wird, holt der erste Lauf am nächsten Arbeitstag nach. |
| Lauf-Lock | Eine Zeile `epa04_lauf` in der neuen Tabelle `epa_system_status`. Ein Lauf übernimmt sie atomar (bedingtes Update „lock_bis < jetzt“) und gibt sie am Ende frei. Ein zweiter, gleichzeitiger Lauf bricht sofort ab. Der Lock verfällt nach 55 Minuten (der Lauf ist auf 50 Minuten begrenzt), ein abgestürzter Lauf blockiert also höchstens bis zum nächsten Intervall. Höchstens 50 Aufgaben je Lauf (Eskalationen zuerst), der Rest folgt im nächsten Lauf. |
| Ungültige Config | Ein Kunde mit fehlender oder ungültiger Config wird nicht still übersprungen: Der Lauf meldet 424 KONFIGURATIONSFEHLER an EPA-05, mit Nennung des Kunden. Die anderen Kunden werden trotzdem bearbeitet, und der Lock wird freigegeben. |
| Heartbeat | `epa_system_status` speichert Start, Ende und eine Zusammenfassung des letzten Laufs (nur Zähler und IDs, keine Personendaten). Darauf baut der Watchdog in M6 auf. |
| Kleinere Anpassungen | EPA-07 kennt die Freigabe-Art (Seitentitel „Erinnerung freigeben“/„Erinnerung gesendet“). Tokens haben eine eigene Ablaufzeit. Das Setup-Skript legt Tabelle, Spalten und Lock-Zeile an. |

## Entscheidungen
1. **Erinnerungen ohne KI:** Der Masterprompt erlaubt „Hülle per LLM oder Template“. Gewählt ist das Template: Es ist deterministisch, verursacht keine Kosten und braucht keine Prüfung auf erfundene Inhalte. Der Freigeber kann den Text wie bei der Rückfrage bearbeiten.
2. **Erneuern statt neue Freigabe:** Bei abgelaufener Freigabe bleiben Freigabe-ID und Entwurf gleich, nur Ablaufzeit und Links sind neu. So passt die Kennung im Outlook-Entwurf weiter zum Doppelversand-Schutz aus M3.
3. **Zählweise:** „Seit N Tagen“ zählt ab dem Versand der ersten Rückfrage der aktuellen Runde.

## Getestet
1. **Unit-Tests:** 150 grün (1 weiterer braucht eine Test-Postgres und wurde übersprungen), davon 13 neu für M5. Abgedeckt:
   - Planung: Fall 1/2, Fristen, Geschäftszeit, Feiertag, inaktiver Kunde, Priorität, Limit
   - Lock-Daten
   - Tage ohne Reaktion
   - Meldungstext (escaped)
   - Erneuern/Erinnern
   - Token-Ablauf (410)
   - Erinnerungsvorlage besteht die Hüllen-Prüfung
2. **End-to-End lokal:** M5 10/10. Matrix in `docs/Testprotokoll-M5.md`. Die Fälle:
   - Kunde antwortet nie → 1. Erinnerung (nur nach Freigabe gesendet) → 2. Erinnerung → Eskalation mit Audit „Cronjob“, keine weitere Mail
   - Samstag/nachts passiert nichts
   - Lock belegt → sofortiger Abbruch
   - Abgestürzter Lock wird übernommen
   - Zwei gleichzeitige Läufe → genau eine Erinnerung
   - Kundenantwort während offener Erinnerung → ersetzt, alter Link 409
   - Freigeber-Erinnerung (einmalig, alter Link gilt weiter)
   - Freigabe-Erneuerung (alle alten Links 410, neuer Link sendet)
   - Kunde ohne gültige Config → Alarm 424, Lock frei
3. Regression: siehe Abschnitt „Gesamtlauf“.

## Offen / zu verifizieren
- Die Teams-Nachricht „bitte telefonisch kontaktieren“ wurde lokal nur als Zustellversuch geprüft (Dummy-Credential). Der Inhalt ist per Unit-Test geprüft, die echte Zustellung folgt mit deinem Teams-Credential.
- EPA-04 ist in der Cloud eingespielt, aber noch nicht veröffentlicht. Es hängt an „EPA SW Nachfassen“ → EPA-02 → SW LLM/SW Freigabe senden, die erst mit Credentials veröffentlicht werden können.
- Intervall: Voreingestellt ist stündlich. Wer seltener prüfen will, stellt im Node „Stündlich“ 2 Stunden ein.
