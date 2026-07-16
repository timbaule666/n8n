# AI Office Assistant – Übergabedokument Teil 1

Dieses Dokument ist verbindlich für Teil 2 und Teil 3. Node-Namen und Schnittstellen dürfen danach nicht mehr ohne zwingenden technischen Grund geändert werden.

## Projektinformationen

```text
Projektname:        AI Office Assistant
Version:             1.0.0
n8n-Node-API-Version: siehe Tabelle "Verwendete Node-Typen" (Kernversion der n8n-Instanz
                      war über die verfügbaren MCP-Werkzeuge nicht direkt abrufbar –
                      offener Punkt, siehe "Offene manuelle Einstellungen")
Erstellungsdatum:    2026-07-16
Main-Workflow-Name:  AI Office – 01 Main Manager
Main-Workflow-ID:    96CDyebHHKwYXl8Q
Main-Workflow-URL:   https://timbaule.app.n8n.cloud/workflow/96CDyebHHKwYXl8Q
```

**Wichtiger Hinweis zu bereits vorhandenen Workflows:** In derselben n8n-Instanz existiert
bereits ein eigenständiges, älteres Projekt ("AI Office Assistant – 00 Manager Orchestrator",
"01 Email Agent", "02 Invoice Agent", "03 Calendar Agent", "90 Logging Service",
"91 Gmail Label Service"), das n8n Data Tables statt PostgreSQL verwendet und eine andere
Namenskonvention nutzt. Auf ausdrücklichen Wunsch wurde dieser Auftrag als **komplett neues,
paralleles System** gemäß der hier vorgegebenen Spezifikation gebaut. Das alte Projekt wurde
nicht verändert, gelöscht oder umbenannt.

## Verwendete Node-Typen und Versionen

| Node-Typ | Version | Verwendung |
|---|---|---|
| `n8n-nodes-base.scheduleTrigger` | 1.3 | 01 – Jede Stunde starten |
| `n8n-nodes-base.gmail` | 2.2 | 02 – Neue Gmail-Nachrichten abrufen |
| `n8n-nodes-base.postgres` | 2.6 | 03, 08, 11, 00 – DB Setup |
| `n8n-nodes-base.if` | 2.3 | 04, 12, 13, 14 |
| `n8n-nodes-base.set` | 3.4 | 06, Übersprungen, 18 |
| `n8n-nodes-base.code` | 2 | 05, 07, 10, 15, 16, 17 |
| `@n8n/n8n-nodes-langchain.agent` | 3.1 | 09 – Manager-Aufgaben erkennen |
| `@n8n/n8n-nodes-langchain.lmChatOpenAi` | 1.3 | Manager Model (Subnode von 09) |
| `@n8n/n8n-nodes-langchain.outputParserStructured` | 1.3 | Manager JSON Parser (Subnode von 09) |
| `n8n-nodes-base.merge` | 3.2 | Agentenergebnisse sammeln (append, 3 Inputs) |
| `n8n-nodes-base.stickyNote` | 1 | 16 Dokumentations-Notizen |

Gesamtzahl Nodes im Workflow: 39 (inkl. Sticky Notes).

## Verwendete Credentials

| Credential | Typ | Status |
|---|---|---|
| OpenAI account | `openAiApi` | ✅ vorhanden, automatisch mit "Manager Model" verknüpft |
| Gmail – AI Office | `gmailOAuth2` | ⚠️ Platzhalter angelegt, **muss manuell verbunden werden** |
| PostgreSQL – AI Office | `postgres` | ⚠️ Platzhalter angelegt, **muss manuell verbunden werden** |

## Datenbank

### Verwendete Tabellen

- `workflow_runs` – **aktiv genutzt** in Teil 1 (Insert bei Node 08, Select bei Node 03, Update bei Node 11)
- `agent_logs`, `invoices`, `calendar_events`, `errors` – Schema vorbereitet (SQL unten), noch **nicht aktiv genutzt** (folgt Teil 2/3)

### Ausgeführte SQL-Befehle

