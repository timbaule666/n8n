# Stand in der Instanz timbaule.app.n8n.cloud

Stand 2026-10-14 (M6). Speicher: **n8n Data Tables** (persönliches Projekt).

## Workflows
| Workflow | ID | Nodes | Status |
|---|---|---|---|
| EPA SW Audit schreiben | `SPKLbe2MY028CKtn` | 5 | veröffentlicht |
| EPA SW Config laden | `hbeJAwoqdebivRSQ` | 7 | veröffentlicht |
| EPA SW Status setzen | `xwBsSqK1LVgMuQx4` | 12 | veröffentlicht |
| EPA SW Vorgang verwalten | `EixHJ4vRqMIGcyuL` | 32 | veröffentlicht |
| EPA-05 Error-Handler | `nMkGyI82z0mwm9ud` | 18 | Entwurf, Teams-IDs und Credential fehlen noch |
| EPA SW LLM aufrufen | `VNTqDuobRAqqj4Y7` | 13 | **veröffentlicht**, Credential „OpenAI account“ zugewiesen (Testphase) |
| EPA SW Benachrichtigen | `KLzgK5VQCop0z9QA` | 9 | Entwurf, Teams-Credential fehlt |
| EPA-01 Eingang verarbeiten | `W1j7GzjIxdjtQkVS` | 41 | Entwurf (veröffentlichbar nach EPA-02) |
| EPA-00 Postfach (Vorlage) | `fi1VnvQ26qBQ8aMQ` | 43 | Vorlage, je Postfach duplizieren (enthält ab M3 die Postfach-Aktionen für Entwurf/Versand) |
| EPA SW Freigabe senden | `41ZGdeyiNVWwrJfW` | 11 | Entwurf, Teams-Credential fehlt (3 Graph-Nodes) |
| EPA-02 Rückfrage anfordern | `aSdEMSgPSxhnQKMi` | 26 | Entwurf (veröffentlichbar nach SW LLM, SW Benachrichtigen, SW Freigabe senden) |
| EPA-03 Antwort verarbeiten | `R83VDuvm7aML2HwH` | 32 | Entwurf (veröffentlichbar nach EPA-02) |
| EPA SW Nachfassen | `XzWGKZPK0HGb6Si7` | 34 | Entwurf (veröffentlichbar nach EPA-02) |
| EPA-04 Nachfassen und Eskalation | `OvSzCe83KeiTLnkN` | 24 | Entwurf (veröffentlichbar nach EPA SW Nachfassen; Zeitplan stündlich) |
| EPA-06 Watchdog | `wkAkeJjhOwsTBJKd` | 23 | Entwurf: OpenAI zugewiesen; Teams-IDs (Betriebskanal) und Teams-Credential fehlen |
| EPA-08 Löschjob | `SKBmXLzixbf2Unl4` | 30 | Entwurf, bewusst nicht veröffentlicht: erst nach Probelauf und Freigabe durch dich |
| EPA-T1 KI-Qualität prüfen | `AowNJzPlsxBHFFQJ` | 15 | **veröffentlicht**, Testphase-Prüfstand (Commit `c128407`). Start per Workflow „EPA-TEST Stufe 1 starten“ (`pQaNkaXL3yHE8RKJ`, Kunde `epa-ki-test`) |
| EPA-07 Freigabe-Endpunkt | `xj4e8E82vccdoiXl` | 41 | **veröffentlicht**, Link: `https://timbaule.app.n8n.cloud/webhook/epa-freigabe` (Probe: ungültiger Link → 404-Seite) |

M6: eingespielt aus `workflows/` vom Commit `f3a7fb3`, EPA-07 danach aus `302cd9f` (M5: `cf2bfa8`, M4: `8d36300`, M3: `1bccce8`, M2: `50f1cce`, M1: `b195eb6`), direkt von GitHub geladen. Danach wurde jeder Node mit der Quelle abgeglichen (Typ, Version, Parameter): 0 Abweichungen.

