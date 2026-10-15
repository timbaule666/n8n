-- $1 vorgangs_id, $2 kunde_id, $3 aenderungen (JSON, nur Whitelist-Felder), $4 erwartete_version, $5 referenz
-- Status ist hier bewusst NICHT änderbar (nur über "EPA SW Status setzen").
WITH a AS (SELECT $3::jsonb AS a),
upd AS (
    UPDATE epa_vorgaenge v SET
        vorgangstyp           = CASE WHEN a.a ? 'vorgangstyp' THEN a.a->>'vorgangstyp' ELSE v.vorgangstyp END,
        conversation_id       = CASE WHEN a.a ? 'conversation_id' THEN a.a->>'conversation_id' ELSE v.conversation_id END,
        letzte_message_id     = CASE WHEN a.a ? 'letzte_message_id' THEN a.a->>'letzte_message_id' ELSE v.letzte_message_id END,
        bekannte_message_ids  = CASE WHEN a.a ? 'neue_message_ids' THEN (
                                    SELECT COALESCE(jsonb_agg(DISTINCT e), '[]'::jsonb)
                                    FROM jsonb_array_elements(v.bekannte_message_ids || (a.a->'neue_message_ids')) e
                                ) ELSE v.bekannte_message_ids END,
        absender_name         = CASE WHEN a.a ? 'absender_name' THEN a.a->>'absender_name' ELSE v.absender_name END,
        betreff               = CASE WHEN a.a ? 'betreff' THEN a.a->>'betreff' ELSE v.betreff END,
        betreff_normalisiert  = CASE WHEN a.a ? 'betreff_normalisiert' THEN a.a->>'betreff_normalisiert' ELSE v.betreff_normalisiert END,
        extrahierte_daten     = CASE WHEN a.a ? 'extrahierte_daten' THEN a.a->'extrahierte_daten' ELSE v.extrahierte_daten END,
        fehlende_felder       = CASE WHEN a.a ? 'fehlende_felder' THEN a.a->'fehlende_felder' ELSE v.fehlende_felder END,
        konflikte             = CASE WHEN a.a ? 'konflikte' THEN a.a->'konflikte' ELSE v.konflikte END,
        rundenzaehler         = CASE WHEN a.a ? 'rundenzaehler' THEN (a.a->>'rundenzaehler')::int ELSE v.rundenzaehler END,
        antwort_frist         = CASE WHEN a.a ? 'antwort_frist' THEN (a.a->>'antwort_frist')::timestamptz ELSE v.antwort_frist END,
        erinnerungen_gesendet = CASE WHEN a.a ? 'erinnerungen_gesendet' THEN (a.a->>'erinnerungen_gesendet')::int ELSE v.erinnerungen_gesendet END,
        bearbeiter            = CASE WHEN a.a ? 'bearbeiter' THEN a.a->>'bearbeiter' ELSE v.bearbeiter END,
        freigabe_id_aktuell   = CASE WHEN a.a ? 'freigabe_id_aktuell' THEN (a.a->>'freigabe_id_aktuell')::uuid ELSE v.freigabe_id_aktuell END,
        spoofing_hinweis      = CASE WHEN a.a ? 'spoofing_hinweis' THEN a.a->>'spoofing_hinweis' ELSE v.spoofing_hinweis END,
        sprache               = CASE WHEN a.a ? 'sprache' THEN a.a->>'sprache' ELSE v.sprache END,
        version               = v.version + 1,
        geaendert_am          = now()
    FROM a
    WHERE v.vorgangs_id = $1 AND v.kunde_id = $2 AND v.version = $4::int
    RETURNING v.*
), aud AS (
    INSERT INTO epa_audit_log (kunde_id, vorgangs_id, typ, alt, neu, ausloeser, details, referenz)
    SELECT upd.kunde_id, upd.vorgangs_id, 'SYSTEM', NULL, NULL, 'System',
           jsonb_build_object('aktion', 'aktualisieren', 'felder', (SELECT jsonb_agg(k ORDER BY k) FROM jsonb_object_keys(a.a) k)),
           $5
    FROM upd, a
    RETURNING id
)
SELECT (SELECT to_jsonb(upd) FROM upd) AS vorgang,
       (SELECT version FROM epa_vorgaenge WHERE vorgangs_id = $1 AND kunde_id = $2) AS version_vorher;
