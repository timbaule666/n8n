-- $1 fehler_id, $2 eskaliert (bool)
UPDATE epa_fehler_log SET alarmiert_am = now(), eskaliert = $2::boolean
WHERE id = $1::bigint
RETURNING id AS fehler_id, alarmiert_am;
