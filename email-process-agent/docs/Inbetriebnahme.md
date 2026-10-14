# Inbetriebnahme

Stand 2026-10-14 (M7). Gilt für n8n 2.43.4 (Cloud oder selbst gehostet), Speicher **n8n Data Tables**. Keine Secrets im Repository: alle Zugangsdaten nur als n8n-Credentials.

Überblick: 1. Voraussetzungen → 2. Data Tables → 3. Workflows einspielen → 4. Credentials und IDs → 5. Kunde konfigurieren → 6. Veröffentlichen (Reihenfolge) → 7. Abnahmetest → 8. Datenschutz-Einstellungen. Neue Kunden: `Onboarding-Neukunde.md`. Laufender Betrieb: `Betriebshandbuch.md`.

## 1. Voraussetzungen
| Was | Wofür |
|---|---|
| n8n 2.43.x (Cloud oder self-hosted), Projekt mit Data Tables | Laufzeit und Speicher |
| n8n-API-Key (*Settings → n8n API*) | Setup- und Deploy-Skripte |
| Node.js ≥ 20 lokal | `npm run check`, Skripte |
| OpenAI-API-Key (Projekt mit AVV, EU-Option prüfen) | KI |
| Microsoft-365-Dienstkonto für das Postfach (Outlook OAuth2) | Mails lesen, Entwürfe, Versand |
| Microsoft-365-Dienstkonto für Teams (Teams OAuth2, delegiert) | Meldungen, Freigabe-Chats, Watchdog |
| Teams-Kanäle: Betriebskanal (Alarme) und je Kunde ein Meldekanal | Benachrichtigungen |

Selbst gehostet: Code-Nodes nutzen `require('crypto')` → `NODE_FUNCTION_ALLOW_BUILTIN=crypto` setzen (in n8n Cloud erlaubt).

## 2. Data Tables anlegen
```bash
cd email-process-agent && npm install && npm run check      # Build, Strukturprüfung, Unit-Tests
N8N_URL=https://<instanz> N8N_API_KEY=<key> node tools/datatables-setup.js --prompts
```
Legt alle Tabellen aus `config/datatables/schema.json` an bzw. ergänzt fehlende Spalten (nichts wird gelöscht), spielt die Prompts (`prompts/v1`) ein und legt die Lock-Zeile von EPA-04 an. Mit `--beispiel --postfach=… --freigeber=…` kommt zusätzlich die Beispiel-Config `beispiel-transport` dazu.

## 3. Workflows einspielen
```bash
N8N_URL=https://<instanz> N8N_API_KEY=<key> node tools/deploy.js --dry-run
N8N_URL=https://<instanz> N8N_API_KEY=<key> node tools/deploy.js
```
Das Skript legt alle 17 Workflows an bzw. aktualisiert sie anhand des Namens, verknüpft die Sub-Workflows, setzt EPA-05 als Error Workflow und veröffentlicht, was ohne fehlende Credentials veröffentlicht werden kann. Bei Updates bleiben zugewiesene Credentials und eingetragene Teams-IDs erhalten. Ohne Skript: jede Datei aus `workflows/` importieren und die Verknüpfungen von Hand setzen (nicht empfohlen).

## 4. Credentials und IDs zuweisen
| Credential | Typ | Workflows/Nodes |
|---|---|---|
| OpenAI | OpenAI API | SW LLM aufrufen („OpenAI aufrufen“), EPA-06 („KI prüfen“) |
| Teams-Dienstkonto | Microsoft Teams OAuth2 | SW Benachrichtigen, SW Freigabe senden (3 Graph-Nodes), EPA-05 und EPA-06 („Teams prüfen“, Kanal-Nodes) |
| Outlook je Postfach | Microsoft Outlook OAuth2 | nur in der EPA-00-Kopie des Kunden (Trigger und alle Graph-Nodes) |

**Markierung in n8n:** Workflows, denen noch Credentials fehlen, tragen ein „ *“ am Namensende (z. B. „EPA-05 Error-Handler *“). Nach dem Zuweisen das Sternchen im Namen entfernen. `tools/deploy.js` ignoriert das Sternchen beim Abgleich und lässt es bei Updates stehen.

Teams-IDs eintragen: in EPA-05 „Entwickler-Kanal alarmieren“ und EPA-06 „Betriebskanal benachrichtigen“ das Team (GUID, `groupId=…` im Link) und den Kanal (`19:…@thread.tacv2`). Kanalnachrichten gehen nur mit delegiertem OAuth2; das Dienstkonto muss Mitglied der Kanäle sein. Freigeber müssen im selben Tenant sein.

