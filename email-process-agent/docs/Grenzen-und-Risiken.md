# Bekannte Grenzen und offene Risiken

Stand 2026-10-14 (M7). Ehrliche Liste für Betrieb und Verkauf. „Zu verifizieren“ heißt: nicht selbst geprüft, vor Produktivstart klären.

## A. Noch nicht unter echten Bedingungen geprüft
| Nr. | Punkt | Auswirkung | Was tun |
|---|---|---|---|
| A1 | Alle End-to-End-Tests liefen gegen **simulierte** KI- und Microsoft-Schnittstellen (Mock). Die echte Qualität von OpenAI bei Klassifizierung und Extraktion ist nicht gemessen. | Fehlklassifizierung oder übersehene Angaben sind möglich. | Testphase mit 50–100 echten, anonymisierten Mails; Trefferquote je Feld auswerten, Prompts ggf. als v2 nachschärfen. |
| A2 | Verhalten der echten Microsoft-Graph-API bei Entwurf, Versand, Suche in „Gesendete Elemente“, Löschen und Extended Properties | Abweichungen im Detail (Feldnamen, Groß-/Kleinschreibung, Verzögerungen) | Testpostfach-Durchlauf aller Freigabe- und Löschpfade |
| A3 | Teams-Zustellung (Kanal, 1:1-Chat) nur mit Dummy-Credential getestet | Meldungen/Links kommen evtl. nicht an | Mit Dienstkonto testen; Watchdog prüft danach täglich |
| A4 | Cloud-Instanz: Workflows eingespielt und abgeglichen, aber ohne Credentials nicht veröffentlicht und nicht live gelaufen | — | Credentials zuweisen, Reihenfolge laut Inbetriebnahme veröffentlichen, Testpostfach |

## B. Technische Grenzen
| Nr. | Grenze | Einordnung |
|---|---|---|
| B1 | **n8n Data Tables** statt Datenbank: keine Unique-Constraints, keine Transaktionen. Gleichzeitige Änderungen fängt ein Versionsfeld ab (getestet). Status und Audit werden in zwei Schritten geschrieben. | Für kleine bis mittlere Mengen ausreichend. Speicherlimit der Instanz (standardmäßig 200 MB) [zu verifizieren für den Cloud-Tarif]. Ab etwa einigen Tausend Vorgängen pro Monat oder mehreren Kunden: Postgres (Variante liegt auf M1-Stand vor und müsste nachgezogen werden). |
| B2 | **Polling** jede Minute statt Push. Neue Mails werden mit bis zu ca. 1–2 Minuten Verzögerung verarbeitet. | Bewusst gewählt (robuster als Graph-Abos, siehe Bauplan). |
| B3 | **Anhänge:** PDFs mit Textebene und Bilder (an die KI). Gescannte PDFs ohne Text, Word/Excel und eingebettete Mails werden nicht ausgelesen, nur als Hinweis gemeldet. | Keine OCR-Stufe; bei Bedarf als Erweiterung. Kein eingebauter Virenscan (Defender for Office 365 vor dem Postfach empfohlen). |
| B4 | **Freigabe per Link** (Variante B): Die Identität beruht auf dem Besitz des persönlichen Links (Token einmalig, ablaufend, nur Hash gespeichert). Keine echte Anmeldung. | Weitergeleitete Links sind ein Restrisiko. Abhilfe später: Teams-Bot oder Power Automate mit verifizierter Identität (Bauplan Varianten C/D). |
| B5 | Freigabeseite läuft unter n8n-Domain mit n8n-Sandbox (eigene CSP nicht setzbar). Schutz gegen Einbetten über `X-Frame-Options`. | Ausreichend für interne Freigeber. |
| B6 | Eine Mail wird **einem** Vorgang zugeordnet. Mehrere Anfragen in einer Mail werden als eine behandelt. Unklare Zuordnung geht an Mitarbeiter. | Bewusst konservativ. |
| B7 | Konflikte (widersprüchliche Angaben) werden gemeldet, aber nur manuell in der Data Table aufgelöst. | Komfort-Erweiterung: Teams-Aktion „Wert übernehmen/verwerfen“. |
| B8 | Erinnerungen an Kunden nutzen eine feste Vorlage (keine KI); Rückfragen eine KI-Hülle mit Prüfung und Rückfall auf die Vorlage. | Formulierung weniger individuell, dafür sicher. |
| B9 | Lauf-Lock und Geschäftszeiten: Läuft n8n nicht (Wartung), werden Erinnerungen beim nächsten Lauf nachgeholt; ein Watchdog-Alarm folgt nach 3 h ohne Lauf. | — |
| B10 | Execution-Daten: Für die meisten Workflows speichert n8n Mail-Inhalte in den Ausführungen, bis sie per Einstellung bereinigt werden. | Aufbewahrung in der Instanz begrenzen (Betreiberaufgabe). |
| B11 | Die Postgres-Variante ist auf dem Stand von M1. | Bei Wechsel nachziehen (Aufwand: Repository-Sub-Workflows und neue Tabellen). |

## C. Rechtliche und organisatorische Risiken (keine Rechtsberatung)
| Nr. | Risiko | Stand |
|---|---|---|
| C1 | Drittlandübermittlung an OpenAI (USA) | zu prüfen; Alternative EU-Anbieter über `basis_url` möglich |
| C2 | AVV-Kette Kunde ↔ Betreiber ↔ n8n/OpenAI/Microsoft | abzuschließen |
| C3 | Formulierung und Pflicht des KI-Hinweises (EU AI Act Art. 50) | juristisch zu prüfen |
| C4 | Haftung für falsch übernommene Angaben | Mitarbeiter prüft vor Freigabe; der Vorgang ist mit Audit nachvollziehbar. Vertraglich regeln. |
| C5 | Abhängigkeit von Anbieterpreisen und -verfügbarkeit (OpenAI, n8n Cloud) | Modell und Endpunkt sind je Kunde konfigurierbar; Watchdog meldet Ausfälle |

## D. Betrieb
- Der Betrieb braucht eine verantwortliche Person, die die Watchdog- und Fehlermeldungen liest (Betriebshandbuch).
- Prompt-Änderungen nur als neue Version (`prompts/v2`), nicht im laufenden Betrieb überschreiben.
- Updates werden über `tools/deploy.js` eingespielt; Credentials und Teams-IDs bleiben dabei erhalten. EPA-00-Kopien müssen bei Änderungen der Vorlage von Hand nachgezogen werden.
