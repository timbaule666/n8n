-- $1 fehler_id (oder null), $2 eskaliert (bool)
UPDATE epa_fehler_log SET eskaliert = $2::boolean
WHERE id = $1::bigint
RETURNING id AS fehler_id, eskaliert;
