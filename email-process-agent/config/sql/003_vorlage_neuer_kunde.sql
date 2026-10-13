-- Leere Config-Vorlage für einen neuen Kunden.
-- Alle <PLATZHALTER> ersetzen, dann einspielen. Pro Pflichtfeld eine Zeile im zweiten INSERT.
-- Der Config-Validator (EPA SW Config laden) bricht hart ab, wenn etwas fehlt oder ungültig ist.

BEGIN;

INSERT INTO epa_config_allgemein (
    kunde_id, aktiv, postfach, anrede_stil, sprache, signatur, ki_hinweistext,
    frist_stunden, frist_nur_geschaeftszeit, max_runden, erinnerung_intervall_stunden, anzahl_erinnerungen,
    zeitzone, geschaeftszeiten, feiertage_region, zusaetzliche_feiertage,
    benachrichtigung, freigeber, vertreter, zustaendigkeit, absender_allowlist, absender_blocklist,
    konfidenz_schwelle, zuordnung_schwellen, llm_profil, prompt_versionen,
    archivordner, aufbewahrung_tage, anhang_limits,
    leerantwort_fristverlaengerung_stunden, freigabe_erinnerung_stunden, freigabe_ablauf_stunden
) VALUES (
    '<kunde-id, klein, a-z0-9_->',      -- kunde_id
    TRUE,                                -- aktiv
    '<postfach@kunde.de>',               -- überwachtes Postfach
    '<Sie|Du>',                          -- anrede_stil
    'de',                                -- sprache (ISO, zwei Buchstaben)
    E'<Signatur, Zeilenumbruch mit \\n>',
    '<KI-Hinweistext, juristisch geprüft>',
    48,                                  -- frist_stunden
    TRUE,                                -- frist_nur_geschaeftszeit
    3,                                   -- max_runden
    24,                                  -- erinnerung_intervall_stunden
    2,                                   -- anzahl_erinnerungen
    'Europe/Berlin',                     -- zeitzone
    '{"tage": [1, 2, 3, 4, 5], "von": "08:00", "bis": "17:00"}',
    '<Bundesland-Kürzel, z. B. NW>',     -- feiertage_region
    '[]',                                -- zusaetzliche_feiertage, z. B. ["2026-12-24"]
    '{"kanal": "teams", "team_id": "<TEAM_ID>", "channel_id": "<CHANNEL_ID>"}',
    '["<freigeber@kunde.de>"]',
    '[]',                                -- vertreter
    '{}',                                -- zustaendigkeit, z. B. {"transport": "dispo@kunde.de"}
    '[]',                                -- absender_allowlist (leer = alle)
    '[]',                                -- absender_blocklist
    0.75,                                -- konfidenz_schwelle Klassifizierung
    '{"eindeutig": 80, "abstand": 50, "neu": 40}',
    '{"klassifizierung": {"modell": "<modell>", "temperatur": 0, "timeout_ms": 30000, "max_tokens": 300},
      "extraktion":      {"modell": "<modell>", "temperatur": 0, "timeout_ms": 60000, "max_tokens": 2000},
      "entwurf":         {"modell": "<modell>", "temperatur": 0.2, "timeout_ms": 45000, "max_tokens": 800}}',
    '{"klassifizierung": "v1", "extraktion": "v1", "entwurf": "v1"}',
    'EPA-Archiv',                        -- archivordner im Postfach
    365,                                 -- aufbewahrung_tage
    '{"max_mb_je_anhang": 10, "max_mb_je_mail": 25, "typen": ["application/pdf", "image/jpeg", "image/png"]}',
    24,                                  -- leerantwort_fristverlaengerung_stunden (0 = aus)
    4,                                   -- freigabe_erinnerung_stunden
    48                                   -- freigabe_ablauf_stunden
);

-- Feldtypen: text, plz, datum, zahl, email, telefon, enum
-- Validierungsregel (JSON) je Typ:
--   text:    {"min_laenge": 2, "max_laenge": 80, "regex": "..."}
--   plz:     {"regex": "^\\d{5}$"}
--   datum:   {"min_tage_ab_heute": 0, "max_tage_ab_heute": 365}
--   zahl:    {"min": 1, "max": 40000, "ganzzahl": true}
--   email:   {"regex": "..."}  (optional)
--   telefon: {"min_ziffern": 6, "max_ziffern": 20}
--   enum:    {"werte": ["A", "B"]}
INSERT INTO epa_config_pflichtfelder
    (kunde_id, vorgangstyp, feldname, anzeigename, typ, pflicht, validierungsregel, resolution_textbaustein, extraktions_hinweis, reihenfolge)
VALUES
    ('<kunde-id>', '<vorgangstyp>', '<Feldname>', '<Anzeigename>', '<typ>', TRUE, '{}',
     '<Fester Satz für die Rückfrage, wenn das Feld fehlt>', '<kurze Beschreibung für die Extraktion>', 10);

COMMIT;
