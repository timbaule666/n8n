-- $1 kunde_id, $2 vorgangs_id, $3 typ, $4 alt, $5 neu, $6 ausloeser, $7 details (JSON), $8 referenz
INSERT INTO epa_audit_log (kunde_id, vorgangs_id, typ, alt, neu, ausloeser, details, referenz)
VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '{}'::jsonb), $8)
RETURNING id AS audit_id, zeitstempel;
