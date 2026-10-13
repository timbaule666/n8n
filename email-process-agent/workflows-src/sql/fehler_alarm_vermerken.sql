-- $1 fehler_id
UPDATE epa_fehler_log SET alarmiert_am = now()
WHERE id = $1::bigint
RETURNING id AS fehler_id, alarmiert_am;
