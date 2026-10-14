# Checkliste Datenschutz (DSGVO) und KI-Verordnung (EU AI Act)

Stand 2026-10-14 (M6). Diese Liste zeigt, was technisch umgesetzt ist und was beim Kunden bzw. juristisch zu klären ist.

> **Keine Rechtsberatung.** Alle Punkte mit „juristisch prüfen“ müssen vor dem Produktivbetrieb mit einer Datenschutzberatung bzw. Rechtsanwältin oder Rechtsanwalt geklärt werden. Angaben zu Anbietern (OpenAI, Microsoft, n8n) sind **zu verifizieren**, weil sich Verträge und Angebote ändern.

Legende: ✅ technisch umgesetzt · 🔧 beim Einrichten durch den Betreiber · ⚖️ juristisch prüfen

## 1. Grundlagen der Verarbeitung
| Nr. | Punkt | Stand |
|---|---|---|
| 1.1 | **Rechtsgrundlage** festlegen. Naheliegend ist Art. 6 Abs. 1 lit. b DSGVO (Anfrage/Vertragsanbahnung), ergänzend lit. f (berechtigtes Interesse an effizienter Bearbeitung). | ⚖️ |
| 1.2 | **Rollen:** Der Kunde (Spedition o. ä.) ist Verantwortlicher. TIM Agent Systems ist als Betreiber bzw. Einrichter Auftragsverarbeiter. Unterauftragsverarbeiter sind n8n (Cloud-Hosting), OpenAI (KI) und Microsoft (Postfach, Teams). | ⚖️ AVV zwischen Kunde und TIM Agent Systems |
| 1.3 | **AVV/DPA** mit allen Unterauftragsverarbeitern: n8n GmbH, OpenAI, Microsoft (über den M365-Vertrag des Kunden). | 🔧 ⚖️ |
| 1.4 | **Drittlandübermittlung:** OpenAI und ggf. n8n Cloud verarbeiten (auch) außerhalb der EU. Zu prüfen sind Angemessenheitsbeschluss bzw. Data Privacy Framework, Standardvertragsklauseln und EU-Datenresidenz-Optionen bei OpenAI (Verfügbarkeit für das Konto zu verifizieren). Alternative: ein Modellanbieter mit EU-Hosting (`basis_url` ist je Kunde konfigurierbar). | ⚖️ zu verifizieren |
| 1.5 | **Verzeichnis von Verarbeitungstätigkeiten** (Art. 30): Eintrag „KI-gestützte Vorprüfung von E-Mail-Anfragen“ mit Zweck, Datenkategorien (Kontaktdaten, Anfrageinhalte, ggf. Anhänge), Empfängern, Fristen (siehe 3.) und TOMs (siehe 4.). | 🔧 beim Kunden |
| 1.6 | **Datenschutz-Folgenabschätzung** (Art. 35): Eher nicht erforderlich, weil keine automatisierten Entscheidungen mit Rechtswirkung getroffen werden und keine besonderen Kategorien gezielt verarbeitet werden. Einsatz neuer Technologie (KI) spricht für eine dokumentierte Schwellwertprüfung. | ⚖️ |
| 1.7 | **Informationspflichten** (Art. 13/14): Die Datenschutzhinweise des Kunden um die KI-gestützte Bearbeitung und die Empfänger ergänzen (Link z. B. in der Signatur). | 🔧 ⚖️ |
| 1.8 | **Keine automatisierte Einzelentscheidung** (Art. 22): Die KI klassifiziert und extrahiert nur. Jede Mail an Kunden braucht eine Freigabe durch einen Menschen; Ablehnung oder Eskalation entscheiden Mitarbeiter. | ✅ |

