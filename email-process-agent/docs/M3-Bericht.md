# M3-Bericht: Rückfrage und Freigabe

Stand 2026-10-13. n8n 2.43.4, Data Tables, Freigabe Variante B (eigener Endpunkt, persönlicher Link per Teams-1:1-Chat).

## Fertig
| Bereich | Ergebnis |
|---|---|
| EPA-02 Rückfrage anfordern | Bausteine der fehlenden Felder aus der Config (C1) → KI formuliert nur Anrede, Einleitung und Schluss; Code prüft, sonst Standardvorlage (C2) → Antwortentwurf **im Thread** im Kundenpostfach (Betreff mit Vorgangs-ID) → Freigabe mit Token je Freigeber → Status „Freigabe ausstehend“ → Link per Teams-Chat (C3). Bei erreichter Rundenzahl: „Eskaliert / Manuell“ statt weiterer Rückfrage. |
| EPA-07 Freigabe-Endpunkt | Seite hinter dem Link: Empfänger, Betreff, fehlende Angaben, **bearbeitbarer Text**, „Freigeben und senden“ / „Ablehnen (mit Grund)“. Danach Versand und Statusupdate (C4). |
| SW Freigabe senden | Persönliche Teams-Nachricht im 1:1-Chat (Graph: Chat öffnen, Nachricht senden). Fehler werden protokolliert; erreicht der Link niemanden, wird der Kanal gewarnt. |
| EPA-00 Postfach-Aktionen | `entwurf_anlegen` (createReply, Body, Freigabe-ID als Extended Property), `entwurf_aktualisieren`, `entwurf_senden` (prüft vorher, ob der Entwurf noch existiert; bei Fehler Suche in „Gesendete Elemente“) |
| EPA-01 | Bei Lücken wird EPA-02 automatisch gestartet. Ein Fehler dort stoppt die Mailverarbeitung nicht, EPA-05 meldet ihn. |
| Module | `src/entwurf.js` (Bausteine, Hüllenprüfung, Vorlage, HTML), `src/freigabe.js` (Token, Prüfungen, Seiten, Teams-Text) |
| Prompt | `prompts/v1/entwurf.md` (nur Hülle, Verbotsliste, Beispiele Sie/Du/Englisch) |
| Data Tables | `epa_freigaben`, `epa_freigabe_tokens`; Config-Spalten `postfach_workflow_id`, `freigabe_basis_url` |

## Sicherheits- und Konsistenzregeln (umgesetzt und getestet)
- **Nie ohne Freigabe gesendet.** Ablauf ohne Klick führt nie zu einem Versand.
- **Bausteine wortgleich durch den Aufbau:** Die KI liefert nur Anrede, Einleitung und Schluss. Bausteine, Signatur und KI-Hinweis setzt der Code ein.
- **Prüfung der KI-Hülle:** keine Ziffern, Beträge, Links, E-Mail-Adressen, Platzhalter und Zusagewörter, Siezen eingehalten, Längenlimits. Bei einem Verstoß wird die Standardvorlage verwendet, Formular und Audit zeigen „Fallback“.
- **Datenminimierung:** Die Entwurfs-KI sieht nur Name, Betreff und die Namen der fehlenden Felder, keinen Mailinhalt.
- **Token:** 256 Bit, nur der SHA-256-Hash wird gespeichert. Jeder Token ist einmal verwendbar, läuft nach `freigabe_ablauf_stunden` ab und ist an einen Freigeber gebunden. Der Freigeber muss beim Klick noch in der Config stehen.
- **Atomare Übernahme:** Die Freigabe wird per bedingtem Update auf `status = offen` übernommen. Ein Doppelklick, ein zweites Fenster oder ein zweiter Freigeber bekommt „bereits bearbeitet“ (409).
- **Kein Doppelversand:** Kein automatischer Retry beim Senden. Bei jedem Fehler wird in „Gesendete Elemente“ nach der Freigabe-ID gesucht. Scheitert die Übernahme des bearbeiteten Textes, wird **nicht** der alte Entwurf gesendet.
- **Status erst nach bestätigtem Versand:** danach „Warten auf Kunde“, Rundenzähler +1, Antwortfrist (Geschäftszeiten/Feiertage) und die Message-ID der gesendeten Mail am Vorgang. So wird die Antwort des Kunden eindeutig zugeordnet.
- **Audit:** wer freigegeben oder abgelehnt hat, ob bearbeitet, Grund, ob die Sendung erst über „Gesendete Elemente“ bestätigt wurde.

