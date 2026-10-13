# Inbetriebnahme M1 (Fundament)

Gilt für n8n 2.43.4 (Cloud, `https://timbaule.app.n8n.cloud`).

**Standard-Speicher: n8n Data Tables** (Ordner `workflows/`). Keine externe Datenbank und keine Datenbank-Credentials nötig:
1. Tabellen anlegen: `N8N_URL=… N8N_API_KEY=… node tools/datatables-setup.js --beispiel --postfach=<postfach> --freigeber=<adresse>` (legt die 5 Tabellen aus `config/datatables/schema.json` an und spielt die Beispiel-Config ein). Alternativ in der n8n-Oberfläche nach `config/datatables/schema.json` anlegen.
2. Workflows einspielen: `node tools/deploy.js` (siehe Abschnitt 2). Die Data-Table-Nodes finden ihre Tabellen über den Namen (`epa_…`) im selben Projekt.
3. Abschnitt 3 gilt dann nur für das Teams-Credential.

Grenzen der Data-Table-Variante:
- keine Unique-Constraints;
- Status und Audit werden in zwei Schritten geschrieben;
- Audit-Log ist technisch änderbar;
- Speicherlimit, standardmäßig 200 MB je Instanz, in der Cloud [zu verifizieren].

Gleichzeitige Änderungen werden über bedingte Updates (Compare-and-Set) abgefangen, das ist getestet.

Die folgenden Abschnitte 1–3 beschreiben die **Postgres-Variante** (`workflows-postgres/`, Deploy mit `--postgres`).

## 1. Datenbank
1. Eine Postgres-Datenbank bereitstellen, Region EU (z. B. Azure Database for PostgreSQL Flexible Server, Germany West Central). n8n Cloud muss sie über das Internet erreichen können; Zugriff per Firewall auf die n8n-Cloud-IP-Adressen beschränken [zu verifizieren: aktuelle IP-Liste in der n8n-Doku] und TLS erzwingen.
2. Eine eigene Rolle für n8n anlegen (kein Superuser):
   ```sql
   CREATE ROLE epa_n8n LOGIN PASSWORD '<im Passwort-Tresor>';
   GRANT CONNECT ON DATABASE <db> TO epa_n8n;
   GRANT USAGE ON SCHEMA public TO epa_n8n;
   GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO epa_n8n;
   GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO epa_n8n;
   GRANT EXECUTE ON FUNCTION epa_naechste_vorgangs_id() TO epa_n8n;
   ```
   Ohne DELETE-Recht kann n8n keine Daten löschen. Der Löschjob (M6) bekommt eine eigene Rolle.
3. Als Admin einspielen, in dieser Reihenfolge:
   - `config/sql/001_schema.sql` (idempotent, kann erneut ausgeführt werden)
   - `config/sql/002_beispiel_config_transport.sql`, danach die Platzhalter `<…>` per UPDATE ersetzen (Postfach, Freigeber, Team- und Kanal-ID, Telefon in der Signatur). Solange Platzhalter drinstehen, lehnt `EPA SW Config laden` die Config mit 424 ab. Das ist gewollt.

## 2. Workflows einspielen
**Variante A, empfohlen: Deploy-Skript** (verknüpft automatisch)
1. In n8n unter *Settings → n8n API* einen API-Key erzeugen.
2. Lokal im Ordner `email-process-agent`:
   ```bash
   npm install
   npm run check                      # Build, Strukturprüfung, Unit-Tests
   N8N_URL=https://timbaule.app.n8n.cloud N8N_API_KEY=<key> node tools/deploy.js --dry-run
   N8N_URL=https://timbaule.app.n8n.cloud N8N_API_KEY=<key> node tools/deploy.js
   ```
   Das Skript legt die 5 Workflows an bzw. aktualisiert sie anhand des Namens, setzt die Sub-Workflow-Verknüpfungen und veröffentlicht die Workflows.
   - **Erster Lauf:** Die Workflows werden angelegt, aber noch **nicht veröffentlicht**, weil Credentials fehlen. n8n 2.x veröffentlicht nur Workflows ohne Konfigurationsprobleme und akzeptiert als Error Workflow nur einen veröffentlichten Workflow. Das Skript listet auf, was fehlt.
   - Dann Credentials zuweisen (Abschnitt 3) und das Skript **erneut ausführen**. Jetzt wird EPA-05 veröffentlicht und überall als Error Workflow eingetragen.
   - Bei späteren Updates bleiben zugewiesene Credentials und eingetragene Teams-IDs erhalten. Neue Postgres-Nodes erhalten automatisch das bereits genutzte Postgres-Credential, sofern in den EPA-Workflows genau eines verwendet wird.