## 2. Datenminimierung und Zweckbindung
| Nr. | Punkt | Stand |
|---|---|---|
| 2.1 | An die KI gehen nur Betreff, der **neue** Mailtext (Zitate und Signaturen abgeschnitten, Länge begrenzt) und auswertbare Anhänge. Bei Antworten bekommt sie nur die Namen offener und bekannter Felder, keine bekannten Werte. | ✅ (M2/M4) |
| 2.2 | Rückfrage-Entwürfe: Die KI bekommt nur Vorname/Name und Betreff, keine Mailinhalte. Erinnerungen entstehen ganz ohne KI. | ✅ (M3/M5) |
| 2.3 | Die KI hat keine Werkzeuge und keinen Zugriff auf Systeme. Mail-Inhalte gelten als nicht vertrauenswürdig (Prompt-Injection-Schutz, Schema-Prüfung, Nachprüfung der Entwürfe). | ✅ |
| 2.4 | Fehlerlog und Watchdog-/Löschjob-Status enthalten nur IDs, Codes und technische Meldungen, keine Mail-Inhalte. | ✅ (geprüft in Tests T29/W06) |
| 2.5 | OpenAI: Speicherung/Training der API-Daten. Laut Anbieter werden API-Daten standardmäßig nicht zum Training genutzt; Aufbewahrung und „Zero Data Retention“ sind für das Konto zu klären. | 🔧 zu verifizieren |
| 2.6 | Fremde Personen in CC/Anhängen: Werden mitverarbeitet, aber nur, soweit sie in der Mail stehen. Kein gezieltes Profiling. | ✅ / ⚖️ |

## 3. Speicherbegrenzung und Löschung
| Nr. | Punkt | Stand |
|---|---|---|
| 3.1 | **Löschjob EPA-08** (täglich 02:15): löscht abgeschlossene und ignorierte Vorgänge samt Audit, Freigaben und Links nach `aufbewahrung_tage` (je Kunde), Dedupe-Einträge nach `aufbewahrung_tage`, Fehlerlog nach 90 Tagen und ersetzte Entwürfe im Postfach. Offene oder eskalierte Vorgänge werden nie automatisch gelöscht. | ✅ (M6) |
| 3.2 | **Frist festlegen:** `aufbewahrung_tage` je Kunde (Beispiel 365). Handels- und steuerrechtliche Aufbewahrung betrifft in der Regel das Postfach bzw. die Geschäftsbriefe, nicht diese Arbeitsdaten. | ⚖️ |
| 3.3 | **n8n-Ausführungsdaten** enthalten Mail-Inhalte. Workflows mit Freigabe-Links (EPA-02, EPA-07, SW Freigabe senden, SW Nachfassen) speichern erfolgreiche Ausführungen gar nicht. Für alle anderen in n8n die Aufbewahrung begrenzen (Einstellungen: Ausführungsdaten speichern bzw. Pruning, z. B. 7–14 Tage; im Cloud-Tarif zu verifizieren). | ✅ teilweise / 🔧 |
| 3.4 | **Postfach:** Eingegangene Mails werden nie gelöscht, aussortierte nur in den Archivordner verschoben. Die Aufbewahrung im Postfach regelt der Kunde (Exchange-Aufbewahrungsrichtlinien). | 🔧 |
| 3.5 | **Betroffenenrechte** (Auskunft, Berichtigung, Löschung): Daten einer Person finden sich über `absender_adresse` in `epa_vorgaenge`, dann `vorgangs_id` in Audit und Freigaben. Vorgehen siehe Betriebshandbuch, Abschnitt „Datenschutzanfragen“. | ✅ dokumentiert / 🔧 |

## 4. Technische und organisatorische Maßnahmen (TOMs)
| Nr. | Punkt | Stand |
|---|---|---|
| 4.1 | Keine Secrets in Workflows oder Repository. Zugangsdaten nur als n8n-Credentials; eine automatische Prüfung (`tools/validate-workflows.js`) sucht nach Schlüsseln, Tokens und Passwörtern. | ✅ |
| 4.2 | Freigabe-Links: 256-Bit-Zufallstoken, nur der SHA-256-Hash gespeichert, einmalig nutzbar, mit Ablaufzeit. Der Freigeber muss weiterhin in der Config stehen. Atomare Übernahme verhindert Doppelversand. | ✅ (M3/M5) |
| 4.3 | Einziger öffentlicher Endpunkt ist EPA-07 (prüft automatisiert, dass es keinen weiteren Webhook gibt). Die Seiten senden `noindex` und Sicherheits-Header. Alle Sub-Workflows sind nur aus eigenen Workflows aufrufbar (`callerPolicy`). | ✅ |
| 4.4 | Zugriff auf n8n: persönliche Konten, 2FA aktivieren, Rechte nur für Betreuer. Wer n8n-Zugriff hat, sieht Data Tables und Ausführungen. | 🔧 |
| 4.5 | Microsoft-Berechtigungen nach Least Privilege, siehe Abschnitt 6. | 🔧 |
| 4.6 | Anhänge: Größen- und Typlimits; nichts wird ausgeführt, nur PDF-Text und Bilder an die KI. Virenscan (z. B. Defender for Office 365) vor dem Postfach empfohlen. | ✅ / 🔧 |
| 4.7 | Spoofing-Hinweis (SPF/DKIM/DMARC, Reply-To) im Vorgang; keine automatische Reaktion. | ✅ (M2) |
| 4.8 | Nachvollziehbarkeit: Audit-Log für jeden Statuswechsel, jede Übernahme und jede Freigabe (wer, wann, bearbeitet ja/nein). | ✅ |
| 4.9 | Überwachung: Watchdog EPA-06 (Heartbeats, Verbindungen, hängende Vorgänge) und Error-Handler EPA-05. | ✅ (M6) |