## Data Tables
| Tabelle | ID | Inhalt |
|---|---|---|
| epa_config_allgemein | `oTBuAY0RpfLKghRX` | Beispielkunde `beispiel-transport` (mit Platzhaltern) |
| epa_config_pflichtfelder | `NclQNQq8EXyXXs6j` | 10 Felder Transportanfrage |
| epa_vorgaenge | `CI1WPpgTEMgt9laD` | leer |
| epa_audit_log | `sfxpMPAFEHqHA8Of` | leer |
| epa_fehler_log | `p6qBzQhHBJFe4sT4` | leer |
| epa_verarbeitete_mails | `Be0xzQpjxTlYWuOg` | leer (Dedupe, M2) |
| epa_prompts | `RLIt1PFeEq9CJsST` | klassifizierung/v1 und v2, extraktion/v1, entwurf/v1 (Prüfsummen wie im Repo); epa-test nutzt klassifizierung/v2 |
| epa_freigaben | `HDUhqBQV5ZxG6lzl` | leer (M3; ab M5 Spalten `erinnert_am`, `erneuert_am`; ab M6 `entwurf_entfernt_am`) |
| epa_freigabe_tokens | `y7kKOYkDuAo7r5lr` | leer (nur SHA-256-Hashes; ab M5 Spalte `ablauf`) |
| epa_test_ki_faelle | `wfEcVNTEmqgX4MZk` | 15 synthetische KI-Testfälle (S01–S15) |
| epa_test_ki_ergebnisse | `qulil8k9xv3ji8ZI` | leer (Ergebnisse des Prüfstands) |
| epa_system_status | `PfrSmbclvoZa3zcN` | Lock-Zeile `epa04_lauf` (frei) (M5) |

Testphase: In `epa_config_allgemein`/`epa_config_pflichtfelder` steht zusätzlich der Kunde `epa-ki-test` (nur für den KI-Prüfstand; erfundenes Postfach `ki-pruefstand@epa-test.invalid`, kein Postfach-Workflow). Vor dem Produktivstart deaktivieren oder löschen.

`epa_config_allgemein` hat ab M6 zusätzlich `stille_alarm_stunden` (leer = aus). Seit M3 gibt es die Spalten `postfach_workflow_id` (ID der EPA-00-Kopie des Kunden) und `freigabe_basis_url` (optional, sonst automatisch).

## Kurztest in der Instanz (manuell ausgeführt, Testdaten danach gelöscht)
| Fall | Ergebnis |
|---|---|
| Vorgang anlegen | ok: V-2026-0001, Status Neu |
| Status Neu -> In Prüfung (KI) | ok: Version 2, Audit geschrieben |
| Unzulässiger Statuswechsel | ok: 409 UNZULAESSIGER_STATUSWECHSEL |
| Aktualisieren mit falscher Version | ok: 409 VERSIONSKONFLIKT |
| Aktualisieren korrekt | ok: Version 3, Message-IDs ergänzt |
| Sperre A / Sperre B | ok: A gesperrt, B abgewiesen |
| Kandidaten über Message-ID | ok: 1 Treffer |
| Config mit Platzhaltern | ok: 424 KONFIGURATIONSFEHLER (gewollt) |

Hinweis: Vorgangs-IDs entstehen aus der fortlaufenden Zeilennummer. Gelöschte Zeilen werden nicht wiederverwendet, der nächste echte Vorgang bekommt daher V-2026-0002.

## Offen
0. **Reihenfolge zum Scharfschalten (M2+M3):**
   1. Credentials zuweisen: OpenAI in „EPA SW LLM aufrufen“ (Node „OpenAI aufrufen“); Teams (Dienstkonto) in „EPA SW Benachrichtigen“ und in den 3 Graph-Nodes von „EPA SW Freigabe senden“.
   2. Veröffentlichen in dieser Reihenfolge: SW LLM aufrufen, SW Benachrichtigen, SW Freigabe senden → EPA-02 → EPA-03 → EPA-01, danach EPA SW Nachfassen → EPA-04, EPA-06 (nach Eintrag des Betriebskanals). EPA-08 erst nach einem Probelauf.
   3. EPA-00 duplizieren, Postfach im Node „Postfach festlegen“ eintragen, Outlook-Credential in Trigger und allen Graph-Nodes zuweisen, Archivordner anlegen, veröffentlichen.
   4. Die ID dieser Kopie (aus der URL) in `epa_config_allgemein.postfach_workflow_id` eintragen.
   Erst danach läuft echte Post. Gesendet wird nie ohne Klick auf „Freigeben“.