## 5. Kunde konfigurieren
Nach `Onboarding-Neukunde.md`: Config-Zeile und Pflichtfelder (Vorlage `config/datatables/vorlage-leer.json` bzw. `config/vorlagen/*.csv`), EPA-00 duplizieren, Postfach eintragen, Outlook-Credential zuweisen, die ID der Kopie in `postfach_workflow_id`. Solange Platzhalter `<…>` in der Config stehen, lehnt „EPA SW Config laden“ sie mit 424 ab.

## 6. Veröffentlichen (Reihenfolge)
n8n veröffentlicht nur Workflows ohne Konfigurationsprobleme, und ein Aufrufer nur, wenn seine Sub-Workflows veröffentlicht sind:
1. EPA-05 Error-Handler (danach `deploy.js` erneut ausführen, damit EPA-05 überall als Error Workflow eingetragen wird)
2. SW Config laden, SW Vorgang verwalten, SW Status setzen, SW Audit schreiben (sind es meist schon)
3. SW LLM aufrufen, SW Benachrichtigen, SW Freigabe senden
4. EPA-02 → EPA-03 → EPA-01 → EPA-07
5. EPA SW Nachfassen → EPA-04
6. EPA-06 Watchdog
7. EPA-00-Kopie(n) des Kunden
8. **EPA-08 Löschjob erst nach einem Probelauf** (manuell mit `probelauf = true`, Ergebnis prüfen)

Gesendet wird nie ohne Klick auf „Freigeben“; das Veröffentlichen allein verschickt keine Mails.

## 7. Abnahmetest in der Instanz
1. `EPA SW Config laden` mit `{"kunde_id": "<kürzel>"}` ausführen → `config` ohne Fehler.
2. Testmail mit Lücke an das Testpostfach → Teams-Chat mit Freigabe-Link beim Freigeber, Entwurf im Postfach, Vorgang „Freigabe ausstehend“.
3. Link öffnen, freigeben → Mail im Thread gesendet, Vorgang „Warten auf Kunde“.
4. Antwort mit der fehlenden Angabe → „Bereit zur Bearbeitung“ und Meldung im Kanal.
5. EPA-06 manuell ausführen → „Alles in Ordnung“ im Betriebskanal.
6. EPA-08 mit `probelauf = true` → Übersicht ohne Löschung.

Automatisierte Tests lokal (nur gegen eine Testinstanz, nie gegen Produktivdaten):
```bash
N8N_URL=http://127.0.0.1:5678 N8N_API_KEY=<key> EPA_E2E_CREDS=creds.json node tools/e2e-eingang.js   # M2–M7, Mock-KI und Mock-Graph
```

## 8. Datenschutz-Einstellungen
- Ausführungsdaten: EPA-02, EPA-07, SW Freigabe senden und SW Nachfassen speichern erfolgreiche Ausführungen nicht (Klartext-Links). Für alle anderen in den n8n-Einstellungen die Aufbewahrung begrenzen, z. B. 7–14 Tage [zu verifizieren: Optionen des Cloud-Tarifs].
- 2FA für alle n8n-Konten, Zugriff nur für Betreuer.
- Offene rechtliche Punkte: `Datenschutz-und-KI-Checkliste.md`.

## 9. Updates
`git pull`, `npm run check`, `node tools/datatables-setup.js --prompts` (ergänzt neue Spalten), `node tools/deploy.js`. Änderungen an der EPA-00-Vorlage in die Kunden-Kopien übernehmen (neu duplizieren oder neue Nodes kopieren, Credentials zuweisen). Prompt-Änderungen immer als neue Version (`prompts/v2`), die Config zeigt über `prompt_versionen` darauf.

## Anhang A: Postgres-Variante (Stand M1)
Die Variante `workflows-postgres/` (Deploy mit `--postgres`) deckt nur das Fundament aus M1 ab und müsste für M2–M7 nachgezogen werden. Für Produktivbetrieb mit Data Tables nicht nötig.

### A.1 Datenbank
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

### A.2 End-to-End-Test der Postgres-Variante (nur gegen eine Test-Datenbank)
```bash
N8N_URL=… N8N_API_KEY=… EPA_E2E_PG='postgres://user:pass@host:port/epa_test' node tools/e2e-test.js
```
Das Skript legt vorübergehend Test-Workflows „EPA-TEST …“ mit Webhook an, prüft 12 Szenarien inklusive Error-Handler und löscht die Test-Workflows danach wieder. Die EPA-Workflows müssen auf die **Test-Datenbank** zeigen. Nie gegen Produktivdaten ausführen.

