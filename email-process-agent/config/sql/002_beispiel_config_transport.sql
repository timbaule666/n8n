-- Beispiel-Config: Transportanfrage (Referenzkunde "beispiel-transport")
-- Platzhalter in <SPITZEN_KLAMMERN> vor dem Einspielen ersetzen. Keine Secrets in dieser Datei.
-- Modellnamen sind Vorschläge; in der n8n-Instanz verfügbare OpenAI-Modelle prüfen.

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
    'beispiel-transport', TRUE, '<anfragen-test@ihre-domain.de>', 'Sie', 'de',
    E'Mit freundlichen Grüßen\nIhr Dispositionsteam\nBeispiel Transport GmbH\nTel. <TELEFON>',
    'Diese Nachricht wurde KI-gestützt vorbereitet und von einem Mitarbeiter geprüft und freigegeben.',
    48, TRUE, 3, 24, 2,
    'Europe/Berlin', '{"tage": [1, 2, 3, 4, 5], "von": "08:00", "bis": "17:00"}', 'NW', '[]',
    '{"kanal": "teams", "team_id": "<TEAM_ID>", "channel_id": "<CHANNEL_ID>"}',
    '["<freigeber@ihre-domain.de>"]', '[]', '{}', '[]', '[]',
    0.75, '{"eindeutig": 80, "abstand": 50, "neu": 40}',
    '{
       "klassifizierung": {"modell": "gpt-4o-mini", "temperatur": 0,   "timeout_ms": 30000, "max_tokens": 300},
       "extraktion":      {"modell": "gpt-4o-mini", "temperatur": 0,   "timeout_ms": 60000, "max_tokens": 2000},
       "entwurf":         {"modell": "gpt-4o-mini", "temperatur": 0.2, "timeout_ms": 45000, "max_tokens": 800}
     }',
    '{"klassifizierung": "v2", "extraktion": "v1", "entwurf": "v1"}',
    'EPA-Archiv', 365,
    '{"max_mb_je_anhang": 10, "max_mb_je_mail": 25, "typen": ["application/pdf", "image/jpeg", "image/png", "image/tiff", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]}',
    24, 4, 48
)
ON CONFLICT (kunde_id) DO NOTHING;

INSERT INTO epa_config_pflichtfelder
    (kunde_id, vorgangstyp, feldname, anzeigename, typ, pflicht, validierungsregel, resolution_textbaustein, extraktions_hinweis, reihenfolge)
VALUES
    ('beispiel-transport', 'transport', 'Start_PLZ', 'PLZ Abholort', 'plz', TRUE, '{"regex": "^\\d{5}$"}',
     'Bitte nennen Sie uns die Postleitzahl des Abholorts.', 'Postleitzahl des Ortes, an dem die Ware abgeholt wird', 10),
    ('beispiel-transport', 'transport', 'Start_Ort', 'Abholort', 'text', TRUE, '{"min_laenge": 2, "max_laenge": 80}',
     'Bitte nennen Sie uns den Ort der Abholung.', 'Ortsname des Abholorts', 20),
    ('beispiel-transport', 'transport', 'Ziel_PLZ', 'PLZ Zielort', 'plz', TRUE, '{"regex": "^\\d{5}$"}',
     'Bitte nennen Sie uns die Postleitzahl des Zielorts.', 'Postleitzahl des Lieferortes', 30),
    ('beispiel-transport', 'transport', 'Ziel_Ort', 'Zielort', 'text', TRUE, '{"min_laenge": 2, "max_laenge": 80}',
     'Bitte nennen Sie uns den Zielort.', 'Ortsname des Lieferortes', 40),
    ('beispiel-transport', 'transport', 'Abholdatum', 'Gewünschtes Abholdatum', 'datum', TRUE, '{"min_tage_ab_heute": 0, "max_tage_ab_heute": 365}',
     'Bitte teilen Sie uns das gewünschte Abholdatum mit.', 'Gewünschtes Abholdatum als JJJJ-MM-TT, nur wenn ein konkretes Datum genannt ist', 50),
    ('beispiel-transport', 'transport', 'Gewicht_kg', 'Gesamtgewicht (kg)', 'zahl', TRUE, '{"min": 1, "max": 40000}',
     'Bitte nennen Sie uns das ungefähre Gesamtgewicht der Sendung in Kilogramm.', 'Gesamtgewicht in kg; Tonnen umrechnen, nur wenn die Einheit genannt ist', 60),
    ('beispiel-transport', 'transport', 'Packstuecke', 'Anzahl Packstücke', 'zahl', FALSE, '{"min": 1, "max": 999, "ganzzahl": true}',
     'Bitte teilen Sie uns die Anzahl der Packstücke mit.', 'Anzahl Paletten, Pakete oder Kolli', 70),
    ('beispiel-transport', 'transport', 'Ladungsart', 'Art der Ladung', 'enum', FALSE, '{"werte": ["Palette", "Paket", "Stückgut", "Sonstiges"]}',
     'Bitte beschreiben Sie kurz die Art der Ladung.', 'Einer der erlaubten Werte in der Einzahl, auch wenn die Art nur zusammen mit einer Anzahl genannt ist (z. B. „3 Paletten“ → Palette, „12 Pakete“ → Paket). Leer lassen, wenn keine Ladungsart genannt ist', 80),
    ('beispiel-transport', 'transport', 'Ansprechpartner', 'Ansprechpartner', 'text', TRUE, '{"min_laenge": 2, "max_laenge": 80, "person": true}',
     'Bitte nennen Sie uns einen Ansprechpartner für Rückfragen.', 'Vor- und Nachname einer Person beim Kunden, ohne Anrede (Herr/Frau). Keine Firmen-, Abteilungs- oder Teamnamen; leer lassen, wenn keine Person genannt ist', 90),
    ('beispiel-transport', 'transport', 'Telefon', 'Telefonnummer', 'telefon', TRUE, '{"min_ziffern": 6, "max_ziffern": 20}',
     'Bitte geben Sie uns eine Telefonnummer für Rückfragen an.', 'Telefonnummer der Kontaktperson', 100)
ON CONFLICT (kunde_id, vorgangstyp, feldname) DO NOTHING;

COMMIT;