**Keine.** Es existiert kein PostgreSQL-Credential in dieser n8n-Instanz, daher konnte keine
SQL-Anweisung real gegen eine Datenbank ausgeführt werden. Alle DDL- und DML-Statements sind
vollständig in den entsprechenden Postgres-Nodes vorbereitet und parametrisiert.

### Nicht ausgeführte SQL-Befehle (vorbereitet im Node "00 – DB Setup: Tabellen anlegen (manuell, einmalig)")

```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
    id BIGSERIAL PRIMARY KEY,
    processing_id UUID NOT NULL UNIQUE,
    gmail_message_id TEXT NOT NULL,
    gmail_thread_id TEXT,
    sender TEXT,
    recipient TEXT,
    subject TEXT,
    received_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    status TEXT NOT NULL,
    detected_tasks JSONB NOT NULL DEFAULT '{}'::jsonb,
    final_result JSONB,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_gmail_message
ON workflow_runs (gmail_message_id);

CREATE TABLE IF NOT EXISTS agent_logs (
    id BIGSERIAL PRIMARY KEY,
    processing_id UUID NOT NULL,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence NUMERIC(5,4),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    duration_ms INTEGER,
    result JSONB,
    error_type TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_logs_processing
ON agent_logs (processing_id);

CREATE TABLE IF NOT EXISTS invoices (
    id BIGSERIAL PRIMARY KEY,
    processing_id UUID NOT NULL,
    gmail_message_id TEXT NOT NULL,
    supplier TEXT,
    invoice_number TEXT,
    invoice_date DATE,
    service_date DATE,
    due_date DATE,
    net_amount NUMERIC(14,2),
    tax_amount NUMERIC(14,2),
    gross_amount NUMERIC(14,2),
    currency TEXT DEFAULT 'EUR',
    iban TEXT,
    payment_reference TEXT,
    original_filename TEXT,
    google_drive_file_id TEXT,
    google_drive_url TEXT,
    extraction_confidence NUMERIC(5,4),
    status TEXT NOT NULL,
    raw_extracted_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_duplicate
ON invoices (
    COALESCE(supplier, ''),
    COALESCE(invoice_number, ''),
    COALESCE(gross_amount, 0)
);

CREATE TABLE IF NOT EXISTS calendar_events (
    id BIGSERIAL PRIMARY KEY,
    processing_id UUID NOT NULL,
    gmail_message_id TEXT NOT NULL,
    google_event_id TEXT,
    title TEXT,
    start_time TIMESTAMPTZ,
    end_time TIMESTAMPTZ,
    timezone TEXT DEFAULT 'Europe/Berlin',
    location TEXT,
    attendees JSONB,
    status TEXT NOT NULL,
    extraction_confidence NUMERIC(5,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_message
ON calendar_events (gmail_message_id);

CREATE TABLE IF NOT EXISTS errors (
    id BIGSERIAL PRIMARY KEY,
    processing_id UUID,
    workflow_name TEXT,
    agent_name TEXT,
    node_name TEXT,
    error_type TEXT,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    status TEXT NOT NULL,
    error_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
```

**Aktivierungsschritte** (sobald ein PostgreSQL-Credential verbunden ist):
1. Credential "PostgreSQL – AI Office" mit echten Zugangsdaten füllen.
2. Node "00 – DB Setup: Tabellen anlegen (manuell, einmalig)" manuell einmal ausführen ("Execute step").
3. Danach ist der Workflow für den produktiven Betrieb vorbereitet (Aktivierung erfolgt nicht automatisch, siehe unten).

### Vorhandene Indizes (nach Ausführung des Setup-Nodes)

- `idx_workflow_runs_gmail_message` (UNIQUE, `workflow_runs.gmail_message_id`)
- `idx_agent_logs_processing` (`agent_logs.processing_id`)
- `idx_invoice_duplicate` (UNIQUE, `invoices` – Supplier/Rechnungsnummer/Betrag)
- `idx_calendar_events_message` (`calendar_events.gmail_message_id`)

## Schnittstellen

### Manager-Ausgabeformat (Node 09, per Structured Output Parser)

