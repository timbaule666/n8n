# Stand in der Instanz timbaule.app.n8n.cloud

Eingespielt am 2026-10-13 über den n8n-MCP-Connector (persönliches Projekt).

| Workflow | ID | Nodes | Status |
|---|---|---|---|
| EPA SW Audit schreiben | `SPKLbe2MY028CKtn` | 4 | Entwurf, nicht veröffentlicht |
| EPA SW Config laden | `hbeJAwoqdebivRSQ` | 5 | Entwurf, nicht veröffentlicht |
| EPA SW Status setzen | `xwBsSqK1LVgMuQx4` | 9 | Entwurf, nicht veröffentlicht |
| EPA SW Vorgang verwalten | `EixHJ4vRqMIGcyuL` | 11 | Entwurf, nicht veröffentlicht |
| EPA-05 Error-Handler | `nMkGyI82z0mwm9ud` | 12 | Entwurf, nicht veröffentlicht |

**Integritätsprüfung:** Prüfsummen (FNV-1a) aller 25 Code- und SQL-Bausteine in der Instanz stimmen mit `workflows/*.json` überein. Geprüft wurde per vorübergehendem Workflow „EPA-TEST Integritätsprüfung“, der danach archiviert wurde.

**Verknüpfung:** EPA-05 „Vorgang sichern“ ruft `xwBsSqK1LVgMuQx4` auf.

**Offen, bevor veröffentlicht werden kann:**
- Postgres-Credential anlegen und den 14 Postgres-Nodes zuweisen (Instanz hat noch keins).
- EPA-05 „Entwickler-Kanal alarmieren“: Team-ID (GUID) und Kanal-ID eintragen. Das MCP-Werkzeug hat dem Node automatisch das vorhandene Credential „Microsoft Teams account“ zugewiesen.
- Danach EPA-05 veröffentlichen und in den vier Sub-Workflows als Error Workflow eintragen, dann diese veröffentlichen.
- Hinweis: Das Credential „n8n account“ hat eine ungültige Basis-URL („Invalid URL“); „n8n account 2“ funktioniert.