1. **Config ausfüllen** (Data Table `epa_config_allgemein`, Zeile `beispiel-transport`): `postfach`, `freigeber` (JSON-Liste), in `benachrichtigung` die Team- und Kanal-ID, in `signatur` die Telefonnummer. Solange Platzhalter drinstehen, lehnt „EPA SW Config laden“ die Config bewusst ab.
2. **EPA-05**: Im Node „Entwickler-Kanal alarmieren“ Team (GUID) und Kanal eintragen und das Teams-Credential prüfen. Danach EPA-05 veröffentlichen und in den vier Sub-Workflows als Error Workflow eintragen. Das kann ich übernehmen, sobald die IDs da sind.
3. Das Credential „n8n account“ hat eine ungültige Basis-URL („Invalid URL“), „n8n account 2“ funktioniert.

## Credentials (Stand 2026-10-14)
Angemeldet über „Connect my account“ von n8n Cloud, ohne eigene Entra-App.

| Credential | Zugewiesen in |
|---|---|
| OpenAI account | EPA SW LLM aufrufen, EPA-06 („KI prüfen“) |
| Microsoft Teams account | EPA-05, EPA-06 („Teams prüfen“, „Betriebskanal benachrichtigen“), EPA SW Benachrichtigen, EPA SW Freigabe senden (3 Nodes) |
| Microsoft Outlook account | EPA-00 Postfach (Vorlage): Trigger und 15 Graph-Nodes. Kopien übernehmen das Credential. |

Die Workflow-Namen tragen auf Wunsch weiterhin das „ *“. Veröffentlicht ist davon noch nichts. Offen sind Teams-IDs, Postfach-Adresse, Freigeber und die Rechte der n8n-App (Stufe 0).

## Interner Testkanal Telegram (Stand 2026-10-14)
Tims privates Microsoft-Konto hat keine Teams-Lizenz. Microsoft antwortet auf Graph-Aufrufe für Teams mit 401 „requires a valid license“. Für Tests gehen Meldungen deshalb über Telegram (nicht für Kunden, siehe Testphase.md).

| Was | Stand |
|---|---|
| EPA-T2 Telegram senden (Test) * | ID `HSD3za9kE5L0IMyv`, Credential „Error Guard“ (bestehender Bot), veröffentlicht; Verbindungstest an Chat 8961899217 zugestellt |
| `epa_system_status` | Spalten `alarm_kanal`, `telegram_chat_id`, `telegram_workflow_id` ergänzt; Zeile `alarmierung` angelegt: alarm_kanal = telegram_test, Chat 8961899217, EPA-T2 |
| Outlook- und Teams-Credential | HTTP-Request-Sperre aufgehoben (Allowed Domains: graph.microsoft.com); Outlook-Postfach per Graph lesbar |
| Workflows | 17 Workflows auf Stand eb0411d, 0 Abweichungen; Sternchen und Credentials erhalten; vorher aktive neu veröffentlicht |

## Stufe 0 (2026-10-14)
- Testkunde `epa-test`: Postfach timbaule666@outlook.com, Freigeber Tim (Kennung timbaule666@gmail.com, Links per Telegram), Kanal telegram_test an Chat 8961899217, Felder aus dem Transport-Beispiel. Noch ohne Postfach-Kopie (EPA-00): Die würde sofort die vorhandenen Mails verarbeiten (Stufe 3).
- `epa-ki-test` (Prüfstand) ebenfalls auf telegram_test, damit der Watchdog Teams nicht prüft.
- EPA-05 und EPA-06 sind **veröffentlicht**. Ihre Teams-Nodes („Entwickler-Kanal alarmieren“, „Betriebskanal benachrichtigen“) sind nur in dieser Instanz deaktiviert, weil sie ohne Team-ID nicht veröffentlicht werden können. Ein erneutes Deploy aktiviert sie wieder; danach erneut deaktivieren oder Team-IDs eintragen.
- Watchdog-Lauf: Meldung per Telegram zugestellt, einziger Befund CRON_NIE (EPA-04 noch aus).