```json
{
  "hasInvoice": false,
  "hasCalendarTask": false,
  "hasGeneralEmailTask": false,
  "invoiceConfidence": 0,
  "calendarConfidence": 0,
  "emailConfidence": 0,
  "generalEmailCategory": null,
  "reason": "",
  "detectedAttachmentTypes": [],
  "requiresManualReview": false
}
```

Erlaubte Werte für `generalEmailCategory`: `CUSTOMER`, `OFFER`, `SUPPORT`, `APPLICATION`,
`NEWSLETTER`, `ADVERTISEMENT`, `OTHER`, `REVIEW`, oder `null`.

Node 10 validiert diese Ausgabe und reichert sie um `isValidOutput` an, bevor sie als
`managerDecision` weitergereicht wird.

### Agenten-Eingabeformat (verbindlich für Teil 2)

```json
{
  "processingId": "",
  "configuration": {},
  "email": {},
  "attachments": [],
  "managerDecision": {}
}
```

### Agenten-Ausgabeformat (verbindlich für Teil 2)

```json
{
  "processingId": "",
  "agent": "",
  "status": "SUCCESS",
  "success": true,
  "confidence": 0,
  "result": {},
  "error": null,
  "startedAt": "",
  "finishedAt": "",
  "durationMs": 0
}
```

### Erlaubte Statuswerte (Agenten)

```text
SUCCESS
FAILED
MANUAL_REVIEW
SKIPPED
DUPLICATE
PENDING_IMPLEMENTATION
```

### Erlaubte Statuswerte (`workflow_runs.status`)

```text
PROCESSING   (Teil 1, aktiv)
ROUTED       (Teil 1, aktiv)
AGENTS_RUNNING     (reserviert für Teil 2)
AGENTS_FINISHED    (reserviert für Teil 2)
SUCCESS            (reserviert für Teil 3)
PARTIAL_SUCCESS    (reserviert für Teil 3)
MANUAL_REVIEW      (reserviert für Teil 3)
FAILED             (reserviert für Teil 3)
```

## Zentrale Konfiguration (Node 06 "06 – Konfiguration laden")

```json
{
  "projectName": "AI Office Assistant",
  "projectVersion": "1.0.0",
  "timezone": "Europe/Berlin",
  "scheduleIntervalHours": 1,
  "minimumManagerConfidence": 0.75,
  "minimumInvoiceConfidence": 0.8,
  "minimumCalendarConfidence": 0.85,
  "defaultMeetingDurationMinutes": 60,
  "maxRetryCount": 2,
  "processedLabel": "AI Office/Verarbeitet",
  "partialLabel": "AI Office/Teilweise verarbeitet",
  "reviewLabel": "AI Office/Prüfen",
  "invoiceLabel": "AI Office/Rechnung",
  "calendarLabel": "AI Office/Termin",
  "customerLabel": "AI Office/Kunde",
  "driveRootFolder": "AI Office"
}
```

Node 06 trägt aktuell den für Teil 1 relevanten Teilsatz (`timezone` bis `maxRetryCount`) in
jedes Item ein. Die vollständige Liste inkl. Labels/Ordner ist hier dokumentiert und wird ab
Teil 2 von den Label-/Drive-/Kalender-Agenten benötigt.

## Anschlusspunkte für Teil 2

| Anschluss | Exakter Node-Name | Ersetzt durch |
|---|---|---|
| Invoice Agent | `15 – Invoice Agent Übergabe` | Execute-Workflow-Node → **AI Office – 03 Invoice Agent** |
| Calendar Agent | `16 – Calendar Agent Übergabe` | Execute-Workflow-Node → **AI Office – 04 Calendar Agent** |
| Email Agent | `17 – Email Agent Übergabe` | Execute-Workflow-Node → **AI Office – 02 Email Agent** |

Jeder dieser drei Code-Nodes erhält seine Eingabedaten bereits im vollständigen
Agenten-Eingabeformat (verfügbar über den Node `10 – Manager-Ausgabe validieren`, referenziert
per `$('10 – Manager-Ausgabe validieren').item.json`). Die Subworkflow-IDs existieren noch
nicht und wurden nicht erfunden – sie müssen in Teil 2 real angelegt und hier ergänzt werden.