**Variante B: manueller Import**
1. Jede Datei aus `workflows/` über *Import from File* importieren.
2. In `EPA-05 Error-Handler`, Node „Vorgang sichern“: Workflow „EPA SW Status setzen“ auswählen.
3. Credentials zuweisen (Abschnitt 3) und alle Workflows veröffentlichen (EPA-05 zuerst).
4. In jedem Workflow außer EPA-05: *Settings → Error workflow* = „EPA-05 Error-Handler“.

## 3. Credentials zuweisen (keine Secrets im Repo)
| Credential (Vorschlag) | Typ | Nodes |
|---|---|---|
| `EPA – Postgres` | Postgres (SSL an) | alle Postgres-Nodes (14 Stück) |
| `EPA – Teams (Dienstkonto)` | Microsoft Teams OAuth2 | EPA-05 „Entwickler-Kanal alarmieren“ |

Hinweis Teams: Kanalnachrichten gehen nur mit delegiertem OAuth2 (Benutzerkontext). Die App-only-Variante (Service Principal) unterstützt das Senden in Kanäle nicht (so geprüft im Quellcode des Teams-Nodes in n8n 2.43). Dafür ein Dienstkonto nutzen, das Mitglied der EPA-Kanäle ist.

In EPA-05 im Node „Entwickler-Kanal alarmieren“ das Team und den Kanal auswählen oder die IDs eintragen. Die Team-ID ist eine **GUID** (`groupId=…` im Teams-Link), die Kanal-ID hat die Form `19:…@thread.tacv2`. n8n lehnt andere Formate beim Veröffentlichen ab.

## 4. Abnahmetest in der Instanz (5 Minuten)
1. `EPA SW Config laden` manuell mit `{"kunde_id": "beispiel-transport"}` ausführen. Erwartet: `config` mit 10 Feldern. Stehen noch Platzhalter in der Config, wird 424 erwartet.
2. In psql einen Testvorgang anlegen: `SELECT epa_naechste_vorgangs_id();` reicht als Kontrolle. Einen echten Vorgang legt `EPA SW Vorgang verwalten` mit `aktion=anlegen` an.
3. `EPA SW Status setzen` mit dem Vorgang und `neuer_status = "Abgeschlossen"`, `ausloeser = "System"` aufrufen. Erwartet: Fehler 409 UNZULAESSIGER_STATUSWECHSEL, Eintrag in `epa_fehler_log`, Teams-Nachricht im Entwickler-Kanal, Vorgang steht auf „Eskaliert / Manuell“.

## 5. Automatischer End-to-End-Test (nur gegen eine Test-Datenbank)
```bash
N8N_URL=… N8N_API_KEY=… EPA_E2E_PG='postgres://user:pass@host:port/epa_test' node tools/e2e-test.js
```
Das Skript legt vorübergehend Test-Workflows „EPA-TEST …“ mit Webhook an, prüft 12 Szenarien inklusive Error-Handler und löscht die Test-Workflows danach wieder. Die EPA-Workflows müssen auf die **Test-Datenbank** zeigen. Nie gegen Produktivdaten ausführen.

## 6. Datenschutz-Einstellungen in n8n
In den Workflow-Settings bzw. global: Ausführungsdaten erfolgreicher Läufe nicht oder nur kurz speichern. Die Daten enthalten später Mail-Inhalte. [zu verifizieren: welche Pruning-Optionen der Cloud-Tarif bietet]

## 7. Ab M3: Rückfrage und Freigabe
- **Postfach-Workflow verknüpfen:** Die ID der EPA-00-Kopie eines Kunden (steht in der Workflow-URL) gehört in `epa_config_allgemein.postfach_workflow_id`. EPA-02/EPA-07 legen darüber Entwürfe an und senden sie, mit dem Outlook-Credential genau dieses Postfachs.
- **Freigeber:** `freigeber` (JSON-Liste) müssen Microsoft-365-Konten im selben Tenant wie das Teams-Dienstkonto sein; jeder bekommt einen persönlichen Link im 1:1-Chat.
- **Freigabe-Link:** `https://<instanz>/webhook/epa-freigabe`. EPA-07 muss veröffentlicht sein. Die Basis-URL wird automatisch ermittelt; abweichend (z. B. eigene Domain) über `freigabe_basis_url`.
- **Selbst gehostetes n8n:** Code-Nodes nutzen `require('crypto')` für die Token. In n8n Cloud ist das erlaubt; bei eigener Installation `NODE_FUNCTION_ALLOW_BUILTIN=crypto` setzen.
- **Ausführungsdaten:** Der Klartext-Link steht nur in den Ausführungsdaten von EPA-02. Aufbewahrung erfolgreicher Ausführungen begrenzen (Abschnitt 6).