## Stufe 3 gestartet (2026-10-14, ca. 21:20)
- Ordner `EPA-Archiv` im Testpostfach angelegt (oberste Ebene). Tims alte Mails liegen im Ordner „Archiv“, im Posteingang liegt nur eine alte Mail vom 27.08.; sie wird nicht verarbeitet (der Trigger holt nur neue Mails, seit Einschalten keine Ausführung).
- Postfach-Kopie „EPA-00 Postfach timbaule666@outlook.com (Test)“, ID `RXWxIBLIIOdXtBcO`, Outlook-Credential übernommen, in `epa-test.postfach_workflow_id` eingetragen.
- Error Workflow EPA-05 in allen EPA-Workflows gesetzt.
- Veröffentlicht: alle SW-Workflows, EPA-01, EPA-02, EPA-03, EPA-04, EPA-05, EPA-06, EPA-07, EPA-T1, EPA-T2 und die Postfach-Kopie. Nicht veröffentlicht: EPA-00-Vorlage, EPA-08 Löschjob (für E12 manuell).

## Outlook-Markierungen (Stand 2026-10-15)

- **Neuer Workflow:** `EPA SW Outlook-Kategorie` (QEbQG7EDkytoxYPJ). SW Status setzen startet ihn nach jedem Statuswechsel, ohne auf ihn zu warten.
- **Config epa-test, Spalte `outlook_kategorien`:**
  - „Bereit zur Bearbeitung“ → grün „AI Geprüft“ (`preset4`)
  - „Freigabe ausstehend“ und „Warten auf Kunde“ → rot „AI Rückfragen“ (`preset0`)
- **Live-Test K01/K02 bestanden:**
  - Beide Kategorien wurden mit Farbe im Postfach angelegt. Die Outlook-Verbindung reicht dafür, ein Anlegen von Hand ist nicht nötig.
  - Die Kundenmails sind markiert: K01 grün, K02 rot.
- **Ältere Vorgänge** bekommen eine Markierung erst beim nächsten Statuswechsel.
- **Die Postfach-Kopie** wurde mit erhaltenem Node „Postfach festlegen“ und erhaltenen Credentials aktualisiert. Neue Graph-Nodes übernehmen die Outlook-Credential der bestehenden Nodes.

## Regeln aus Google Sheets (Stand 2026-10-15)
- **Workflows:**
  - `EPA SW Regeln abgleichen` (ttMWwOEr1VeXA6y5)
  - `EPA-09 Regeln aus Google Sheets` (UtUBJFBzhBtPEbnU), veröffentlicht, alle 15 Minuten
  - `EPA-10 Regel-Sheet anlegen` (ZJDEyyCmzs2D9CCB)
  - `EPA-11 Zustelltest` (kiyktrf6wjHK7EXw): täglich 07:40, Prüfadresse timbaule666@gmail.com (Gmail-Credential „Gmail account“). Erster Lauf 16.10.2026 11:33: Testmail nicht angekommen, Warnung an Telegram zugestellt.
- **Credential:** „Google Sheets account“ (googleSheetsOAuth2Api).
- **Spalte:** `config_sheet` in epa_config_allgemein angelegt.
- **Test-Sheet für epa-test** (in Tims Google Drive): https://docs.google.com/spreadsheets/d/12qa5Ic_-LLxbxGiG0uGEHwbsM-NGNfLyXOnkUjlPfjo/edit
- **Live-Test** (Werte danach zurückgesetzt):

  | Test | Ergebnis |
  |---|---|
  | Unverändertes Sheet | „Keine Änderung“, keine Meldung |
  | Antwortfrist „zwei Tage“ | Fehler, nichts übernommen, Status im Sheet, eine Telegram-Meldung |
  | Antwortfrist 72 | übernommen, nur `frist_stunden` geändert, Audit-Eintrag |
  | Rückfrage-Text Telefon | übernommen, nur `resolution_textbaustein` geändert |