Reservierte Subworkflow-Namen (noch nicht angelegt):

```text
AI Office – 02 Email Agent
AI Office – 03 Invoice Agent
AI Office – 04 Calendar Agent
```

## Anschlusspunkt für Teil 3

| Anschluss | Exakter Node-Name |
|---|---|
| Synchronisation/Abschluss | Merge-Node `Agentenergebnisse sammeln` (append, 3 Inputs) gefolgt von `18 – Teil 1 Abschluss (FOUNDATION_READY)` |

Reservierte Subworkflow-Namen (noch nicht angelegt):

```text
AI Office – 05 Error Handler
AI Office – 06 Global Error Workflow
```

Der Node `18 – Teil 1 Abschluss (FOUNDATION_READY)` setzt aktuell nur `workflowStatus =
"FOUNDATION_READY"` als Platzhalter. Teil 3 ersetzt/erweitert diesen Bereich um
Gesamtstatus-Berechnung, Abschlusslabels und Retry-/Error-Handler-Anbindung.

## Offene Aufgaben für Teil 2

```text
Email Agent implementieren
Invoice Agent implementieren
Calendar Agent implementieren
PDF-Extraktion ergänzen
OCR-Fallback ergänzen
Google Drive ergänzen
Google Calendar ergänzen
Fachagenten-Logging ergänzen (agent_logs)
```

## Offene Aufgaben für Teil 3

```text
Agenten synchronisieren
Error Handler implementieren
Global Error Workflow implementieren
Gesamtstatus berechnen
Abschlusslabels setzen
End-to-End-Tests durchführen
Workflows exportieren
```

## Offene manuelle Einstellungen (Teil 1)

1. **Gmail-Credential** `Gmail – AI Office` (Typ `gmailOAuth2`) in n8n anlegen und mit Node
   `02 – Neue Gmail-Nachrichten abrufen` verbinden.
2. **PostgreSQL-Credential** `PostgreSQL – AI Office` (Typ `postgres`) in n8n anlegen und mit
   allen Postgres-Nodes verbinden (03, 08, 11, 00 – DB Setup).
3. Node `00 – DB Setup: Tabellen anlegen (manuell, einmalig)` nach Schritt 2 einmal manuell
   ausführen, um die 5 Tabellen real anzulegen.
4. n8n-Kernversion der Instanz nicht dokumentiert (siehe Projektinformationen) – bei Bedarf
   manuell in n8n unter "Über n8n" nachsehen.
5. **Live-Test nicht durchgeführt:** Der n8n-Cloud-Testzeitraum dieser Instanz ist zum
   Zeitpunkt der Erstellung abgelaufen (`test_workflow`-Ausführung schlug mit
   "Your trial has ended" fehl). Der Workflow wurde stattdessen vollständig strukturell über
   `validate_workflow` geprüft (0 Fehler, 39 Nodes, einzige Warnung ist der beabsichtigt
   unverbundene DB-Setup-Node). Ein Live-Test mit den 9 in der Aufgabenstellung genannten
   Szenarien sollte nachgeholt werden, sobald der Account wieder aktiv ist bzw. Credentials
   verbunden sind.

## Sicherheitsprinzipien (bereits umgesetzt)

- Alle SQL-Abfragen sind parametrisiert (`$1`, `$2`, … über `queryReplacement`), keine
  String-Konkatenation von E-Mail-Inhalten in SQL.
- Der Manager-System-Prompt weist die KI ausdrücklich an, Anweisungen aus E-Mail-Inhalten zu
  ignorieren (Prompt-Injection-Schutz).
- Keine Anhänge werden ausgeführt, keine E-Mails gelöscht/beantwortet, keine Termine erstellt,
  keine Rechnungen bezahlt.
- Keine Secrets in Sticky Notes oder Node-Parametern – Credentials ausschließlich über
  `newCredential(...)`-Platzhalter referenziert.
