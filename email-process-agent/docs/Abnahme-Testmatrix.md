# Abnahme-Testmatrix

Stand 2026-10-14 (M7). Zuordnung der Testanforderungen aus dem Auftrag (Masterprompt, Abschnitt 10) zu den automatisierten Testfällen. Die Ergebnisse stehen in `Testprotokoll-Gesamt.md` und den Einzelprotokollen `Testprotokoll-M2.md` bis `Testprotokoll-M7.md`.

**Testumgebung:** lokale n8n-Instanz 2.43.4 mit Data Tables. KI und Microsoft Graph/Teams sind **simuliert** (Mock). Damit ist die Verarbeitungskette geprüft, nicht die Qualität des echten Modells und nicht das Verhalten der echten Microsoft-APIs (siehe Grenzen-und-Risiken A1–A3).

## Unit-Tests (`npm test`)
| Anforderung | Testdatei |
|---|---|
| Pflichtfeld-Prüfung | `test/pflichtfelder.test.js` |
| Merge-Logik | `test/antwort.test.js` |
| Statusübergangsmatrix | `test/statusMatrix.test.js` |
| Fristberechnung (Zeitzone, Geschäftszeit, Feiertage) | `test/fristen.test.js` |
| Zuordnungsregeln | `test/zuordnung.test.js` |
| zusätzlich | Mail-Normalisierung, LLM-Schema, Entwurf und Hüllenprüfung, Freigabe-Token, Nachfassen, Watchdog, Löschplan, Config-Validierung, Härtungsregeln, Vorlagen, Fehlerklassen |

## Szenario-Tests
| Anforderung (Masterprompt) | Testfall |
|---|---|
| vollständige Anfrage | T01 |
| Anfrage mit 1 Lücke | T02 |
| Anfrage mit mehreren Lücken | T03 (auch T04 Platzhalter, T05 Datum in der Vergangenheit) |
| Antwort ergänzt alles | A01, T15 |
| Antwort ergänzt nur teilweise (Runde 2) | A02 |
| Antwort widerspricht vorhandenen Daten | A03 |
| Kunde antwortet nie (Erinnerung, Eskalation) | N01, N02, N03 |
| Newsletter/Spam | T06, T07, T36 (Archivordner) |
| Out-of-Office | T09, T10 (auch T11 Unzustellbarkeit) |
| unklare Zuordnung | T17 |
| zwei offene Vorgänge desselben Absenders | T16 |
| Duplikat-Mail | T14, T31 |
| Anhang als PDF und als Foto | T33, T34 |
| kaputter/leerer Anhang | T35 |
| Prompt-Injection-Versuch | T20 |
| sehr lange Mail | T22 |
| Mail in Englisch | T21 |

## Fehler-Tests
| Anforderung (Masterprompt) | Testfall |
|---|---|
| Graph-API nicht erreichbar | G01 (Mail laden), F10/F11 (Versand), W05 (Watchdog) |
| abgelaufenes Token | G02 (Postfach), T32 (KI 401), W05 (Teams 401) |
| LLM-Timeout | G03 |
| ungültiges LLM-JSON | T28 (Korrektur erfolgreich), T29 (zweimal ungültig → 422) |
| fehlender Textbaustein | G04 |
| Ablehnung in der Freigabekarte | F06 |
| Freigabe nach Ablauf | F07, N09 |

## Weitere geprüfte Anforderungen
| Thema | Testfälle |
|---|---|
| Freigabe: Bearbeiten, Doppelklick, Berechtigung, ungültiger Link | F02–F05, F08, F09 |
| KI-Entwurf mit Zusagen/Preisen → Vorlage, KI nicht erreichbar | F12, F13 |
| Rundenlimit | F15, A07 |
| Antwort ohne Daten (Vertröstung), Antwort während offener Freigabe | A04, A05, N07 |
| Geschäftszeiten, Lauf-Lock, parallele Läufe | N04, N05, N06 |
| Freigeber-Erinnerung und neue Links | N08, N09 |
| Config ungültig → Alarm statt stillem Überspringen | N10 |
| Rate-Limit mit Retry-After | T27 |
| Spoofing-Hinweis, Schleifenschutz, Blockliste, Allowlist | T24, T12, T13, T25 |
| Watchdog (Heartbeat, hängende Vorgänge, Stille, Verbindungen, Fehler ohne Alarm) | W01–W06 |
| Löschjob (Probelauf, ersetzte Entwürfe, Fristablauf) | L01–L03 |
| Sicherheits-Header der Freigabeseite | H01 |
| Concurrency, Fehlerlog ohne Inhalte (Fundament) | M1-Test (`tools/e2e-test.js`) |

## Ergebnis
Siehe `Testprotokoll-Gesamt.md` (automatisch erzeugt) und `M7-Abschlussbericht.md`.
