-- $1 vorgangs_id, $2 kunde_id, $3 alter_status, $4 neuer_status, $5 erwartete_version (oder null),
-- $6 ausloeser, $7 details (JSON), $8 referenz
-- Atomar: Status nur ändern, wenn alter Status (und ggf. Version) noch stimmen; Audit im selben Statement.
WITH upd AS (
    UPDATE epa_vorgaenge
    SET status = $4, version = version + 1, geaendert_am = now()
    WHERE vorgangs_id = $1 AND kunde_id = $2 AND status = $3
      AND ($5::int IS NULL OR version = $5::int)
    RETURNING vorgangs_id, kunde_id, status, version
), aud AS (
    INSERT INTO epa_audit_log (kunde_id, vorgangs_id, typ, alt, neu, ausloeser, details, referenz)
    SELECT kunde_id, vorgangs_id, 'STATUS', $3, $4, $6, COALESCE($7::jsonb, '{}'::jsonb), $8
    FROM upd
    RETURNING id
)
SELECT (SELECT to_jsonb(upd) FROM upd) AS ergebnis, (SELECT id FROM aud) AS audit_id;
