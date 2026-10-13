# M2-Bericht: Eingang, Zuordnung, Klassifizierung, Extraktion, Pflichtfelder

Stand 2026-10-13. n8n 2.43.4, Speicher n8n Data Tables, LLM OpenAI (Chat Completions mit Structured Output).

## Fertig
| Bereich | Ergebnis |
|---|---|
| EPA-00 Postfach (Vorlage) | Outlook-Trigger (Polling, nur Posteingang). Jede Mail läuft als eigene Ausführung (Selbstaufruf). Graph lädt Header und Anhänge, PDF-Text über „Extract from File“, Bilder als Base64 für die KI. Aussortierte Mails werden in den Archivordner verschoben, nie gelöscht. |
| EPA-01 Eingang verarbeiten | Config laden, Mail normalisieren, Schleifenschutz und Auto-Replies, Dedupe, Zuordnung (Punkteliste), Klassifizierung, Extraktion, Pflichtfeld-Prüfung, Speichern mit Versionsprüfung, Statusweiche, Teams-Meldung. Ohne Microsoft-Zugänge testbar. |
| EPA SW LLM aufrufen | Prompt aus `epa_prompts`, dynamisches JSON-Schema, eigener Validator. 429, 5xx und Timeout werden bis zu 3-mal mit Retry-After/Backoff wiederholt, 401/403/400 sofort als Fehler. Ein Korrekturversuch bei ungültigem JSON, danach 422. |
| EPA SW Benachrichtigen | Teams-Kanal aus der Config. Ein Versandfehler bricht nichts ab, sondern landet im Fehlerlog (für den Watchdog in M6). |
| Module (`src/`) | `mailNormalisieren` (Betreff, HTML → Text, Zitate abschneiden, Auto-Reply, Newsletter-Indizien, Spoofing-Basisprüfung, Anhang-Limits), `zuordnung`, `pflichtfelder` (Typen, Platzhalter, Normalisierung), `llmSchema`, `eingang` (Dedupe, Klassen-Auswertung, Meldungstexte) |
| Prompts | `prompts/v1/klassifizierung.md`, `prompts/v1/extraktion.md`: Deutsch, mit Sicherheitsregeln, Verbotsliste und Beispielen (Weiterleitung, Englisch, Injection). Versioniert; eine Änderung wird als neue Version angelegt. |
| Data Tables neu | `epa_verarbeitete_mails` (Dedupe), `epa_prompts` |
| EPA-05 erweitert | gibt bei Fehlern den Eingang wieder frei (erneute Verarbeitung möglich), kein Doppelalarm mehr bei Fehlern in Sub-Workflows, Teams ohne n8n-Werbelink |

## Entscheidungen
1. **Header nachladen:** Der Outlook-Trigger liefert kein `internetMessageHeaders`. Deshalb lädt „Mail laden“ die Mail per Graph nach. Ohne In-Reply-To, References, Auto-Submitted und Authentication-Results wären Zuordnung, Schleifenschutz und Spoofing-Prüfung nicht möglich.
2. **Bilder/Scans über OpenAI Vision statt Azure OCR:** Es ist derselbe Auftragsverarbeiter wie für den Text, und es braucht keinen weiteren Dienst. Eingescannte PDFs ohne Textebene werden nicht per OCR gelesen. Sie werden als „ohne Textebene, bitte manuell prüfen“ gemeldet. OCR für Scans wäre eine spätere Option.
3. **Zuordnungsgewicht:** „Vorgangs-ID genannt“ zählt 60 statt 50 Punkte. Damit reicht „ID genannt + gleicher Absender“ (85) für eine eindeutige Zuordnung. Ein Konfliktmarker (Thread passt, fremde Domain) führt immer zu „Zuordnung unklar“, nie zu einem neuen Vorgang.
4. **Allowlist:** Absender auf der Allowlist werden nie automatisch als „keine Anfrage“ aussortiert, sondern gehen an einen Mitarbeiter.
5. **Datum ohne Jahr:** „20.10.“ wird deterministisch im Code auf das nächste Vorkommen ab heute gesetzt, nicht vom LLM. Relative Angaben wie „nächsten Dienstag“ gelten als fehlend.
6. **LLM-Basis-URL** pro Aufgabe in `llm_profil.basis_url` (Standard `https://api.openai.com/v1`). Damit ist ein EU-Endpunkt bzw. EU-Datenresidenz möglich [zu verifizieren: Verfügbarkeit für dein OpenAI-Konto].
7. **Strukturierte Ausgabe:** An OpenAI geht ein auf Kern-Schlüsselwörter reduziertes Schema (strict). Längen, Bereiche und Muster prüft danach der eigene Validator.

