-- $1 kunde_id, $2 daten (JSON), $3 referenz
-- Legt einen Vorgang im Status "Neu" an (erlaubter Startübergang null -> Neu) und schreibt das Audit.
WITH d AS (SELECT $2::jsonb AS d),
neu AS (
    INSERT INTO epa_vorgaenge (
        vorgangs_id, kunde_id, vorgangstyp, status, conversation_id, erste_message_id, letzte_message_id,
        bekannte_message_ids, absender_adresse, absender_name, betreff, betreff_normalisiert,
        spoofing_hinweis, erste_mail_am, erste_mail_link, loeschen_ab)
    SELECT epa_naechste_vorgangs_id(), c.kunde_id, d.d->>'vorgangstyp', 'Neu', d.d->>'conversation_id',
           d.d->>'erste_message_id', d.d->>'erste_message_id',
           CASE WHEN d.d->>'erste_message_id' IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(d.d->>'erste_message_id') END,
           lower(d.d->>'absender_adresse'), d.d->>'absender_name', d.d->>'betreff', d.d->>'betreff_normalisiert',
           d.d->>'spoofing_hinweis', (d.d->>'erste_mail_am')::timestamptz, d.d->>'erste_mail_link', now() + make_interval(days => c.aufbewahrung_tage)
    FROM d JOIN epa_config_allgemein c ON c.kunde_id = $1
    RETURNING *
), aud AS (
    INSERT INTO epa_audit_log (kunde_id, vorgangs_id, typ, alt, neu, ausloeser, details, referenz)
    SELECT kunde_id, vorgangs_id, 'STATUS', NULL, 'Neu', 'System', '{"aktion": "anlegen"}'::jsonb, $3
    FROM neu
    RETURNING id
)
SELECT (SELECT to_jsonb(neu) FROM neu) AS vorgang, (SELECT id FROM aud) AS audit_id;