## 5. EU AI Act
| Nr. | Punkt | Stand |
|---|---|---|
| 5.1 | **Einordnung:** Das System unterstützt Mitarbeiter bei Routinekorrespondenz. Nach unserer Einschätzung ist es kein Hochrisiko-System nach Anhang III (keine Personalentscheidungen, keine Kreditwürdigkeit o. ä.). | ⚖️ |
| 5.2 | **Transparenz (Art. 50):** Jede ausgehende Mail trägt deterministisch den konfigurierbaren KI-Hinweis (`ki_hinweistext`, z. B. „Diese Nachricht wurde KI-gestützt vorbereitet und von einem Mitarbeiter geprüft und freigegeben.“). Er ist nicht abschaltbar und nicht vom Freigeber entfernbar. Ob und in welcher Formulierung er Pflicht ist (Ausnahme bei menschlicher Prüfung und redaktioneller Verantwortung?), ist **juristisch zu prüfen**. Die Anwendbarkeit von Art. 50 ab 2. August 2026 ist zu verifizieren. | ✅ technisch / ⚖️ |
| 5.3 | **KI-Kompetenz (Art. 4):** Mitarbeiter, die freigeben, sollten wissen, dass die KI Angaben übersehen oder falsch lesen kann und dass sie für den Inhalt verantwortlich sind. Empfehlung: kurze Einweisung, dokumentiert. | 🔧 |
| 5.4 | **Menschliche Aufsicht:** Kein Versand ohne Klick auf „Freigeben“. Ablehnen ist jederzeit möglich, Konflikte und Unklarheiten gehen an Menschen. | ✅ |
| 5.5 | **Protokollierung:** Prompt-Versionen sind fest versioniert (epa_prompts mit Prüfsumme). Das Audit-Log zeigt, welche Werte die KI geliefert hat (Quelle) und was übernommen wurde. | ✅ |

## 6. Minimale Microsoft-Berechtigungen (zu verifizieren)
| Zweck | Empfehlung |
|---|---|
| Postfach (EPA-00-Kopie) | Dienstkonto mit Zugriff nur auf das überwachte (Shared) Postfach. Delegierte Rechte `Mail.ReadWrite` und `Mail.Send` (bei Shared Mailbox `Mail.ReadWrite.Shared`, `Mail.Send.Shared`), `offline_access`. Keine Rechte auf andere Postfächer. |
| Teams (Meldungen, Freigabe-Chats, Watchdog) | Dienstkonto, Mitglied nur in den EPA-Kanälen. Delegiert `ChannelMessage.Send`, `Chat.Create`/`Chat.ReadWrite` (1:1-Chats mit Freigebern), `User.Read`. Die im n8n-Credential vorgegebenen Scopes können breiter sein; wenn möglich auf diese reduzieren. |
| Watchdog | keine zusätzlichen Rechte, nutzt dieselben Credentials für Testaufrufe (`/me`, Posteingang lesen, `/models`). |

## 7. Offen vor Produktivstart
1. AVV-Kette abschließen (Kunde ↔ TIM Agent Systems ↔ n8n, OpenAI, Microsoft).
2. Drittlandübermittlung OpenAI bewerten oder EU-Anbieter wählen.
3. Datenschutzhinweise und Verzeichnis beim Kunden ergänzen.
4. KI-Hinweistext juristisch bestätigen lassen.
5. Aufbewahrung der n8n-Ausführungsdaten in der Instanz einstellen.
6. Testbetrieb nur mit Testpostfach und Testdaten (Masterprompt Abschnitt 10).