## Getestet
1. **112 Unit- und Integrationstests** (`npm test`, 111 bestanden, 1 nur mit Test-Postgres), davon 45 neu für M2 (plus 1 im Deploy-Test).
2. **End-to-End lokal (n8n 2.43.4):** 36 Testmails mit Mock-LLM und Mock-Graph, **36/36 bestanden** (zwei vollständige Läufe vor und einer nach der letzten Änderung an EPA-05; die Fehlerfälle zusätzlich einzeln nach der Änderung). Matrix siehe `docs/Testprotokoll-M2.md`. Abgedeckt sind:
   - vollständig, eine und mehrere Lücken, Platzhalter, ungültige PLZ, Datum in der Vergangenheit
   - Newsletter, Spam, Danke-Mail
   - Out-of-Office (Header und Betreff), Unzustellbarkeit, eigene Mail, Blockliste
   - Duplikat, Antwort im Thread, zwei offene Vorgänge desselben Absenders, Dritter im Thread
   - KI unsicher, Konfidenz unter Schwelle, Prompt-Injection (Datenblock nicht verlassbar), Englisch, sehr lange Mail, zitierter Verlauf wird nicht an die KI gegeben, Spoofing-Hinweis, Allowlist, leere Mail
   - 429 mit Retry-After, ein Korrekturversuch, zweimal ungültig → 422/Eskaliert, dauerhaft 500 → EPA-05 mit erneuter Verarbeitung danach, 401
   - PDF-Anhang, Foto, kaputter/leerer/unerlaubter Anhang, Archivierung über das Postfach
3. **M1-Regression:** 14/14 grün nach dem Umbau von EPA-05.
4. **Cloud-Instanz:** alle 9 Workflows aus Commit `50f1cce` eingespielt und abgeglichen (0 Abweichungen), Prompts eingespielt, die 4 Sub-Workflows aus M1 wieder veröffentlicht.

**Wichtig:** Das Mock-LLM liefert vorgegebene Antworten. Getestet ist damit die Verarbeitungskette, **nicht** die Trefferqualität von OpenAI. Die Gegenprobe mit dem echten Modell und echten Mails folgt, sobald Credentials und Testpostfach in der Instanz eingerichtet sind.

## Durch die Tests gefundene und behobene Fehler
1. Ein Fehler in einem Sub-Workflow löste EPA-05 zweimal aus (Sub-Workflow und Aufrufer). Folge: doppelter Fehlerlog-Eintrag und doppelter Alarm. → Der Aufrufer gibt jetzt nur noch den Eingang frei.
2. Ohne Ergebnis-Node gab EPA-00 das Ergebnis der Archivierung zurück statt des Verarbeitungsergebnisses. → Node „Ergebnis melden“ ergänzt.
3. Das Deploy-Skript übertrug Credentials nur nach Node-Typ. HTTP-Nodes für OpenAI und Outlook wären dadurch vermischt worden. → Credentials werden jetzt je Credential-Typ übertragen.

## Offen / zu verifizieren
- **Scharfschalten (bei dir):** Credentials zuweisen (OpenAI, Teams, Outlook) und die Config ausfüllen. Reihenfolge siehe `docs/Instanz-timbaule.md`.
- Live-Test mit echtem Postfach und echtem OpenAI-Modell, inklusive Messung der Klassifizierungsqualität mit den Testmails.
- [zu verifizieren] Ob der Outlook-Trigger in deinem Tenant Shared Mailboxes mit dem Credential-Schalter „Use Shared Mailbox“ korrekt abfragt.
- [zu verifizieren] Limit der Zellgröße in Data Tables in der Cloud (Prompts ca. 3,5 KB, extrahierte Daten wenige KB, unkritisch erwartet).
- Wenn eine Mail während eines Ausfalls von n8n eingeht, holt der Trigger sie nach (Zeitfenster seit der letzten Abfrage). Wenn dagegen eine Verarbeitung fehlschlägt, gibt es keinen automatischen zweiten Versuch. Der Fehler wird gemeldet und die Mail bleibt im Posteingang. Ein Nachholen ungelesener Mails übernimmt der Watchdog in M6.
- Die Postgres-Variante bleibt auf dem Stand von M1.
- „Zugeordnet“ meldet in M2 nur. Die Antwortverarbeitung (Merge) folgt in M4, die Rückfrage mit Freigabe in M3.
