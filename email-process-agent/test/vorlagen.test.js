'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ALLGEMEIN, PFLICHTFELD, csv } = require('../tools/vorlagen');
const { validiereConfig } = require('../src/configValidator');

test('Leere Vorlage: wird mit Platzhaltern abgelehnt, ausgefüllt ist sie gültig', () => {
	const leer = validiereConfig(ALLGEMEIN, [PFLICHTFELD]);
	assert.equal(leer.gueltig, false);
	const a = {
		...ALLGEMEIN, aktiv: true, kunde_id: 'mueller-logistik', postfach: 'anfragen@mueller.example', signatur: 'Mit freundlichen Grüßen\nTeam Müller',
		feiertage_region: 'BY', benachrichtigung: JSON.stringify({ kanal: 'teams', team_id: '61165b04-e4cc-4026-b43f-926b4e2a7182', channel_id: '19:abc@thread.tacv2' }),
		freigeber: '["chef@mueller.example"]', postfach_workflow_id: 'AbCdEf123456',
	};
	const f = { ...PFLICHTFELD, kunde_id: 'mueller-logistik', vorgangstyp: 'transport', feldname: 'Start_PLZ', anzeigename: 'PLZ Abholort', typ: 'plz', resolution_textbaustein: 'Bitte nennen Sie uns die Postleitzahl des Abholorts.', extraktions_hinweis: 'PLZ des Abholorts' };
	const r = validiereConfig(a, [f]);
	assert.deepEqual(r.fehler, []);
	assert.equal(r.gueltig, true);
});

test('CSV: Werte mit Komma, Anführungszeichen und Zeilenumbruch werden korrekt maskiert', () => {
	const t = csv('epa_config_pflichtfelder', [{ ...PFLICHTFELD, anzeigename: 'A, "B"\nC' }]);
	assert.match(t, /"A, ""B""\nC"/);
	assert.equal(t.split('\n')[0].split(',').length, 12);
});
