-- $1 Fehlerlog-Eintrag (JSON aus fehlerklassen.ausErrorTrigger)
WITH e AS (SELECT $1::jsonb AS e)
INSERT INTO epa_fehler_log (statuscode, fehlercode, klasse, retrybar, workflow_id, workflow_name, node,
                            execution_id, execution_url, modus, vorgangs_id, kunde_id, meldung)
SELECT (e->>'statuscode')::int, e->>'fehlercode', e->>'klasse', (e->>'retrybar')::boolean, e->>'workflow_id',
       e->>'workflow_name', e->>'node', e->>'execution_id', e->>'execution_url', e->>'modus',
       e->>'vorgangs_id', e->>'kunde_id', e->>'meldung'
FROM e
RETURNING id AS fehler_id;
