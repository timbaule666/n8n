-- $1 vorgangs_id, $2 kunde_id
SELECT (
    SELECT jsonb_build_object('status', status, 'version', version)
    FROM epa_vorgaenge
    WHERE vorgangs_id = $1 AND kunde_id = $2
) AS vorgang;
