# Prüfung Pilot-Bereitschaft (09.11.2026)

**Ergebnis: noch nicht bereit.** Kern funktioniert, aber zwei Blocker im Betrieb und zwei Pflichtpunkte Datenschutz.

## Geprüft
| Bereich | Ergebnis |
|---|---|
| Code und Tests (Repo-Stand 9ab40fe) | 287 Tests, 286 bestanden, 0 Fehler (1 übersprungen), Workflow-Prüfung ohne Befund |
| Eingang/Klassifizierung (Lauf 05.11., 14:02) | Angebotsanfrage, Bestellung, 2 Terminanfragen korrekt erkannt und vollständig erfasst; Reklamation korrekt ignoriert |
| Rückfrage, Freigabe, Versand | 9 Rückfragen seit 05.11. freigegeben und gesendet (Message-IDs vorhanden) |
| Kalender | Eingebaut und aktiv (auch nach Cloud-Änderung vom 09.11.) |
| Watchdog | läuft, letzter Lauf 09.11. 12:30, meldet offene Freigaben |
| Fehlerbehandlung | Fehler werden protokolliert und alarmiert |
| Zustelltest epa-m365 | zuletzt 05.11. ok |

## Blocker
1. **Nachfassen (EPA-04) steht seit 05.11. 16:05.** Jeder Stundenlauf bricht ab: „Config ungültig für epa-m365“. Ursache: Die PLZ-Regel wurde am 05./06.11. auf `{"laender":["DE"]}` umgestellt; der in EPA-04 eingebaute Config-Prüfer kennt diesen Schlüssel nicht. Folge: keine Erinnerungen, abgelaufene Freigaben (V-2026-0329, -0352, -0354) werden nicht erneuert oder eskaliert. Gleiches Risiko für EPA-06, EPA-11, EPA-13 und „SW Regeln abgleichen“ (gleicher eingebauter Prüfer).
2. **Repo und Cloud sind nicht mehr gleich.** In der Cloud gibt es Änderungen und neue Workflows, die nicht in diesem Repo stehen: „SW PLZ nachschlagen“ + Tabelle epa_plz_de, „SW Log-Karte“, „SW Teams einrichten“, Spalten `kanaele`/`log_channel_id`, Status „Abgeschlossen“, neue Fassungen von EPA-01, EPA-02, EPA-03, Config laden, Status setzen, Vorgang verwalten, Benachrichtigen, Postfach. Ein Deploy aus diesem Repo würde diese Änderungen überschreiben. Vor einem Pilot muss es eine einzige Quelle geben.

## Pflicht vor echten Kundendaten
3. **Löschjob (EPA-08) ist nicht aktiv** – Daten werden nicht nach Frist gelöscht. Kalender-Tabelle ist nicht im Löschjob.
4. **AVV/Datenschutz:** Auftragsverarbeitungsvertrag, Unterauftragnehmer (OpenAI, n8n, Microsoft), Datenschutzhinweis – rechtlich prüfen lassen.

## Zu verifizieren
- Im Testpostfach kommen wiederholt Microsoft-Hinweise „Ausgehende E-Mails werden mit 550 5.7.70 …“ (02., 05., 06., 09.11.). Versand lief bis 06.11.; Ursache und Auswirkung klären (Testkonto, nicht Kundenkonto).
- Lauf am 05.11. 11:39–11:47: fünf Anfragen fälschlich „Ignoriert“; ab 14:02 korrekt. Ursache in der Cloud behoben, aber nicht im Repo nachvollziehbar.
- Watchdog meldet 134 offene Vorgänge (inkl. Testkunde epa-test) – Testdaten vor dem Pilot bereinigen.

## Empfohlene Reihenfolge
1. Cloud-Stand ins Repo übernehmen (eine Quelle).
2. Config-Prüfer mit PLZ-Länderregel in alle Workflows ausrollen → Nachfassen läuft wieder; offene Freigaben prüfen.
3. Löschjob einschalten (inkl. Kalender-Tabelle).
4. AVV und Datenschutz.
5. Testdaten bereinigen, 1–2 Tage ohne Fehler laufen lassen, dann Pilot (Logistik, wenig Volumen).

## Nachtrag 09.11., 14:05 – Blocker 1 behoben
PLZ-Regel `laender` in EPA-04, EPA-06, EPA-11, EPA-13, EPA-14 und SW Regeln abgleichen nachgezogen (nur der eingebettete Config-Prüfer getauscht, sonst unverändert) und im Repo übernommen. Nachfass-Lauf 14:05 erfolgreich: 6 Aufgaben, 2 Kunden-Erinnerungen zur Freigabe, 3 Freigaben eskaliert, 1 Freigeber erinnert, keine ungültige Config mehr.
