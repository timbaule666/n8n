# Stand in der Instanz timbaule.app.n8n.cloud

Stand 2026-10-13. Speicher: **n8n Data Tables** (persönliches Projekt).

## Workflows
| Workflow | ID | Nodes | Status |
|---|---|---|---|
| EPA SW Audit schreiben | `SPKLbe2MY028CKtn` | 5 | veröffentlicht |
| EPA SW Config laden | `hbeJAwoqdebivRSQ` | 7 | veröffentlicht |
| EPA SW Status setzen | `xwBsSqK1LVgMuQx4` | 12 | veröffentlicht |
| EPA SW Vorgang verwalten | `EixHJ4vRqMIGcyuL` | 32 | veröffentlicht |
| EPA-05 Error-Handler | `nMkGyI82z0mwm9ud` | 18 | Entwurf, Teams-IDs und Credential fehlen noch |
| EPA SW LLM aufrufen | `VNTqDuobRAqqj4Y7` | 13 | Entwurf, OpenAI-Credential fehlt |
| EPA SW Benachrichtigen | `KLzgK5VQCop0z9QA` | 9 | Entwurf, Teams-Credential fehlt |
| EPA-01 Eingang verarbeiten | `W1j7GzjIxdjtQkVS` | 41 | Entwurf (veröffentlichbar nach EPA-02) |
| EPA-00 Postfach (Vorlage) | `fi1VnvQ26qBQ8aMQ` | 36 | Vorlage, je Postfach duplizieren (enthält ab M3 die Postfach-Aktionen für Entwurf/Versand) |
| EPA SW Freigabe senden | `41ZGdeyiNVWwrJfW` | 11 | Entwurf, Teams-Credential fehlt (3 Graph-Nodes) |
| EPA-02 Rückfrage anfordern | `aSdEMSgPSxhnQKMi` | 25 | Entwurf (veröffentlichbar nach SW LLM, SW Benachrichtigen, SW Freigabe senden) |
| EPA-07 Freigabe-Endpunkt | `xj4e8E82vccdoiXl` | 41 | **veröffentlicht**, Link: `https://timbaule.app.n8n.cloud/webhook/epa-freigabe` (Probe: ungültiger Link → 404-Seite) |

M3: eingespielt aus `workflows/` vom Commit `1bccce8` (M2: `50f1cce`, M1: `b195eb6`), direkt von GitHub geladen. Danach wurde jeder Node mit der Quelle abgeglichen (Typ, Version, Parameter): 0 Abweichungen.

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
| epa_freigaben | `HDUhqBQV5ZxG6lzl` | leer (M3) |
| epa_freigabe_tokens | `y7kKOYkDuAo7r5lr` | leer (nur SHA-256-Hashes) |

`epa_config_allgemein` hat neu die Spalten `postfach_workflow_id` (ID der EPA-00-Kopie des Kunden) und `freigabe_basis_url` (optional, sonst automatisch).

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
   2. Veröffentlichen in dieser Reihenfolge: SW LLM aufrufen, SW Benachrichtigen, SW Freigabe senden → EPA-02 → EPA-01.
   3. EPA-00 duplizieren, Postfach im Node „Postfach festlegen“ eintragen, Outlook-Credential in Trigger und allen Graph-Nodes zuweisen, Archivordner anlegen, veröffentlichen.
   4. Die ID dieser Kopie (aus der URL) in `epa_config_allgemein.postfach_workflow_id` eintragen.
   Erst danach läuft echte Post. Gesendet wird nie ohne Klick auf „Freigeben“.
1. **Config ausfüllen** (Data Table `epa_config_allgemein`, Zeile `beispiel-transport`): `postfach`, `freigeber` (JSON-Liste), in `benachrichtigung` die Team- und Kanal-ID, in `signatur` die Telefonnummer. Solange Platzhalter drinstehen, lehnt „EPA SW Config laden“ die Config bewusst ab.
2. **EPA-05**: Im Node „Entwickler-Kanal alarmieren“ Team (GUID) und Kanal eintragen und das Teams-Credential prüfen. Danach EPA-05 veröffentlichen und in den vier Sub-Workflows als Error Workflow eintragen. Das kann ich übernehmen, sobald die IDs da sind.
3. Das Credential „n8n account“ hat eine ungültige Basis-URL („Invalid URL“), „n8n account 2“ funktioniert.
