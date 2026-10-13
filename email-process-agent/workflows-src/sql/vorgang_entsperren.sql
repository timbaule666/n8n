-- $1 vorgangs_id, $2 kunde_id, $3 lock_durch
WITH upd AS (
    UPDATE epa_vorgaenge SET lock_bis = NULL, lock_durch = NULL
    WHERE vorgangs_id = $1 AND kunde_id = $2 AND lock_durch = $3
    RETURNING vorgangs_id
)
SELECT EXISTS (SELECT 1 FROM upd) AS entsperrt;
