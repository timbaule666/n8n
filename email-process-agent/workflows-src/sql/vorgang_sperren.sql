-- $1 vorgangs_id, $2 kunde_id, $3 lock_durch (z. B. Execution-ID), $4 sekunden
-- Setzt die Sperre nur, wenn sie frei, abgelaufen oder bereits die eigene ist.
WITH upd AS (
    UPDATE epa_vorgaenge
    SET lock_bis = now() + make_interval(secs => $4::int), lock_durch = $3
    WHERE vorgangs_id = $1 AND kunde_id = $2
      AND (lock_bis IS NULL OR lock_bis < now() OR lock_durch = $3)
    RETURNING vorgangs_id, lock_bis, lock_durch, version
)
SELECT (SELECT to_jsonb(upd) FROM upd) AS sperre,
       (SELECT jsonb_build_object('lock_bis', lock_bis, 'lock_durch', lock_durch)
        FROM epa_vorgaenge WHERE vorgangs_id = $1 AND kunde_id = $2) AS vorher;
