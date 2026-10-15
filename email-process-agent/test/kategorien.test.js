'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const k = require('../src/kategorien');
const { ALLE_STATUS } = require('../src/statusMatrix');
const { validiereConfig } = require('../src/configValidator');

const KAT = {
	'Bereit zur Bearbeitung': { name: 'AI Geprüft', farbe: 'preset4' },
	'Freigabe ausstehend': { name: 'AI Rückfragen', farbe: 'preset0' },
	'Warten auf Kunde': { name: 'AI Rückfragen', farbe: 'preset0' },
};

test('Plan je Status: setzen, entfernen oder nichts', () => {
	assert.deepEqual(k.plan(KAT, 'Bereit zur Bearbeitung'), { aktion: 'setzen', name: 'AI Geprüft', farbe: 'preset4', system_namen: ['AI Geprüft', 'AI Rückfragen'] });
	assert.equal(k.plan(KAT, 'Warten auf Kunde').name, 'AI Rückfragen');
	assert.equal(k.plan(KAT, 'In Prüfung').aktion, null, 'Zwischenstand ändert nichts');
	assert.equal(k.plan(KAT, 'Abgeschlossen').aktion, 'entfernen');
	assert.equal(k.plan({}, 'Bereit zur Bearbeitung').aktion, null, 'ohne Config aus');
	for (const s of Object.keys(KAT)) assert.ok(ALLE_STATUS.includes(s), s);
});

test('Neue Kategorien: fremde bleiben, eigene werden ersetzt', () => {
	const p = k.plan(KAT, 'Bereit zur Bearbeitung');
	assert.deepEqual(k.neueKategorien(['AI Rückfragen', 'Privat'], p), ['Privat', 'AI Geprüft']);
	assert.equal(k.neueKategorien(['AI Geprüft'], p), null, 'schon richtig: nichts tun');
	assert.deepEqual(k.neueKategorien(undefined, p), ['AI Geprüft']);
	assert.deepEqual(k.neueKategorien(['AI Geprüft', 'Kunde X'], k.plan(KAT, 'Abgeschlossen')), ['Kunde X']);
	assert.equal(k.neueKategorien(['Kunde X'], k.plan(KAT, 'Abgeschlossen')), null);
});

test('Message-IDs eines Vorgangs', () => {
	assert.deepEqual(k.messageIds({ erste_message_id: '<a>', bekannte_message_ids: '["<a>","<b>"]' }), ['<a>', '<b>']);
	assert.deepEqual(k.messageIds({ bekannte_message_ids: 'kaputt' }), []);
	assert.deepEqual(k.messageIds(null), []);
});

test('Config: outlook_kategorien optional und geprüft', () => {
	const fs = require('node:fs');
	const path = require('node:path');
	const b = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
	const basis = { ...b.epa_config_allgemein[0], postfach: 'a@b.de', freigeber: '["c@b.de"]' };
	const pf = b.epa_config_pflichtfelder;
	assert.deepEqual(validiereConfig({ ...basis, outlook_kategorien: '' }, pf).config.outlook_kategorien, {});
	assert.deepEqual(validiereConfig({ ...basis, outlook_kategorien: JSON.stringify(KAT) }, pf).config.outlook_kategorien, KAT);
	const f = (x) => validiereConfig({ ...basis, outlook_kategorien: JSON.stringify(x) }, pf).fehler.join('|');
	assert.match(f({ 'Warten auf Kunde': { name: '', farbe: 'preset0' } }), /outlook_kategorien\.Warten auf Kunde\.name/);
	assert.match(f({ 'Warten auf Kunde': { name: 'A,B' } }), /ohne Komma/);
	assert.match(f({ 'Warten auf Kunde': { name: 'AI', farbe: 'rot' } }), /preset0 bis preset24/);
	assert.match(f([1]), /muss ein Objekt/);
	const fehler = [];
	assert.deepEqual(k.configPruefen({ Unsinn: { name: 'X' } }, fehler, ALLE_STATUS), {});
	assert.match(fehler[0], /Status ist unbekannt/);
});