- **Andere Workflows:** Die übrigen Workflows mit eingebettetem Config-Validator sind auf Commit 2678b5f aktualisiert (Spalte `config_sheet`).
- **Gelbe Markierung (2026-10-15):** „AI Wartet“ (preset3) bei „Warten auf Kunde“. Rot „AI Rückfragen“ gilt nur noch bei „Freigabe ausstehend“.
  - Im Test-Sheet steht dafür die neue Zeile 24; der Abgleich hat sie übernommen.
  - Vorgänge, die schon auf den Kunden warten, behalten Rot bis zum nächsten Statuswechsel.
- **Testmails K04/K05 (2026-10-15):**
  - K04, vollständige Anfrage (V-2026-0084): „bereit“, Markierung „AI Geprüft“ gesetzt.
  - K05, Einladung (V-2026-0085): still „ignoriert“, keine Meldung, Mail bleibt im Posteingang.
- **Abschluss-Meldung mit Verlauf (2026-10-15):** Wird eine Anfrage durch eine Antwort vollständig, enthält die Telegram-Meldung:
  - Kunde
  - erste Anfrage (Datum + Outlook-Link)
  - Antwort (Datum + Link)
  - Rückfrage-Runden
  - „Bisherige Informationen“ und „Nachgeforderte Informationen“

  Neue Spalten `erste_mail_am` und `erste_mail_link` in epa_vorgaenge. Gilt für Vorgänge ab 19:00; bei V-2026-0086 sind die Werte nachgetragen.

## Zweiter Testkunde `epa-m365` mit Microsoft 365 und Teams (Stand 2026-10-17)

Tim hat einen Microsoft-365-Business-Basic-Testzugang (Tenant `agentdemo666.onmicrosoft.com`) angelegt. Damit lässt sich Teams erstmals testen; das private outlook.com-Konto hat dafür keine Schnittstelle.

| Was | Stand |
|---|---|
| Credentials | „Microsoft Outlook account 2“ (`ahmYUBFC0yGuvTLu`) und „Microsoft Teams account 2“ (`lSRi3VbAUwbPKsVl`), beide angemeldet als Agent-Konto, seit 26.10. `demo@tb-agenttest.de` (vorher TimBaule@agentdemo666.onmicrosoft.com; umbenannt ohne Reconnect). Lesetest: Postfach, Team „agentdemo“ und Kanal „General“ erreichbar |
| Postfach-Kopie | „EPA-00 Postfach demo@tb-agenttest.de (Test)“ (bis 26.10. „… timbaule@agentdemo666.onmicrosoft.com …“), ID `NezOVz8ylWItOHcU`, aus der bestehenden Kopie erzeugt, 21 Outlook-Nodes auf das neue Credential umgestellt, veröffentlicht |
| Teams-Credential | In SW Benachrichtigen, SW Freigabe senden (3 Nodes), EPA-05 und EPA-06 auf „Microsoft Teams account 2“ umgestellt und neu veröffentlicht. Die Alarm-Nodes in EPA-05/EPA-06 bleiben deaktiviert; Betreiberalarme gehen weiter per Telegram |
| Config | `epa-m365` in `epa_config_allgemein` und 10 Pflichtfelder (wie `epa-test`), Kanal `teams` mit Team `agentdemo` / Kanal `Anfragen` (seit 17.10. nachmittags; vorher `General`/„Allgemein“, der sich in Teams nicht umbenennen lässt), Freigeber `disponent@agentdemo666.onmicrosoft.com` (Benutzer „Disponent“, bis 17.10. nachmittags `tim@…`), Signatur „Testsystem 2“, ohne Config-Sheet. „SW Config laden“ akzeptiert die Config |
| Verbindungstest | Meldung über SW Benachrichtigen in den Kanal „General“: gesendet |
| EPA-T3 | Parameter `ziel` (`outlook` = Standard, `m365`); die Rückfragesuche in Gmail nutzt die jeweilige Absenderadresse |
| Probelauf | Bestanden: Gmail-Anfrage „Wuppertal – Solingen“ → Meldung im Kanal → Freigabe-Link im 1:1-Teams-Chat des Disponenten → freigegeben → Rückfrage in Gmail angekommen → Kundenantwort → V-2026-0130 „Bereit zur Bearbeitung“. Vorher (V-2026-0129) war der Freigeber falsch eingetragen: „Chat öffnen“ lieferte 404, EPA-02 meldete das korrekt im Kanal. Der 1:1-Chat braucht zwei verschiedene Benutzer im Tenant |


