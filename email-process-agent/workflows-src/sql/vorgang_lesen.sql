-- $1 vorgangs_id, $2 kunde_id
SELECT (SELECT to_jsonb(v) FROM epa_vorgaenge v WHERE v.vorgangs_id = $1 AND v.kunde_id = $2) AS vorgang;
