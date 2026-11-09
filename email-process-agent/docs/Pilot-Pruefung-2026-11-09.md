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

## Nachtrag 09.11. – Blocker 2 behoben: Cloud-Stand im Code
Alle Änderungen, die direkt in n8n gemacht wurden, sind jetzt im Repo und werden beim Bauen wieder genauso erzeugt:

| Bereich | Übernommen |
|---|---|
| Module | `pflichtfelder` (PLZ je Land über `validierungsregel.laender`, PLZ-Verzeichnis), `eingang` (reiner KI-Verdacht ohne auffällige Stelle löst keinen Hinweis mehr aus) |
| EPA-01, EPA-03 | Node „PLZ nachschlagen“ vor der Pflichtfeldprüfung; Extraktion bekommt PLZ-Felder ohne Regel |
| EPA-02 | Node „Karte anhängen“ (Freigabe als Teams-Karte, Text als Rückfall) |
| EPA-00 Postfach | Kanal- und Chat-Meldungen als Adaptive Card mit Text-Rückfall („Marker-Karte“, „Kanal-Karte zugestellt?“, „Kanal-Text senden“, „Karte zugestellt?“, „Text-Nachricht senden“, „Chat melden“ angepasst) |
| SW Benachrichtigen | Node „Kanal wählen“ (Kanal je Meldungsart aus Config `kanaele`) |
| SW Status setzen | Node „Log-Karte senden“ |
| SW Vorgang verwalten | Node „Schwache Altfälle aussortieren“ |
| Neu | EPA SW PLZ nachschlagen, EPA SW Log-Karte, EPA SW Teams einrichten |
| Daten | Config-Spalten `kanaele`, `log_channel_id`; Tabelle `epa_plz_de` im Schema (Inhalt = deutsches PLZ-Verzeichnis, nur in der Cloud) |

Längere Code-Blöcke liegen in `workflows-src/datatable/code/`. Abweichung zur Cloud: In `pflichtfelder` ist das geschützte Leerzeichen bei Zahlen („1 200 kg“) wiederhergestellt; es war in der Cloud-Fassung verloren gegangen.

## Nachtrag 09.11. – Löschjob aktiv
EPA-08 um Kalender-Termine (mit dem Vorgang und 30 Tage nach Link-Ablauf) und Übersicht-Zugänge (30 Tage nach Ablauf) ergänzt, ausgerollt und veröffentlicht; läuft täglich 02:15. Probelauf vorher: 0 Vorgänge (keiner älter als 365 Tage), 7 ersetzte Rückfrage-Entwürfe zum Entfernen aus dem Postfach, Fehlerlog-Grenze 11.08.2026, Link-Grenze 10.10.2026.
Offen: Regel, wann „Bereit zur Bearbeitung“ zu „Abgeschlossen“ wird (sonst nie gelöscht); Aufbewahrung der n8n-Ausführungsdaten in den n8n-Einstellungen begrenzen.
Nachtrag: „Bereit zur Bearbeitung“ wird 30 Tage nach der letzten Änderung gelöscht (samt Freigaben, Links, Audit, Kalender-Terminen; Mails im Postfach bleiben). Probelauf heute: 0 Vorgänge; simuliert für 19.12.2026: 104 Vorgänge, 34 Freigaben, 4 zurückgestellt (erst Entwurf aus dem Postfach entfernen).

## Nachtrag 09.11., 16:58 – Testdaten bereinigt
Einmaliger Hilfs-Workflow (Probelauf, dann Ausführung, danach archiviert). Betroffen waren die Testkunden epa-m365, epa-test, epa-ki-test und beispiel-transport.

| Bereich | Gelöscht |
|---|---|
| Rückfrage-Entwürfe im Testpostfach (nie gesendet, Freigabe-Kennung geprüft, landen in „Gelöschte Elemente“) | 13 |
| Vorgänge (alle epa-m365) | 243 |
| Freigaben | 86 |
| Freigabe-Links | 131 |
| Audit-Einträge | 1.640 |
| Kalender-Termine (Tabelle; Einträge im Outlook-Kalender bleiben) | 5 |
| Fehlerlog (komplett) | 59 |

Unverändert geblieben:
- Configs und Pflichtfelder aller Kunden
- Prompts, PLZ-Verzeichnis, Systemstatus
- Übersicht-Zugänge
- `epa_verarbeitete_mails`: Schutz vor erneuter Verarbeitung alter Mails
- Alle eingegangenen und gesendeten Mails im Postfach

Neue Vorgangs-IDs zählen weiter (keine Wiederverwendung).
