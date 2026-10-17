# Onboarding eines neuen Kunden

Stand 2026-10-14 (M7). Ein Workflow-Satz bedient alle Kunden. Pro Kunde kommen drei Dinge hinzu: eine Config-Zeile, die Pflichtfelder mit Textbausteinen und eine Kopie des Postfach-Workflows (EPA-00).

**Aufwand (Erfahrungswert, zu verifizieren am ersten echten Kunden):**
- Workshop mit dem Kunden (Felder, Textbausteine, Freigeber, Fristen): 1–2 Stunden
- Technisches Einrichten: etwa 1 Stunde
- Testphase mit Testpostfach: 1–2 Tage Laufzeit, davon etwa 1 Stunde Arbeit

## 1. Vorab mit dem Kunden klären (Workshop)
| Thema | Ergebnis | Config-Feld |
|---|---|---|
| Welches Postfach wird überwacht? Shared Mailbox empfohlen | Adresse | `postfach` |
| Welche Vorgangsart(en)? Welche Angaben braucht der Kunde zwingend, welche optional? | Feldliste | `epa_config_pflichtfelder` |
| Fester Satz je fehlender Angabe (wird wortgleich an den Kunden geschickt) | Textbausteine | `resolution_textbaustein` |
| Wer darf Rückfragen freigeben? Vertretung? | Liste Microsoft-365-Konten | `freigeber`, `vertreter` |
| Teams-Kanal für Meldungen | Team- und Kanal-ID | `benachrichtigung` (`"kanal": "teams"`; `telegram_test` ist nur für interne Tests und nie für Kunden) |
| Anrede (Sie/Du), Sprache, Signatur | Texte | `anrede_stil`, `sprache`, `signatur` |
| KI-Hinweis in ausgehenden Mails (juristisch prüfen lassen) | Text | `ki_hinweistext` |
| Rückfragen auch in anderen Sprachen (z. B. Englisch)? Antwort folgt dann der Sprache der Kundenmail. Je Sprache: Signatur, KI-Hinweis und ein Textbaustein für jedes Feld. Ohne Eintrag wird immer in `sprache` geantwortet | Texte je Sprache | `uebersetzungen` (JSON, z. B. `{"en": {"signatur": …, "ki_hinweistext": …, "textbausteine": {"<Feldname>": …}}}`) |
| Farbige Outlook-Markierung je Status, z. B. grün „AI Geprüft“ (bereit) und rot „AI Rückfragen“ (Rückfrage läuft). Farben: Outlook-Voreinstellung `preset0` (Rot) … `preset24`, `preset4` = Grün. Leer = aus | Status → Name/Farbe | `outlook_kategorien` (JSON, z. B. `{"Bereit zur Bearbeitung": {"name": "AI Geprüft", "farbe": "preset4"}, "Warten auf Kunde": {"name": "AI Rückfragen", "farbe": "preset0"}}`) |
| Antwortfrist, Anzahl/Abstand der Erinnerungen, max. Rückfragerunden | Zahlen | `frist_stunden`, `anzahl_erinnerungen`, `erinnerung_intervall_stunden`, `max_runden` |
| Geschäftszeiten, Bundesland für Feiertage | Zeiten | `geschaeftszeiten`, `feiertage_region` |
| Aufbewahrung der Vorgangsdaten | Tage | `aufbewahrung_tage` |
| Absender, die nie bzw. immer als Anfrage gelten | Listen | `absender_blocklist`, `absender_allowlist` |
| Datenschutz: AVV, Hinweise, Verzeichnis | erledigt? | siehe `Datenschutz-und-KI-Checkliste.md` |

## 2. Microsoft 365 vorbereiten (Admin des Kunden)
1. Dienstkonto für das Postfach (Vollzugriff nur auf die Shared Mailbox) und für Teams (Mitglied im Meldekanal). Berechtigungen siehe Checkliste, Abschnitt 6.
2. Optional: `archivordner`. Standard ist leer: Jede Mail bleibt im Posteingang, auch aussortierte (Werbung, Abwesenheitsnotizen, keine Anfrage). Nur wenn der Kunde es ausdrücklich will, einen Ordner (z. B. `EPA-Archiv`) auf oberster Ebene anlegen und hier eintragen; aussortierte Mails werden dann dorthin verschoben, nie gelöscht.
3. Eigenen Teams-Kanal anlegen, z. B. „Anfragen“ (den Standardkanal „Allgemein“ kann man nicht umbenennen, er eignet sich nicht); Team-ID (GUID aus dem Link, `groupId=…`) und Kanal-ID (`19:…@thread.tacv2`) notieren.

