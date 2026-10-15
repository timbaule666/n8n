-- $1 kunde_id, $2 kriterien (JSON: message_ids[], conversation_id, absender_adresse, betreff_normalisiert, vorgangs_ids[])
-- Nur offene Vorgänge. Bewertung der Kandidaten erfolgt deterministisch im Code (Bauplan 5.2).
WITH k AS (SELECT $2::jsonb AS k)
SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS kandidaten
FROM (
    SELECT v.vorgangs_id, v.status, v.conversation_id, v.bekannte_message_ids, v.absender_adresse,
           v.betreff_normalisiert, v.version, v.geaendert_am
    FROM epa_vorgaenge v, k
    WHERE v.kunde_id = $1
      AND v.status NOT IN ('Abgeschlossen', 'Ignoriert')
      AND (
            v.bekannte_message_ids ?| ARRAY(SELECT jsonb_array_elements_text(COALESCE(k.k->'message_ids', '[]'::jsonb)))
         OR (k.k->>'conversation_id' IS NOT NULL AND v.conversation_id = k.k->>'conversation_id')
         OR (k.k->>'absender_adresse' IS NOT NULL AND lower(v.absender_adresse) = lower(k.k->>'absender_adresse'))
         OR (k.k->>'betreff_normalisiert' IS NOT NULL AND v.betreff_normalisiert = k.k->>'betreff_normalisiert')
         OR v.vorgangs_id IN (SELECT jsonb_array_elements_text(COALESCE(k.k->'vorgangs_ids', '[]'::jsonb)))
      )
    -- Starke Hinweise (Message-ID, genannte Vorgangs-ID, Konversation) zuerst, damit sie nie wegfallen.
    ORDER BY COALESCE((
            v.bekannte_message_ids ?| ARRAY(SELECT jsonb_array_elements_text(COALESCE(k.k->'message_ids', '[]'::jsonb)))
         OR v.vorgangs_id IN (SELECT jsonb_array_elements_text(COALESCE(k.k->'vorgangs_ids', '[]'::jsonb)))
         OR (k.k->>'conversation_id' IS NOT NULL AND v.conversation_id = k.k->>'conversation_id')
         ), false) DESC, v.geaendert_am DESC
    LIMIT 20
) t;
