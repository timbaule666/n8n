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
| epa_prompts | `RLIt1PFeEq9CJsST` | klassifizierung/v1, extraktion/v1, entwurf/v1 (Prüfsummen wie im Repo) |
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
