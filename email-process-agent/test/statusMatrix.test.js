'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { STATUS: S, ALLE_STATUS, UEBERGAENGE, pruefeUebergang, erlaubteFolgestatus, ausloeserTyp } = require('../src/statusMatrix');

const MA = 'Mitarbeiter:anna.schmidt@firma.de';

test('alle Status aus dem Masterprompt sind definiert', () => {
	assert.deepEqual(ALLE_STATUS, [
		'Neu', 'Zuordnung unklar', 'Ignoriert', 'Klassifizierung unklar', 'In Prüfung', 'Bereit zur Bearbeitung',
		'Lücken erkannt', 'Freigabe ausstehend', 'Warten auf Kunde', 'Eskaliert / Manuell', 'Abgeschlossen',
	]);
});

test('jede Regel der Matrix ist mit einem ihrer Auslöser erlaubt', () => {
	for (const [von, nach, ausloeser] of UEBERGAENGE) {
		for (const typ of ausloeser) {
			const a = typ === 'Mitarbeiter' ? MA : typ;
			assert.equal(pruefeUebergang(von, nach, a).erlaubt, true, `${von} -> ${nach} (${a})`);
		}
	}
});

test('Hauptpfad Masterprompt 4.4 ist durchgängig erlaubt', () => {
	const pfad = [
		[null, S.NEU, 'System'],
		[S.NEU, S.IN_PRUEFUNG, 'KI'],
		[S.IN_PRUEFUNG, S.LUECKEN, 'System'],
		[S.LUECKEN, S.FREIGABE, 'System'],
		[S.FREIGABE, S.WARTEN, MA],
		[S.WARTEN, S.IN_PRUEFUNG, 'System'],
		[S.IN_PRUEFUNG, S.BEREIT, 'System'],
		[S.BEREIT, S.ABGESCHLOSSEN, MA],
	];
	for (const [a, n, w] of pfad) assert.equal(pruefeUebergang(a, n, w).erlaubt, true, `${a} -> ${n}`);
});

test('unzulässige Übergänge liefern 409', () => {
	const faelle = [
		[S.NEU, S.WARTEN, 'System'],
		[S.NEU, S.ABGESCHLOSSEN, 'System'],
		[S.ABGESCHLOSSEN, S.IN_PRUEFUNG, MA],
		[S.LUECKEN, S.WARTEN, 'System'],
		[S.IN_PRUEFUNG, S.FREIGABE, 'System'],
		[S.BEREIT, S.LUECKEN, 'System'],
		[null, S.IN_PRUEFUNG, 'System'],
		[S.WARTEN, S.WARTEN, 'Cronjob'],
	];
	for (const [a, n, w] of faelle) {
		const r = pruefeUebergang(a, n, w);
		assert.equal(r.erlaubt, false, `${a} -> ${n}`);
		assert.equal(r.statuscode, 409);
	}
});

test('kein Versand ohne Mitarbeiter: Freigabe -> Warten nur durch Mitarbeiter', () => {
	for (const w of ['KI', 'System', 'Cronjob']) {
		const r = pruefeUebergang(S.FREIGABE, S.WARTEN, w);
		assert.equal(r.erlaubt, false);
		assert.equal(r.code, 'UNZULAESSIGER_AUSLOESER');
	}
	assert.equal(pruefeUebergang(S.FREIGABE, S.WARTEN, MA).erlaubt, true);
});

test('KI darf nie direkt abschließen oder Lücken setzen', () => {
	for (const nach of [S.ABGESCHLOSSEN, S.LUECKEN, S.BEREIT, S.WARTEN]) {
		for (const von of [null, ...ALLE_STATUS]) assert.equal(pruefeUebergang(von, nach, 'KI').erlaubt, false, `${von} -> ${nach}`);
	}
});

test('Systemeskalation aus jedem laufenden Status, nie aus Endstatus', () => {
	for (const von of ALLE_STATUS) {
		const r = pruefeUebergang(von, S.ESKALIERT, 'System');
		const erwartet = ![S.ABGESCHLOSSEN, S.IGNORIERT, S.ESKALIERT].includes(von);
		assert.equal(r.erlaubt, erwartet, von);
	}
});

test('Erinnerung läuft über Freigabe (Cronjob), Eskalation durch Cronjob', () => {
	assert.equal(pruefeUebergang(S.WARTEN, S.FREIGABE, 'Cronjob').erlaubt, true);
	assert.equal(pruefeUebergang(S.WARTEN, S.ESKALIERT, 'Cronjob').erlaubt, true);
	// Erneute Freigabe nach Versandfehler: nur ein Mitarbeiter
	assert.equal(pruefeUebergang(S.ESKALIERT, S.WARTEN, 'Mitarbeiter:a@b.de').erlaubt, true);
	assert.equal(pruefeUebergang(S.ESKALIERT, S.WARTEN, 'System').erlaubt, false);
	assert.equal(pruefeUebergang(S.WARTEN, S.FREIGABE, 'KI').erlaubt, false);
});

test('Ignoriert kann nur ein Mitarbeiter zurückholen', () => {
	assert.equal(pruefeUebergang(S.IGNORIERT, S.IN_PRUEFUNG, MA).erlaubt, true);
	assert.equal(pruefeUebergang(S.IGNORIERT, S.IN_PRUEFUNG, 'System').erlaubt, false);
});

test('Auslöser und Status werden validiert (400)', () => {
	assert.equal(pruefeUebergang(S.NEU, S.IN_PRUEFUNG, 'Mitarbeiter').statuscode, 400);
	assert.equal(pruefeUebergang(S.NEU, S.IN_PRUEFUNG, 'Mitarbeiter:  ').statuscode, 400);
	assert.equal(pruefeUebergang(S.NEU, S.IN_PRUEFUNG, 'Robot').statuscode, 400);
	assert.equal(pruefeUebergang(S.NEU, S.IN_PRUEFUNG, 'System:x').statuscode, 400);
	assert.equal(pruefeUebergang(S.NEU, S.IN_PRUEFUNG, '').statuscode, 400);
	assert.equal(pruefeUebergang(S.NEU, 'Erledigt', 'System').code, 'UNBEKANNTER_STATUS');
	assert.equal(pruefeUebergang('Irgendwas', S.NEU, 'System').code, 'UNBEKANNTER_STATUS');
	assert.equal(ausloeserTyp(MA), 'Mitarbeiter');
});

test('erlaubteFolgestatus', () => {
	assert.deepEqual(erlaubteFolgestatus(S.IN_PRUEFUNG, 'System'), [S.BEREIT, S.LUECKEN, S.ESKALIERT]);
	assert.deepEqual(erlaubteFolgestatus(S.ABGESCHLOSSEN, MA), []);
});

test('Matrix enthält keine doppelten Regeln', () => {
	const keys = UEBERGAENGE.map(([a, b]) => `${a}>${b}`);
	assert.equal(new Set(keys).size, keys.length);
});