## 3. In n8n einrichten
1. **Config anlegen:** `config/datatables/vorlage-leer.json` bzw. `config/vorlagen/epa_config_*_leer.csv` als Vorlage nehmen (Beispiel mit echten Werten: `beispiel-transport.json`). Alle `<Platzhalter>` ersetzen. `aktiv` zunächst auf `false` lassen.
   - Zeile in `epa_config_allgemein` anlegen (über die Data-Table-Oberfläche oder per CSV-Import [zu verifizieren: CSV-Import in der Cloud-Oberfläche]).
   - Je Pflichtfeld eine Zeile in `epa_config_pflichtfelder` (gleiche `kunde_id`).
     Für Felder mit einem Personennamen (Ansprechpartner) in `validierungsregel` `"person": true` setzen: Die Anrede wird entfernt, und Team-, Abteilungs- oder Firmennamen gelten als fehlend. So löst eine Signatur wie „Ihr Dispositionsteam“ eine Rückfrage aus, statt als Ansprechpartner übernommen zu werden.
2. **Postfach-Workflow:** `EPA-00 Postfach (Vorlage)` duplizieren und z. B. „EPA-00 Postfach anfragen@kunde.de“ nennen. Im Node „Postfach festlegen“ die Adresse eintragen. Das Outlook-Credential des Dienstkontos im Trigger und in allen Outlook-Graph-Nodes zuweisen, das Teams-Credential desselben Kontos in den fünf Teams-Nodes („Teams prüfen“, „Kanalmeldung senden“, „Teams-Konto lesen“, „Chat öffnen“, „Chat-Nachricht senden“). Die ID der Kopie (aus der URL) in `postfach_workflow_id` eintragen.
3. **Config prüfen:** `EPA SW Config laden` manuell mit `{"kunde_id": "<kürzel>"}` ausführen. Erwartet: `config` ohne Fehler. Fehlermeldungen nennen das Feld.
4. **Testphase:** Mit dem Testpostfach bzw. einem Testabsender 5–10 typische Mails schicken: vollständig, mit Lücken, Antwort, Newsletter, Abwesenheitsnotiz. Freigaben über die Links testen.
5. **Optional: Regeln im Google Sheet:** „EPA-10 Regel-Sheet anlegen“ ausführen und das Sheet für den Kunden freigeben (siehe `Regeln-Google-Sheets.md`).
6. **Scharf schalten:** `aktiv = true`, Postfach-Kopie veröffentlichen. EPA-04, EPA-06, EPA-08 und EPA-13 (Tagesübersicht) laufen für alle Kunden mit.
7. **Übersicht zeigen:** EPA-13 manuell starten. Der Kunde bekommt die erste Tagesübersicht mit dem Link zu seiner Übersichtsseite in seinen Kanal.

## 4. Datentrennung zwischen Kunden
- Jede Zeile in allen Tabellen trägt `kunde_id`. Die Sub-Workflows lesen und schreiben immer mit `kunde_id` im Filter (auch bei Vorgängen, Freigaben, Audit).
- Die Config wird über das Postfach gefunden (eindeutig, sonst 409). Eine Mail aus Postfach A kann keinen Vorgang von Kunde B treffen.
- Pro Kunde eigenes Outlook- und Teams-Credential in der eigenen EPA-00-Kopie (Tenant des Kunden); Freigabe-Links sind an Personen aus der Config des jeweiligen Kunden gebunden.
- Übersichtsseite (EPA-12): Der Kunde ergibt sich allein aus dem geheimen Link; gelesen werden nur Zeilen mit dessen `kunde_id`.
- Grenze: Alle Kunden liegen in denselben Data Tables einer n8n-Instanz. Wer n8n-Zugriff hat, sieht alle Kunden. Für strenge Trennung eine eigene n8n-Instanz bzw. ein eigenes Projekt je Kunde verwenden (Workflows einfach erneut ausrollen).

## 5. Checkliste zum Abhaken
- [ ] Workshop durchgeführt, Felder und Textbausteine abgestimmt
- [ ] AVV und Datenschutzhinweise geklärt
- [ ] Dienstkonten und Rechte eingerichtet (Archivordner nur, wenn der Kunde Verschieben ausdrücklich will)
- [ ] Config ohne Platzhalter, `EPA SW Config laden` ohne Fehler
- [ ] EPA-00-Kopie mit Outlook- und Teams-Credential, ID in `postfach_workflow_id`
- [ ] Freigeber haben einen Test-Link erhalten und geöffnet
- [ ] Testmails durchgespielt (vollständig, Lücke, Antwort, Erinnerung, Spam)
- [ ] `aktiv = true`, Postfach-Kopie veröffentlicht
- [ ] Watchdog meldet „Alles in Ordnung“ am Folgetag