### Eigene Domain tb-agenttest.de (26.10.)
Der Versand aus dem Tenant mit der Standardadresse `…@agentdemo666.onmicrosoft.com` kam nicht an (Zustelltest täglich „nicht_angekommen“). Lösung:
- Domain `tb-agenttest.de` bei IONOS registriert und im M365 Admin Center hinzugefügt (Status „Fehlerfrei“: MX, SPF, Autodiscover).
- DKIM: CNAME `selector1._domainkey` und `selector2._domainkey` bei IONOS, Signierung in Microsoft Defender aktiviert.
- DMARC: TXT `_dmarc` = `v=DMARC1; p=none;`.
- Agent-Benutzer umbenannt in `demo@tb-agenttest.de`; Config `epa-m365.postfach` und Node „Postfach festlegen“ der Kopie angepasst.
- Zustelltest 26.10. 15:10: Testmail nach 2 Minuten im Gmail-Posteingang (nicht Spam).
- Offen: M365-Testphase endet 17.11.2026 – vorher Abo abschließen oder kündigen.

## Direkt in Outlook gesendete Entwürfe (Stand 2026-10-17)
- **Anlass:** Tim hat den Entwurf zu V-2026-0129 direkt in Outlook gesendet. Die Freigabe blieb „offen“ und der Vorgang auf „Freigabe ausstehend“.
- **Neu (Commit 35e6338):**
  - EPA-00-Aktion `versand_pruefen`: Sucht in „Gesendete Elemente“ nach der Freigabe-Kennung. Live geprüft: Die Kennung bleibt auch beim Senden von Hand erhalten.
  - EPA-04 prüft in jedem Lauf zuerst alle offenen Freigaben.
  - SW Nachfassen vermerkt danach den Versand, sperrt die Links, setzt „Warten auf Kunde“ mit Frist und meldet es im Kanal.
- **Eingespielt in:**
  - die Vorlage (bleibt aus)
  - beide Postfach-Kopien (Postfach und Credentials erhalten)
  - SW Nachfassen
  - EPA-04
- **Live-Test:**
  - Ergebnis des EPA-04-Laufs: `versand_pruefen:manuell_gesendet: 1`.
  - V-2026-0129 steht jetzt auf „Warten auf Kunde“.
  - Die Freigabe ist mit `entscheidung = manuell_gesendet`, Versandzeit 09:31:57 und Message-ID vermerkt.
- **Nebenbefund:** EPA-04 meldet `ungueltige_configs: beispiel-transport` (Beispielkunde mit Platzhaltern, aktiv). Das ist bekannt und folgenlos, weil der Kunde keine Vorgänge hat.

## Nur noch Microsoft 365 (Stand 2026-10-17, auf Wunsch von Tim)

**Kanäle**

| Kanal | Wofür |
|---|---|
| Postfach demo@tb-agenttest.de (Kopie `NezOVz8ylWItOHcU`) | Kundenmails |
| Teams-Kanal „Allgemein“ (Team agentdemo) | Meldungen an Mitarbeiter |
| Teams-1:1-Chat an tim@agentdemo666.onmicrosoft.com (Disponent) | Freigabe-Links |
| Telegram (Zeile `alarmierung` in `epa_system_status`, Chat 8961899217) | **nur Störungsmeldungen** an den Betreiber: EPA-05 Fehler, EPA-06 Watchdog, EPA-11 Zustelltest |

**Was abgeschaltet wurde**

| Was | Stand |
|---|---|
| Kunde `epa-test` (outlook.com, Telegram) | `aktiv = false`, Zeile bleibt erhalten |
| Postfach-Kopie „EPA-00 Postfach timbaule666@outlook.com (Test)“ (`RXWxIBLIIOdXtBcO`) | unveröffentlicht und archiviert; in n8n wiederherstellbar |
| Beispielkunde `beispiel-transport` | `aktiv = false` (hatte Platzhalter, EPA-04 meldete ihn als ungültig) |

**Was geändert wurde**
- **`epa-m365`:** übernimmt die englischen Übersetzungen von `epa-test`.
- **EPA-T3:** sendet nur noch an das Microsoft-365-Postfach. Der Parameter `ziel` entfällt.

