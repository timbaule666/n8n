-- $1 kunde_id (oder ''), $2 postfach (oder '')
-- Liefert genau eine Zeile: Liste der passenden Configs inkl. aktiver Pflichtfelder.
SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'allgemein', to_jsonb(a),
    'pflichtfelder', COALESCE((
        SELECT jsonb_agg(to_jsonb(p) ORDER BY p.vorgangstyp, p.reihenfolge, p.feldname)
        FROM epa_config_pflichtfelder p
        WHERE p.kunde_id = a.kunde_id AND p.aktiv
    ), '[]'::jsonb)
)), '[]'::jsonb) AS treffer
FROM epa_config_allgemein a
WHERE (NULLIF($1, '') IS NOT NULL AND a.kunde_id = $1)
   OR (NULLIF($2, '') IS NOT NULL AND lower(a.postfach) = lower($2));