## Getestet
1. **126 Unit- und Integrationstests** grün (1 Test braucht eine Test-Postgres und wurde übersprungen), davon 15 neu für M3.
2. **End-to-End lokal:** M3 16/16, Gesamtlauf mit M2 **52/52**, M1-Regression 14/14. Matrix in `docs/Testprotokoll-M3.md`. Die Fälle:
   - Anfordern, Formular, Freigeben, Doppelklick und zweiter Freigeber, Bearbeiten, Ablehnen (ohne und mit Grund)
   - abgelaufener Link (410), entfernter Freigeber (403), ungültiger Link (404)
   - Versandfehler (nichts gesendet, EPA-05 sichert den Vorgang), verlorene Sendebestätigung (genau ein Versand)
   - KI-Entwurf mit Zusage und Preis → Vorlage, KI-Ausfall → Vorlage, ein Freigeber nicht erreichbar
   - maximale Rundenzahl, Antwort des Kunden wird dem Vorgang zugeordnet
3. **Cloud:** alle 12 Workflows aus Commit `1bccce8` eingespielt, 0 Abweichungen. Der Entwurfs-Prompt ist eingespielt, EPA-07 ist veröffentlicht. Probe aus der Instanz: Ein ungültiger Link liefert die 404-Seite (HTML, `no-store`, `noindex`).

## Durch die Tests gefundene und behobene Fehler
1. Ist die Entwurfs-KI technisch nicht erreichbar, löste der fehlgeschlagene Sub-Workflow EPA-05 aus. Das eskalierte den Vorgang, obwohl die Vorlage einspringen konnte. → „SW LLM aufrufen“ hat die Option `fehler_als_ergebnis`.
2. Das Deploy-Skript aktualisierte Workflows alphabetisch, n8n lehnte dann einen veröffentlichten Aufrufer mit unveröffentlichtem Sub-Workflow ab. → Reihenfolge nach Abhängigkeiten (mit Test).
3. Beim Durchsehen gefunden: Ein gescheitertes Speichern des bearbeiteten Textes hätte zum Versand des alten Entwurfs geführt. → Ist jetzt gesperrt (eigene Prüfung vor dem Senden).

## Offen / zu verifizieren
- **Gegen echtes Microsoft 365 noch nicht getestet** (die Umgebung erreicht deine Instanz nur über n8n, Credentials fehlen). Zu verifizieren sind:
  - `createReply` im Shared Mailbox
  - Filter auf `internetMessageId` und auf die Extended Property in „Gesendete Elemente“
  - ob ein Entwurf vor dem Versand eine `internetMessageId` trägt
  - 1:1-Chat zwischen Dienstkonto und Freigeber
- Identität: Der Link ist an die Person gebunden, an die er geschickt wurde. Eine echte Anmeldung gibt es nicht (Variante B). Bleibt ein weitergeleiteter Link, ist das Risiko durch Ablaufzeit und Einmal-Nutzung begrenzt.
- Ein abgelaufener Link verschickt in M3 noch keinen neuen Link. Das und die Erinnerung an Freigeber kommen mit **M5**.
- Eine neue Kundenmail, während eine Freigabe offen ist, soll die Freigabe auf „ersetzt“ setzen. Das kommt mit **M4**.
- Der Entwurf überschreibt den von Outlook eingefügten zitierten Verlauf (bewusst knapp). Wenn gewünscht, kann das Zitat erhalten bleiben.
