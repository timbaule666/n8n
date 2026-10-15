-- Config-Driven Email Process Agent: Postgres-Schema (M1)
-- Idempotent ausführbar. Getestet gegen PostgreSQL 16 (benötigt >= 13 für gen_random_uuid()).
-- Konvention: Tabellen mit Präfix epa_, Mandantenfeld kunde_id in allen Fachtabellen.

BEGIN;

-- ---------------------------------------------------------------------------
-- Konfiguration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epa_config_allgemein (
    kunde_id                                TEXT PRIMARY KEY CHECK (kunde_id ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
    aktiv                                   BOOLEAN NOT NULL DEFAULT TRUE,
    postfach                                TEXT NOT NULL,
    anrede_stil                             TEXT NOT NULL CHECK (anrede_stil IN ('Sie', 'Du')),
    sprache                                 TEXT NOT NULL DEFAULT 'de',
    signatur                                TEXT NOT NULL,
    ki_hinweistext                          TEXT NOT NULL,
    frist_stunden                           NUMERIC NOT NULL,
    frist_nur_geschaeftszeit                BOOLEAN NOT NULL DEFAULT TRUE,
    max_runden                              INTEGER NOT NULL,
    erinnerung_intervall_stunden            NUMERIC NOT NULL,
    anzahl_erinnerungen                     INTEGER NOT NULL,
    zeitzone                                TEXT NOT NULL DEFAULT 'Europe/Berlin',
    geschaeftszeiten                        JSONB NOT NULL,
    feiertage_region                        TEXT,
    zusaetzliche_feiertage                  JSONB NOT NULL DEFAULT '[]',
    benachrichtigung                        JSONB NOT NULL,
    freigeber                               JSONB NOT NULL,
    vertreter                               JSONB NOT NULL DEFAULT '[]',
    zustaendigkeit                          JSONB NOT NULL DEFAULT '{}',
    absender_allowlist                      JSONB NOT NULL DEFAULT '[]',
    absender_blocklist                      JSONB NOT NULL DEFAULT '[]',
    konfidenz_schwelle                      NUMERIC NOT NULL DEFAULT 0.75,
    zuordnung_schwellen                     JSONB NOT NULL DEFAULT '{"eindeutig": 80, "abstand": 50, "neu": 40}',
    llm_profil                              JSONB NOT NULL,
    prompt_versionen                        JSONB NOT NULL DEFAULT '{}',
    archivordner                            TEXT NOT NULL DEFAULT '', -- leer = nie verschieben
    aufbewahrung_tage                       INTEGER NOT NULL DEFAULT 365,
    anhang_limits                           JSONB NOT NULL DEFAULT '{}',
    leerantwort_fristverlaengerung_stunden  NUMERIC NOT NULL DEFAULT 0,
    freigabe_erinnerung_stunden             NUMERIC NOT NULL DEFAULT 4,
    freigabe_ablauf_stunden                 NUMERIC NOT NULL DEFAULT 48,
    erstellt_am                             TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_am                            TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- optionale Übersetzungen für Rückfragen in der Sprache der Kundenmail (siehe configValidator)
    uebersetzungen                          JSONB NOT NULL DEFAULT '{}',
    -- optionale Outlook-Kategorien je Status (siehe src/kategorien.js)
    outlook_kategorien                      JSONB NOT NULL DEFAULT '{}',
    config_sheet                            TEXT NOT NULL DEFAULT ''  -- optional: Google-Sheet-ID der Kunden-Regeln
);
CREATE UNIQUE INDEX IF NOT EXISTS epa_config_allgemein_postfach_uq ON epa_config_allgemein (lower(postfach));

CREATE TABLE IF NOT EXISTS epa_config_pflichtfelder (
    id                       BIGSERIAL PRIMARY KEY,
    kunde_id                 TEXT NOT NULL REFERENCES epa_config_allgemein (kunde_id) ON DELETE CASCADE,
    vorgangstyp              TEXT NOT NULL,
    feldname                 TEXT NOT NULL CHECK (feldname ~ '^[A-Za-z][A-Za-z0-9_]{0,62}$'),
    anzeigename              TEXT NOT NULL,
    typ                      TEXT NOT NULL CHECK (typ IN ('text', 'plz', 'datum', 'zahl', 'email', 'telefon', 'enum')),
    pflicht                  BOOLEAN NOT NULL,
    validierungsregel        JSONB NOT NULL DEFAULT '{}',
    resolution_textbaustein  TEXT NOT NULL,
    extraktions_hinweis      TEXT NOT NULL DEFAULT '',
    platzhalter_muster       JSONB NOT NULL DEFAULT '[]',
    reihenfolge              INTEGER NOT NULL DEFAULT 0,
    aktiv                    BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (kunde_id, vorgangstyp, feldname)
);

-- Versionierte Prompts (Masterprompt 6). Quelle sind die Dateien unter prompts/.
CREATE TABLE IF NOT EXISTS epa_prompts (
    name         TEXT NOT NULL,
    version      TEXT NOT NULL,
    inhalt       TEXT NOT NULL,
    erstellt_am  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (name, version)
);

-- ---------------------------------------------------------------------------
-- Vorgänge
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epa_vorgang_zaehler (
    jahr         INTEGER PRIMARY KEY,
    letzter_wert INTEGER NOT NULL
);

-- Kollisionsfreie, fortlaufende ID pro Jahr: V-2026-0001. Atomar durch UPSERT.
CREATE OR REPLACE FUNCTION epa_naechste_vorgangs_id() RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    j INTEGER := EXTRACT(YEAR FROM now() AT TIME ZONE 'Europe/Berlin')::INTEGER;
    n INTEGER;
BEGIN
    INSERT INTO epa_vorgang_zaehler (jahr, letzter_wert) VALUES (j, 1)
    ON CONFLICT (jahr) DO UPDATE SET letzter_wert = epa_vorgang_zaehler.letzter_wert + 1
    RETURNING letzter_wert INTO n;
    RETURN 'V-' || j || '-' || lpad(n::TEXT, 4, '0');
END;
$$;

CREATE TABLE IF NOT EXISTS epa_vorgaenge (
    vorgangs_id            TEXT PRIMARY KEY CHECK (vorgangs_id ~ '^V-\d{4}-\d{4,}$'),
    kunde_id               TEXT NOT NULL REFERENCES epa_config_allgemein (kunde_id),
    vorgangstyp            TEXT,
    status                 TEXT NOT NULL CHECK (status IN (
                               'Neu', 'Zuordnung unklar', 'Ignoriert', 'Klassifizierung unklar', 'In Prüfung',
                               'Bereit zur Bearbeitung', 'Lücken erkannt', 'Freigabe ausstehend',
                               'Warten auf Kunde', 'Eskaliert / Manuell', 'Abgeschlossen')),
    conversation_id        TEXT,
    erste_message_id       TEXT,
    letzte_message_id      TEXT,
    bekannte_message_ids   JSONB NOT NULL DEFAULT '[]',
    absender_adresse       TEXT,
    absender_name          TEXT,
    betreff                TEXT,
    betreff_normalisiert   TEXT,
    extrahierte_daten      JSONB NOT NULL DEFAULT '{}',
    fehlende_felder        JSONB NOT NULL DEFAULT '[]',
    konflikte              JSONB NOT NULL DEFAULT '[]',
    rundenzaehler          INTEGER NOT NULL DEFAULT 0,
    antwort_frist          TIMESTAMPTZ,
    erinnerungen_gesendet  INTEGER NOT NULL DEFAULT 0,
    bearbeiter             TEXT,
    freigabe_id_aktuell    UUID,
    spoofing_hinweis       TEXT,
    sprache                TEXT,
    version                INTEGER NOT NULL DEFAULT 1,
    lock_bis               TIMESTAMPTZ,
    lock_durch             TEXT,
    loeschen_ab            TIMESTAMPTZ,
    erstellt_am            TIMESTAMPTZ NOT NULL DEFAULT now(),
    geaendert_am           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS epa_vorgaenge_kunde_status_ix ON epa_vorgaenge (kunde_id, status);
CREATE INDEX IF NOT EXISTS epa_vorgaenge_absender_ix ON epa_vorgaenge (kunde_id, lower(absender_adresse));
CREATE INDEX IF NOT EXISTS epa_vorgaenge_conversation_ix ON epa_vorgaenge (kunde_id, conversation_id);
CREATE INDEX IF NOT EXISTS epa_vorgaenge_message_ids_ix ON epa_vorgaenge USING GIN (bekannte_message_ids);
CREATE INDEX IF NOT EXISTS epa_vorgaenge_frist_ix ON epa_vorgaenge (status, antwort_frist);

-- Dedupe am Eingang (Masterprompt A2)
CREATE TABLE IF NOT EXISTS epa_verarbeitete_mails (
    kunde_id             TEXT NOT NULL,
    internet_message_id  TEXT NOT NULL,
    vorgangs_id          TEXT,
    ergebnis             TEXT NOT NULL,
    verarbeitet_am       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (kunde_id, internet_message_id)
);

-- Freigaben (Bauplan 6, Variante B). Es wird nur der Hash des Tokens gespeichert.
CREATE TABLE IF NOT EXISTS epa_freigaben (
    freigabe_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kunde_id             TEXT NOT NULL,
    vorgangs_id          TEXT NOT NULL REFERENCES epa_vorgaenge (vorgangs_id),
    art                  TEXT NOT NULL CHECK (art IN ('Rueckfrage', 'Erinnerung')),
    freigeber            TEXT NOT NULL,
    token_hash           TEXT NOT NULL UNIQUE,
    erstellt_am          TIMESTAMPTZ NOT NULL DEFAULT now(),
    ablauf               TIMESTAMPTZ NOT NULL,
    erinnert_am          TIMESTAMPTZ,
    verbraucht_am        TIMESTAMPTZ,
    entscheidung         TEXT CHECK (entscheidung IN ('Freigegeben', 'Bearbeitet', 'Abgelehnt', 'Abgelaufen', 'Ersetzt')),
    bearbeitet           BOOLEAN NOT NULL DEFAULT FALSE,
    grund                TEXT,
    entwurf_message_id   TEXT,
    gesendet_am          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS epa_freigaben_vorgang_ix ON epa_freigaben (vorgangs_id);

-- ---------------------------------------------------------------------------
-- Protokolle
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS epa_audit_log (
    id           BIGSERIAL PRIMARY KEY,
    zeitstempel  TIMESTAMPTZ NOT NULL DEFAULT now(),
    kunde_id     TEXT NOT NULL,
    vorgangs_id  TEXT,
    typ          TEXT NOT NULL CHECK (typ IN ('STATUS', 'MERGE', 'FREIGABE', 'ZUORDNUNG', 'DEDUPE', 'SYSTEM')),
    alt          TEXT,
    neu          TEXT,
    ausloeser    TEXT NOT NULL,
    details      JSONB NOT NULL DEFAULT '{}',
    referenz     TEXT
);
CREATE INDEX IF NOT EXISTS epa_audit_vorgang_ix ON epa_audit_log (vorgangs_id, zeitstempel);

-- Append-only: UPDATE/DELETE nur für den Löschjob (SET LOCAL epa.loeschjob = 'on').
CREATE OR REPLACE FUNCTION epa_audit_append_only() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('epa.loeschjob', TRUE) = 'on' AND TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'epa_audit_log ist append-only (% nicht erlaubt)', TG_OP;
END;
$$;
DROP TRIGGER IF EXISTS epa_audit_append_only_trg ON epa_audit_log;
CREATE TRIGGER epa_audit_append_only_trg
    BEFORE UPDATE OR DELETE ON epa_audit_log
    FOR EACH ROW EXECUTE FUNCTION epa_audit_append_only();

-- Fehlerlog: nur IDs, Codes und technische Meldungen, keine Mail-Inhalte.
CREATE TABLE IF NOT EXISTS epa_fehler_log (
    id             BIGSERIAL PRIMARY KEY,
    zeitstempel    TIMESTAMPTZ NOT NULL DEFAULT now(),
    statuscode     INTEGER NOT NULL,
    fehlercode     TEXT NOT NULL,
    klasse         TEXT NOT NULL,
    retrybar       BOOLEAN NOT NULL,
    workflow_id    TEXT,
    workflow_name  TEXT,
    node           TEXT,
    execution_id   TEXT,
    execution_url  TEXT,
    modus          TEXT,
    vorgangs_id    TEXT,
    kunde_id       TEXT,
    meldung        TEXT,
    eskaliert      BOOLEAN NOT NULL DEFAULT FALSE,
    alarmiert_am   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS epa_fehler_zeit_ix ON epa_fehler_log (zeitstempel);

-- Heartbeats, Lauf-Locks, Delta-Tokens, letzte Mail je Postfach
CREATE TABLE IF NOT EXISTS epa_system_status (
    schluessel      TEXT PRIMARY KEY,
    wert            JSONB NOT NULL DEFAULT '{}',
    aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