**Was bleibt**
- **`epa-ki-test`:** Der KI-Prüfstand (EPA-T1, ohne Postfach) meldet weiter per Telegram. Das ist nur ein interner Test und keine Kundenmeldung.
- **Credentials:**
  - Nicht mehr benutzt werden „Microsoft Teams account“ und, außerhalb der EPA-00-Vorlage, „Microsoft Outlook account“.
  - Die Vorlage bekommt ohnehin je Kunde ein eigenes Credential.
  - Die beiden alten Credentials können gelöscht werden, wenn das outlook.com-Konto nicht mehr gebraucht wird.

## Aufräumen (Stand 2026-10-17)

**Gelöschte Testdaten**
- Gelöscht wurden alle Daten des alten Testkunden `epa-test`:
  - 128 Vorgänge
  - 44 Freigaben
  - 58 Freigabe-Links
  - 767 Audit-Einträge
  - 157 Einträge in `epa_verarbeitete_mails`
- Erhalten bleiben die Vorgänge V-2026-0129 und V-2026-0130 des Kunden `epa-m365`. Sie dienen noch für die Live-Tests von Erinnerung und Eskalation.

**Fixes**

| Fix | Commit |
|---|---|
| Anrede bei weitergeleiteten Mails neutral (Befund N08) | 0ac0317, eingespielt in EPA-02, EPA-07 und SW Nachfassen |
| EPA-07 speichert erfolgreiche Ausführungen nicht mehr | in der Instanz umgestellt |
| `tools/epa-t3-testmails.sdk.js` entspricht wieder der n8n-Fassung | 0ac0317 |

**Archivierte Workflows** (in n8n wiederherstellbar)
- EPA-T1 KI-Qualität prüfen
- EPA-TEST Stufe 1 starten
- EPA-00 Postfach timbaule666@outlook.com (Test)
- alle temporären Hilfs-Workflows

Der Kunde `epa-ki-test` ist deaktiviert. Aktiv ist damit nur noch `epa-m365`.

**Bleiben bewusst**

| Workflow | Grund |
|---|---|
| EPA-00 Vorlage | für neue Kunden |
| EPA-08 Löschjob | Datenschutz, noch nicht scharf |
| EPA-09, EPA-10, SW Regeln abgleichen | Regeln aus Google Sheets |
| EPA-T2 Telegram | Störungsmeldungen |
| EPA-T3 Testmails | für weitere Live-Tests; kann vor dem Produktivbetrieb weg |

## Teams-Credential je Kunde (Stand 2026-10-17, Commit 90ead9b)
- **Neu in der Postfach-Kopie:** Jede EPA-00-Kopie enthält jetzt neben dem Outlook-Credential auch das Teams-Credential des Kunden. Es steckt in 5 Nodes: „Teams prüfen“, „Kanalmeldung senden“, „Teams-Konto lesen“, „Chat öffnen“ und „Chat-Nachricht senden“. Dazu gibt es die neuen Aktionen `teams_kanal` und `teams_chat`.
- **SW Benachrichtigen und SW Freigabe senden:** Beide lesen `postfach_workflow_id` aus `epa_config_allgemein` und senden über die Kopie. Sie brauchen kein Credential mehr.
- **EPA-06:** Teams wird je Kunde über `verbindung_pruefen` geprüft. Das Teams des Betreibers prüft EPA-06 nur noch, wenn die Alarme per Teams gehen; hier gehen sie per Telegram.
- **Kopie `NezOVz8ylWItOHcU`:** Teams-Nodes mit „Microsoft Teams account 2“. Die Vorlage hat keine Credentials, die werden je Kopie zugewiesen.
- **Live-Test V-2026-0131 („Anfrage Sendung nach Bayern“):**
  - Meldung im Kanal und Freigabe-Link im Chat des Disponenten kamen über die Kopie an, ohne neuen Eintrag im Fehlerlog.
  - Nach der Freigabe ging die Rückfrage um 10:17 UTC raus (`status = gesendet`).
- **Deploy-Hinweis:** Bei einem Node, der unter gleichem Namen den Typ wechselt, darf die alte `workflowId` nicht übernommen werden. Der erste Deploy-Lauf scheiterte daran, der zweite war korrekt.

