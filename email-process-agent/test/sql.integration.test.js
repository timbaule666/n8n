'use strict';
// Integrationstests gegen eine echte Postgres-Datenbank. Läuft nur, wenn EPA_TEST_PG gesetzt ist, z. B.
//   EPA_TEST_PG='postgres://postgres@localhost:5432/postgres' npm test
// Legt eine eigene Wegwerf-Datenbank an und löscht sie danach.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers/n8nNodes');
const { validiereConfig } = require('../src/configValidator');
const fk = require('../src/fehlerklassen');

const URL = process.env.EPA_TEST_PG;
const SKIP = URL ? false : 'EPA_TEST_PG nicht gesetzt';

test('SQL-Integration', { skip: SKIP }, async (t) => {
	const pgp = require('pg-promise')();
	const admin = pgp(URL);
	const dbName = `epa_test_${process.pid}`;
	await admin.none(`DROP DATABASE IF EXISTS ${dbName}`);
	await admin.none(`CREATE DATABASE ${dbName}`);
	const u = new globalThis.URL(URL);
	u.pathname = `/${dbName}`;
	const db = pgp(u.toString());

	t.after(async () => {
		await db.$pool.end();
		await admin.none(`DROP DATABASE IF EXISTS ${dbName}`);
		pgp.end();
	});

	const sqlDir = path.join(h.ROOT, 'config', 'sql');
	for (const f of ['001_schema.sql', '002_beispiel_config_transport.sql', '001_schema.sql']) {
		await db.multi(fs.readFileSync(path.join(sqlDir, f), 'utf8'));
	}

	const wfConfig = h.workflow('EPA_SW_Config_laden.json');
	const wfStatus = h.workflow('EPA_SW_Status_setzen.json');
	const wfVorgang = h.workflow('EPA_SW_Vorgang_verwalten.json');
	const wfAudit = h.workflow('EPA_SW_Audit_schreiben.json');
	const wfFehler = h.workflow('EPA-05_Error-Handler.json');

	await t.test('Beispiel-Config mit Platzhaltern wird abgelehnt, nach Ersetzen akzeptiert', async () => {
		let [r] = await h.postgres(db, pgp, wfConfig, 'Config lesen', { kunde_id: 'beispiel-transport', postfach: '' });
		assert.equal(r.treffer.length, 1);
		const v1 = validiereConfig(r.treffer[0].allgemein, r.treffer[0].pflichtfelder);
		assert.equal(v1.gueltig, false);
		assert.match(v1.fehler.join('\n'), /postfach/);
		assert.match(v1.fehler.join('\n'), /freigeber/);

		await db.none(`UPDATE epa_config_allgemein SET postfach = 'Anfragen-Test@Beispiel.de', freigeber = '["dispo@beispiel.de"]' WHERE kunde_id = 'beispiel-transport'`);
		[r] = await h.postgres(db, pgp, wfConfig, 'Config lesen', { kunde_id: '', postfach: 'anfragen-test@beispiel.de' });
		assert.equal(r.treffer.length, 1, 'Suche über Postfach ist case-insensitive');
		const v2 = validiereConfig(r.treffer[0].allgemein, r.treffer[0].pflichtfelder);
		assert.equal(v2.gueltig, true, v2.fehler.join('\n'));
		assert.equal(v2.config.vorgangstypen.transport.length, 10);
		assert.equal(v2.config.vorgangstypen.transport[0].validierungsregel.regex, '^\\d{5}$');
		assert.ok(new RegExp(v2.config.vorgangstypen.transport[0].validierungsregel.regex).test('40210'));
	});

	await t.test('Code-Node "Config validieren" mit echten DB-Daten', async () => {
		const [r] = await h.postgres(db, pgp, wfConfig, 'Config lesen', { kunde_id: 'beispiel-transport', postfach: '' });
		const out = await h.code(wfConfig, 'Config validieren', r, { 'Eingabe prüfen': { kunde_id: 'beispiel-transport', postfach: '' } });
		assert.equal(out[0].json.config.kunde_id, 'beispiel-transport');
		await assert.rejects(
			h.code(wfConfig, 'Config validieren', { treffer: [] }, { 'Eingabe prüfen': { kunde_id: 'gibtsnicht', postfach: '' } }),
			/\[EPA:404:KONFIG_NICHT_GEFUNDEN:-\]/,
		);
	});

	let vorgang;
	await t.test('Vorgang anlegen: ID-Format, Startstatus, Audit, Löschfrist', async () => {
		const [r] = await h.postgres(db, pgp, wfVorgang, 'Vorgang anlegen', {
			kunde_id: 'beispiel-transport',
			referenz: 'exec-1',
			daten: { erste_message_id: '<m1@kunde.de>', conversation_id: 'conv-1', absender_adresse: 'Max@Kunde.de', betreff: 'Anfrage Transport', betreff_normalisiert: 'anfrage transport' },
		});
		vorgang = r.vorgang;
		assert.match(vorgang.vorgangs_id, /^V-\d{4}-\d{4}$/);
		assert.equal(vorgang.status, 'Neu');
		assert.equal(vorgang.version, 1);
		assert.equal(vorgang.absender_adresse, 'max@kunde.de');
		assert.deepEqual(vorgang.bekannte_message_ids, ['<m1@kunde.de>']);
		assert.ok(vorgang.loeschen_ab);
		const audit = await db.one('SELECT * FROM epa_audit_log WHERE id = $1', [r.audit_id]);
		assert.equal(audit.neu, 'Neu');
		assert.equal(audit.alt, null);
		const [r2] = await h.postgres(db, pgp, wfVorgang, 'Vorgang anlegen', { kunde_id: 'beispiel-transport', referenz: 'x', daten: {} });
		assert.notEqual(r2.vorgang.vorgangs_id, vorgang.vorgangs_id);
	});

	await t.test('Vorgang anlegen für unbekannten Kunden legt nichts an', async () => {
		const [r] = await h.postgres(db, pgp, wfVorgang, 'Vorgang anlegen', { kunde_id: 'unbekannt', referenz: 'x', daten: {} });
		assert.equal(r.vorgang, null);
	});

	await t.test('Status setzen: Erfolg, veralteter Status, Versionskonflikt, Audit atomar', async () => {
		const basis = { vorgangs_id: vorgang.vorgangs_id, kunde_id: 'beispiel-transport', ausloeser: 'KI', details: { konfidenz: 0.93 }, referenz: 'exec-2' };
		let [r] = await h.postgres(db, pgp, wfStatus, 'Status schreiben', { ...basis, alter_status: 'Neu', neuer_status: 'In Prüfung', erwartete_version: 1 });
		assert.equal(r.ergebnis.status, 'In Prüfung');
		assert.equal(r.ergebnis.version, 2);
		const audit = await db.one('SELECT * FROM epa_audit_log WHERE id = $1', [r.audit_id]);
		assert.deepEqual([audit.alt, audit.neu, audit.ausloeser, audit.details.konfidenz], ['Neu', 'In Prüfung', 'KI', 0.93]);

		const vorher = await db.one('SELECT count(*)::int AS n FROM epa_audit_log');
		[r] = await h.postgres(db, pgp, wfStatus, 'Status schreiben', { ...basis, alter_status: 'Neu', neuer_status: 'In Prüfung', erwartete_version: null });
		assert.equal(r.ergebnis, null, 'alter Status passt nicht mehr');
		[r] = await h.postgres(db, pgp, wfStatus, 'Status schreiben', { ...basis, alter_status: 'In Prüfung', neuer_status: 'Lücken erkannt', erwartete_version: 1 });
		assert.equal(r.ergebnis, null, 'Version passt nicht');
		const nachher = await db.one('SELECT count(*)::int AS n FROM epa_audit_log');
		assert.equal(nachher.n, vorher.n, 'kein Audit ohne Statuswechsel');

		[r] = await h.postgres(db, pgp, wfStatus, 'Status schreiben', { ...basis, ausloeser: 'System', alter_status: 'In Prüfung', neuer_status: 'Lücken erkannt' });
		assert.equal(r.ergebnis.version, 3);
	});

	await t.test('Status setzen: Code-Nodes Übergang prüfen und Ergebnis prüfen', async () => {
		const e = { kunde_id: 'beispiel-transport', vorgangs_id: vorgang.vorgangs_id, neuer_status: 'Warten auf Kunde', ausloeser: 'System', details: {}, referenz: 'r', erwartete_version: null, nur_wenn_erlaubt: false };
		const [geladen] = await h.postgres(db, pgp, wfStatus, 'Vorgang laden', e);
		assert.equal(geladen.vorgang.status, 'Lücken erkannt');
		await assert.rejects(h.code(wfStatus, 'Übergang prüfen', geladen, { 'Eingabe prüfen': e }), /\[EPA:409:UNZULAESSIGER_STATUSWECHSEL:V-/);
		const still = await h.code(wfStatus, 'Übergang prüfen', geladen, { 'Eingabe prüfen': { ...e, nur_wenn_erlaubt: true } });
		assert.equal(still[0].json.erlaubt, false);
		const ok = await h.code(wfStatus, 'Übergang prüfen', geladen, { 'Eingabe prüfen': { ...e, neuer_status: 'Freigabe ausstehend' } });
		assert.equal(ok[0].json.erlaubt, true);
		await assert.rejects(h.code(wfStatus, 'Übergang prüfen', { vorgang: null }, { 'Eingabe prüfen': e }), /\[EPA:404:VORGANG_NICHT_GEFUNDEN/);
		await assert.rejects(h.code(wfStatus, 'Übergang prüfen', geladen, { 'Eingabe prüfen': { ...e, neuer_status: 'Freigabe ausstehend', erwartete_version: 1 } }), /VERSIONSKONFLIKT/);
		await assert.rejects(h.code(wfStatus, 'Ergebnis prüfen', { ergebnis: null, audit_id: null }, { 'Übergang prüfen': ok[0].json }), /\[EPA:409:VERSIONSKONFLIKT/);
	});

	await t.test('Vorgang aktualisieren: Whitelist, Message-IDs, Null-Werte, Versionskonflikt', async () => {
		const [lesen] = await h.postgres(db, pgp, wfVorgang, 'Vorgang lesen', { vorgangs_id: vorgang.vorgangs_id, kunde_id: 'beispiel-transport' });
		const v = lesen.vorgang.version;
		let [r] = await h.postgres(db, pgp, wfVorgang, 'Vorgang aktualisieren', {
			vorgangs_id: vorgang.vorgangs_id, kunde_id: 'beispiel-transport', erwartete_version: v, referenz: 'exec-3',
			daten: {
				neue_message_ids: ['<m2@firma.de>', '<m1@kunde.de>'],
				extrahierte_daten: { Start_PLZ: { wert: '40210' } },
				fehlende_felder: [{ feld: 'Ziel_PLZ', grund: 'fehlt' }],
				rundenzaehler: 1,
				antwort_frist: '2026-10-16T15:00:00+02:00',
				freigabe_id_aktuell: null,
			},
		});
		assert.equal(r.vorgang.version, v + 1);
		assert.deepEqual(r.vorgang.bekannte_message_ids.sort(), ['<m1@kunde.de>', '<m2@firma.de>']);
		assert.equal(r.vorgang.extrahierte_daten.Start_PLZ.wert, '40210');
		assert.equal(r.vorgang.rundenzaehler, 1);
		assert.equal(r.vorgang.status, 'Lücken erkannt', 'Status bleibt unverändert');
		[r] = await h.postgres(db, pgp, wfVorgang, 'Vorgang aktualisieren', {
			vorgangs_id: vorgang.vorgangs_id, kunde_id: 'beispiel-transport', erwartete_version: v + 1, referenz: 'x', daten: { antwort_frist: null },
		});
		assert.equal(r.vorgang.antwort_frist, null);
		assert.equal(r.vorgang.rundenzaehler, 1, 'nicht übergebene Felder bleiben');

		[r] = await h.postgres(db, pgp, wfVorgang, 'Vorgang aktualisieren', {
			vorgangs_id: vorgang.vorgangs_id, kunde_id: 'beispiel-transport', erwartete_version: v, referenz: 'x', daten: { bearbeiter: 'x' },
		});
		assert.equal(r.vorgang, null);
		assert.equal(r.version_vorher, v + 2);
		await assert.rejects(h.code(wfVorgang, 'Ergebnis auswerten', r, { 'Eingabe prüfen': { aktion: 'aktualisieren', vorgangs_id: vorgang.vorgangs_id, erwartete_version: v } }), /\[EPA:409:VERSIONSKONFLIKT/);

		[r] = await h.postgres(db, pgp, wfVorgang, 'Vorgang aktualisieren', {
			vorgangs_id: 'V-1999-0001', kunde_id: 'beispiel-transport', erwartete_version: 1, referenz: 'x', daten: { bearbeiter: 'x' },
		});
		await assert.rejects(h.code(wfVorgang, 'Ergebnis auswerten', r, { 'Eingabe prüfen': { aktion: 'aktualisieren', vorgangs_id: 'V-1999-0001' } }), /\[EPA:404:VORGANG_NICHT_GEFUNDEN/);

		await assert.rejects(
			h.code(wfVorgang, 'Eingabe prüfen', { aktion: 'aktualisieren', kunde_id: 'beispiel-transport', vorgangs_id: vorgang.vorgangs_id, erwartete_version: 1, daten: { status: 'Abgeschlossen' } }),
			/Nicht änderbare Felder: status/,
		);
	});

	await t.test('Mandantentrennung: anderer Kunde sieht den Vorgang nicht', async () => {
		const [r] = await h.postgres(db, pgp, wfVorgang, 'Vorgang lesen', { vorgangs_id: vorgang.vorgangs_id, kunde_id: 'anderer-kunde' });
		assert.equal(r.vorgang, null);
	});

	await t.test('Kandidaten suchen: Message-ID, Conversation, Absender, Vorgangs-ID; nur offene', async () => {
		const suche = async (daten) => (await h.postgres(db, pgp, wfVorgang, 'Kandidaten suchen', { kunde_id: 'beispiel-transport', daten }))[0].kandidaten;
		assert.equal((await suche({ message_ids: ['<m2@firma.de>'] })).length, 1);
		assert.equal((await suche({ conversation_id: 'conv-1' })).length, 1);
		assert.equal((await suche({ absender_adresse: 'MAX@kunde.de' })).length, 1);
		assert.equal((await suche({ vorgangs_ids: [vorgang.vorgangs_id] })).length, 1);
		assert.equal((await suche({ message_ids: ['<unbekannt@x>'] })).length, 0);
		assert.deepEqual(await suche({}), []);
		await db.none(`UPDATE epa_vorgaenge SET status = 'Abgeschlossen' WHERE vorgangs_id = $1`, [vorgang.vorgangs_id]);
		assert.equal((await suche({ conversation_id: 'conv-1' })).length, 0);
		await db.none(`UPDATE epa_vorgaenge SET status = 'Lücken erkannt' WHERE vorgangs_id = $1`, [vorgang.vorgangs_id]);
	});

	await t.test('Sperren: exklusiv, wiederholbar durch Inhaber, nach Ablauf frei', async () => {
		const sperren = async (wer) => (await h.postgres(db, pgp, wfVorgang, 'Vorgang sperren', { vorgangs_id: vorgang.vorgangs_id, kunde_id: 'beispiel-transport', referenz: wer, lock_sekunden: 60 }))[0];
		assert.ok((await sperren('A')).sperre);
		const b = await sperren('B');
		assert.equal(b.sperre, null);
		assert.equal(b.vorher.lock_durch, 'A');
		assert.ok((await sperren('A')).sperre);
		const [ent] = await h.postgres(db, pgp, wfVorgang, 'Vorgang entsperren', { vorgangs_id: vorgang.vorgangs_id, kunde_id: 'beispiel-transport', referenz: 'B' });
		assert.equal(ent.entsperrt, false, 'fremde Sperre nicht lösbar');
		await db.none(`UPDATE epa_vorgaenge SET lock_bis = now() - interval '1 second' WHERE vorgangs_id = $1`, [vorgang.vorgangs_id]);
		assert.ok((await sperren('B')).sperre, 'abgelaufene Sperre ist frei');
		const [ent2] = await h.postgres(db, pgp, wfVorgang, 'Vorgang entsperren', { vorgangs_id: vorgang.vorgangs_id, kunde_id: 'beispiel-transport', referenz: 'B' });
		assert.equal(ent2.entsperrt, true);
	});

	await t.test('Audit schreiben und append-only', async () => {
		const [r] = await h.postgres(db, pgp, wfAudit, 'Audit schreiben', {
			kunde_id: 'beispiel-transport', vorgangs_id: vorgang.vorgangs_id, typ: 'MERGE', alt: null, neu: '40210', ausloeser: 'KI',
			details: { feld: 'Start_PLZ', quelle: '<m2@kunde.de>' }, referenz: 'exec-4',
		});
		assert.ok(r.audit_id);
		await assert.rejects(db.none('UPDATE epa_audit_log SET neu = $1 WHERE id = $2', ['x', r.audit_id]), /append-only/);
		await assert.rejects(db.none('DELETE FROM epa_audit_log WHERE id = $1', [r.audit_id]), /append-only/);
		await db.tx(async (tx) => {
			await tx.none("SET LOCAL epa.loeschjob = 'on'");
			await tx.none('DELETE FROM epa_audit_log WHERE id = $1', [r.audit_id]);
		});
		await assert.rejects(h.code(wfAudit, 'Eintrag prüfen', { kunde_id: 'k', typ: 'LOESCHEN', ausloeser: 'System' }), /Audit-Typ/);
	});

	await t.test('Parameter mit Anführungszeichen, Zeilenumbruch und $-Zeichen sind sicher', async () => {
		const boese = "x'); DROP TABLE epa_vorgaenge; --\n$2 $1 \\";
		const [r] = await h.postgres(db, pgp, wfAudit, 'Audit schreiben', {
			kunde_id: 'beispiel-transport', vorgangs_id: null, typ: 'SYSTEM', alt: boese, neu: null, ausloeser: 'System', details: { text: boese }, referenz: boese,
		});
		const zeile = await db.one('SELECT alt, referenz, details FROM epa_audit_log WHERE id = $1', [r.audit_id]);
		assert.equal(zeile.alt, boese);
		assert.equal(zeile.referenz, boese);
		assert.equal(zeile.details.text, boese);
		await db.one('SELECT count(*) FROM epa_vorgaenge');
	});

	await t.test('Fehlerlog: Eintrag aus Error-Trigger, Alarm vermerken', async () => {
		const eintrag = fk.ausErrorTrigger({
			execution: { id: 77, url: 'https://n8n/execution/77', error: { message: fk.formatEpaFehler('VERSIONSKONFLIKT', vorgang.vorgangs_id, 'x') }, lastNodeExecuted: 'Ergebnis prüfen', mode: 'integrated' },
			workflow: { id: 'w', name: 'EPA SW Status setzen' },
		});
		const [p] = await h.postgres(db, pgp, wfFehler, 'Fehler protokollieren', eintrag);
		assert.ok(p.fehler_id);
		const [k] = await h.postgres(db, pgp, wfFehler, 'Mandant ermitteln', {}, { 'Fehler klassifizieren': eintrag });
		assert.equal(k.kunde_id, 'beispiel-transport');
		const [esk] = await h.postgres(db, pgp, wfFehler, 'Eskalation vermerken', { ok: true }, { 'Fehler protokollieren': { fehler_id: p.fehler_id } });
		assert.equal(esk.eskaliert, true);
		const [a] = await h.postgres(db, pgp, wfFehler, 'Alarm vermerken', {}, { 'Alarm vorbereiten': { fehler_id: p.fehler_id, eskaliert: true } });
		assert.ok(a.alarmiert_am);
		const leer = await h.postgres(db, pgp, wfFehler, 'Eskalation vermerken', { ok: true }, { 'Fehler protokollieren': {} });
		assert.equal(leer.length, 0, 'ohne Fehler-ID wird nichts geändert');
		const zeile = await db.one('SELECT * FROM epa_fehler_log WHERE id = $1', [p.fehler_id]);
		assert.equal(eintrag.eskalieren, false, 'Versionskonflikt wird nicht eskaliert');
		assert.equal(zeile.statuscode, 409);
		assert.equal(zeile.vorgangs_id, vorgang.vorgangs_id);
		assert.equal(zeile.eskaliert, true);
	});

	await t.test('Vorgangs-ID parallel kollisionsfrei', async () => {
		const ids = await Promise.all(Array.from({ length: 25 }, () => db.one('SELECT epa_naechste_vorgangs_id() AS id').then((r) => r.id)));
		assert.equal(new Set(ids).size, 25);
	});
});
