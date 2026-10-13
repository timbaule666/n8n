# Inbetriebnahme M1 (Fundament)

Gilt für n8n 2.43.4 (Cloud, `https://timbaule.app.n8n.cloud`) und PostgreSQL ≥ 13.

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
   Das Skript legt die 5 Workflows an bzw. aktualisiert sie anhand des Namens. Es setzt die Sub-Workflow-Verknüpfungen und trägt EPA-05 als Error Workflow ein. Bereits zugewiesene Credentials bleiben bei späteren Deploys erhalten.

**Variante B: manueller Import**
1. Jede Datei aus `workflows/` über *Import from File* importieren.
2. In `EPA-05 Error-Handler`, Node „Vorgang sichern“: Workflow „EPA SW Status setzen“ auswählen.
3. In jedem Workflow außer EPA-05: *Settings → Error workflow* = „EPA-05 Error-Handler“.

## 3. Credentials zuweisen (keine Secrets im Repo)
| Credential (Vorschlag) | Typ | Nodes |
|---|---|---|
| `EPA – Postgres` | Postgres (SSL an) | alle Postgres-Nodes (11 Stück) |
| `EPA – Teams (Dienstkonto)` | Microsoft Teams OAuth2 | EPA-05 „Entwickler-Kanal alarmieren“ |

Hinweis Teams: Kanalnachrichten gehen nur mit delegiertem OAuth2 (Benutzerkontext). Die App-only-Variante (Service Principal) unterstützt das Senden in Kanäle nicht (so geprüft im Quellcode des Teams-Nodes in n8n 2.43). Dafür ein Dienstkonto nutzen, das Mitglied der EPA-Kanäle ist.

In EPA-05 im Node „Entwickler-Kanal alarmieren“ die Team- und Kanal-ID eintragen. Beide stehen im Teams-Link zum Kanal (`groupId=…` bzw. `19:…@thread.tacv2`).

## 4. Abnahmetest in der Instanz (5 Minuten)
1. `EPA SW Config laden` manuell mit `{"kunde_id": "beispiel-transport"}` ausführen. Erwartet: `config` mit 10 Feldern. Stehen noch Platzhalter in der Config, wird 424 erwartet.
2. In psql einen Testvorgang anlegen: `SELECT epa_naechste_vorgangs_id();` reicht als Kontrolle. Einen echten Vorgang legt `EPA SW Vorgang verwalten` mit `aktion=anlegen` an.
3. `EPA SW Status setzen` mit dem Vorgang und `neuer_status = "Abgeschlossen"`, `ausloeser = "System"` aufrufen. Erwartet: Fehler 409 UNZULAESSIGER_STATUSWECHSEL, Eintrag in `epa_fehler_log`, Teams-Nachricht im Entwickler-Kanal, Vorgang steht auf „Eskaliert / Manuell“.

## 5. Datenschutz-Einstellungen in n8n
In den Workflow-Settings bzw. global: Ausführungsdaten erfolgreicher Läufe nicht oder nur kurz speichern. Die Daten enthalten später Mail-Inhalte. [zu verifizieren: welche Pruning-Optionen der Cloud-Tarif bietet]
