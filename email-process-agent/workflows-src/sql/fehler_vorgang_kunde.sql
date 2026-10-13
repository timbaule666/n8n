-- $1 vorgangs_id. Ermittelt den Mandanten eines Vorgangs für den Error-Handler.
SELECT (SELECT kunde_id FROM epa_vorgaenge WHERE vorgangs_id = $1) AS kunde_id;