## Testdurchlauf 17.10. (12 Mails, alle 3 Minuten) und Unzustellbarkeit

**Ablauf**
- Gesendet wurden 12 Testmails an das Microsoft-365-Postfach.
- Alle 12 wurden wie erwartet erkannt: 5 vollständig, 4 mit Lücken, 3 ignoriert (Zahlungsavis, Abwesenheitsnotiz, Injection).
- Kanalmeldungen und Freigabe-Chats liefen über das Teams-Credential in der Postfach-Kopie.
- Bei der Weiterleitung (Kiel) war die Anrede neutral.

**Befund**
- Von 4 freigegebenen Rückfragen kam nur Mainz – Koblenz in Gmail an.
- Die anderen 3 hat der Mailserver abgewiesen mit `550 5.7.708 Service unavailable. Access denied, traffic not accepted from this IP`.
- Ursache ist eine Microsoft-Beschränkung für neue Tenants ohne eigene Domain; die Mails gingen ohne DKIM raus.
- EPA-01 hatte die Unzustellbarkeitsmeldungen als Auto-Antwort ignoriert.

**Neu (Commit e7d874b)**
- `src/unzustellbar.js` und ein eigener Weg „unzustellbar“ in EPA-01: Der Vorgang geht auf „Eskaliert / Manuell“, im Kanal erscheint „📭 Nachricht nicht zugestellt“ mit Empfänger und SMTP-Grund.
- Eingespielt und veröffentlicht.
- Für die 3 Meldungen nachgeholt: Die Einträge in `epa_verarbeitete_mails` wurden gezielt per Message-ID entfernt, dann über EPA-00 `eingang` neu verarbeitet.
- Ergebnis: V-2026-0132, V-2026-0134 und V-2026-0141 stehen auf „Eskaliert / Manuell“.

**Abhilfe für den Tenant (zu verifizieren):** eigene Domain mit SPF, DKIM und DMARC einrichten.

## Übersichtsseite und Tagesübersicht (17.10.2026)
- Neue Data Table `epa_uebersicht_zugaenge` (eKUcr6JEdepIICff): kunde_id, schluessel_hash, erstellt_am, ablauf, gesperrt_am.
- `EPA-12 Übersicht-Seite` (66Xw54V0q9cxDl78), Webhook GET `/webhook/epa-uebersicht?k=…`, veröffentlicht.
- `EPA-13 Tagesübersicht` (6CGAOQFceb6H5SvO), täglich 08:05 an Geschäftstagen, veröffentlicht. Erster manueller Lauf: Zusammenfassung für epa-m365 im Kanal „Anfragen“ (3 Klärung, 7 bereit, 3 wartet auf Kunde).
- Test: falscher Schlüssel → 404 „Link ungültig“; Link aus der Tagesübersicht → Seite mit genau den 13 offenen Vorgängen von epa-m365. Darstellung im Browser (n8n-Sandbox) noch von Tim zu prüfen.
- Unzustellbar-Test V-2026-0141: Freigabe „unzustellbar“, Telegram-Alarm gesendet. Zustelltest 16:27 fehlgeschlagen (Mail nicht in Gmail angekommen), daher noch keine erneute Freigabe.

## Betreiber-Dashboard (18.10.2026)
- `EPA-14 Betrieb-Dashboard` (OICDVae1LB9bPhwl), Webhook GET `/webhook/epa-betrieb?k=…`. **Seit 23.10. offline (nicht veröffentlicht)**, damit keine Ausführungen verbraucht werden; zum Einschalten in n8n „Publish“. Erster Link am 18.10. 08:30 per Telegram verschickt (gültig bis 16.01.2027).
- Test: Betreiber-Link → Dashboard; Kunden-Link auf EPA-14 → 404; Betreiber-Link auf EPA-12 → 404.
- Stand beim ersten Aufruf: ⛔ Handlungsbedarf – Zustelltest epa-m365 heute 07:40 erneut fehlgeschlagen; ein alter Fehler vom 17.10. 11:17 (Freigabe-Chat 404, inzwischen behoben) ohne zugestellten Alarm.
