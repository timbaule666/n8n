'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dt = require('../src/datenTabellen');
const { validiereConfig } = require('../src/configValidator');

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'datatables', 'schema.json'), 'utf8')).tabellen;

test('Spaltenlisten passen zum Tabellenschema', () => {
	for (const [tabelle, spalten] of Object.entries(dt.SPALTEN)) {
		assert.deepEqual([...spalten].sort(), Object.keys(SCHEMA[tabelle]).sort(), tabelle);
	}
	for (const [tabelle, spalten] of Object.entries(dt.JSON_SPALTEN)) {
		for (const s of Object.keys(spalten)) assert.equal(SCHEMA[tabelle][s], 'string', `${tabelle}.${s} muss Text sein`);
	}
});

test('zeileLesen parst JSON-Spalten und erkennt leere Items', () => {
	assert.equal(dt.zeileLesen({}, 'epa_vorgaenge'), null);
	assert.equal(dt.zeileLesen(null, 'epa_vorgaenge'), null);
	const v = dt.zeileLesen({ id: 3, bekannte_message_ids: '["<a>"]', extrahierte_daten: '{"x":1}', fehlende_felder: null, konflikte: 'kaputt' }, 'epa_vorgaenge');
	assert.deepEqual(v.bekannte_message_ids, ['<a>']);
	assert.deepEqual(v.extrahierte_daten, { x: 1 });
	assert.deepEqual(v.fehlende_felder, []);
	assert.deepEqual(v.konflikte, []);
});

test('zeileSchreiben serialisiert JSON, lehnt unbekannte Spalten ab, lässt undefined weg', () => {
	const z = dt.zeileSchreiben({ status: 'Neu', konflikte: [{ feld: 'a' }], betreff: undefined, bearbeiter: null }, 'epa_vorgaenge');
	assert.deepEqual(z, { status: 'Neu', konflikte: '[{"feld":"a"}]', bearbeiter: null });
	assert.throws(() => dt.zeileSchreiben({ id: 1 }, 'epa_vorgaenge'), /Spalte "id"/);
	assert.throws(() => dt.zeileSchreiben({ status: 'x' }, 'gibtsnicht'), /Unbekannte Tabelle/);
});

test('Vorgangs-ID aus Zeilen-ID', () => {
	assert.equal(dt.vorgangsIdAusZeile(7, 2026), 'V-2026-0007');
	assert.equal(dt.vorgangsIdAusZeile(12345, 2026), 'V-2026-12345');
	assert.throws(() => dt.vorgangsIdAusZeile(0, 2026));
	assert.throws(() => dt.vorgangsIdAusZeile('x', 2026));
});

test('neuerVorgang setzt Startwerte und Löschfrist', () => {
	const z = dt.neuerVorgang('k', { erste_message_id: '<m1>', absender_adresse: 'Max@Kunde.DE' }, { aufbewahrungTage: 10, jetzt: '2026-10-13T10:00:00Z', platzhalterId: 'NEU-1' });
	assert.equal(z.status, 'Neu');
	assert.equal(z.version, 1);
	assert.equal(z.absender_adresse, 'max@kunde.de');
	assert.equal(z.bekannte_message_ids, '["<m1>"]');
	assert.equal(z.loeschen_ab, '2026-10-23T10:00:00.000Z');
	assert.equal(dt.neuerVorgang('k', {}, { aufbewahrungTage: 1, jetzt: '2026-10-13T10:00:00Z', platzhalterId: 'p' }).bekannte_message_ids, '[]');
});

test('aktualisierungBerechnen: nur übergebene Felder, Message-IDs ohne Duplikate, Version +1', () => {
	const v = { version: 4, bekannte_message_ids: ['<a>', '<b>'] };
	const p = dt.aktualisierungBerechnen(v, { neue_message_ids: ['<b>', '<c>'], rundenzaehler: 2, antwort_frist: null });
	assert.deepEqual(p, { bekannte_message_ids: '["<a>","<b>","<c>"]', rundenzaehler: 2, antwort_frist: null, version: 5 });
	assert.throws(() => dt.aktualisierungBerechnen(v, { status: 'Abgeschlossen' }), /nicht änderbar/);
});

test('kandidatenFiltern: Kriterien, nur offene Vorgänge, starke Hinweise und neueste zuerst', () => {
	const z = (id, extra) => ({ id, vorgangs_id: `V-2026-000${id}`, status: 'In Prüfung', bekannte_message_ids: '[]', updatedAt: `2026-10-1${id}T00:00:00Z`, ...extra });
	const zeilen = [
		z(1, { bekannte_message_ids: '["<m1>"]' }),
		z(2, { conversation_id: 'c2' }),
		z(3, { absender_adresse: 'max@kunde.de' }),
		z(4, { betreff_normalisiert: 'anfrage' }),
		z(5, { conversation_id: 'c2', status: 'Abgeschlossen' }),
		{},
	];
	const ids = (k) => dt.kandidatenFiltern(zeilen, k).map((x) => x.vorgangs_id);
	assert.deepEqual(ids({ message_ids: ['<m1>'] }), ['V-2026-0001']);
	assert.deepEqual(ids({ conversation_id: 'c2' }), ['V-2026-0002']);
	assert.deepEqual(ids({ absender_adresse: 'MAX@kunde.de' }), ['V-2026-0003']);
	assert.deepEqual(ids({ betreff_normalisiert: 'anfrage' }), ['V-2026-0004']);
	assert.deepEqual(ids({ vorgangs_ids: ['V-2026-0001', 'V-2026-0005'] }), ['V-2026-0001']);
	assert.deepEqual(ids({ conversation_id: 'c2', absender_adresse: 'max@kunde.de' }), ['V-2026-0002', 'V-2026-0003'], 'starke Hinweise (Konversation) vor Absender');
	assert.deepEqual(ids({}), []);
});

test('sperreEntscheiden', () => {
	const jetzt = '2026-10-13T10:00:00Z';
	assert.equal(dt.sperreEntscheiden({}, 'A', 60, jetzt).moeglich, true);
	assert.equal(dt.sperreEntscheiden({ lock_durch: 'B', lock_bis: '2026-10-13T10:05:00Z' }, 'A', 60, jetzt).moeglich, false);
	assert.equal(dt.sperreEntscheiden({ lock_durch: 'B', lock_bis: '2026-10-13T09:59:00Z' }, 'A', 60, jetzt).moeglich, true);
	assert.equal(dt.sperreEntscheiden({ lock_durch: 'A', lock_bis: '2026-10-13T10:05:00Z' }, 'A', 60, jetzt).moeglich, true);
	const s = dt.sperreEntscheiden({ lock_durch: 'B', lock_bis: '2026-10-13T09:00:00Z' }, 'A', 60, jetzt);
	assert.equal(s.vorher_durch, 'B');
	assert.deepEqual(s.neu, { lock_durch: 'A', lock_bis: '2026-10-13T10:01:00.000Z' });
});

test('Beispiel-Config für Data Tables: Schema-Spalten, Platzhalter abgelehnt, ersetzt gültig', () => {
	const beispiel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
	for (const [tabelle, zeilen] of Object.entries(beispiel)) {
		for (const z of zeilen) assert.deepEqual(Object.keys(z).sort(), Object.keys(SCHEMA[tabelle]).sort(), tabelle);
	}
	const allg = beispiel.epa_config_allgemein[0];
	assert.equal(validiereConfig(allg, beispiel.epa_config_pflichtfelder).gueltig, false);
	const ok = validiereConfig({ ...allg, postfach: 'anfragen@beispiel.de', freigeber: '["dispo@beispiel.de"]' }, beispiel.epa_config_pflichtfelder);
	assert.equal(ok.gueltig, true, ok.fehler.join('\n'));
	assert.equal(ok.config.vorgangstypen.transport.length, 10);
});

test('kandidatenFiltern: genannter Vorgang bleibt Kandidat, auch bei mehr als 20 offenen Vorgängen des Absenders (Live-Test T04b)', () => {
	const zeilen = Array.from({ length: 30 }, (_, i) => ({
		id: i + 1, vorgangs_id: `V-2026-${String(i + 1).padStart(4, '0')}`, status: 'Bereit zur Bearbeitung', absender_adresse: 'kunde@x.example',
		bekannte_message_ids: '[]', updatedAt: `2026-10-15T09:${String(i).padStart(2, '0')}:00Z`,
	}));
	const k = dt.kandidatenFiltern(zeilen, { absender_adresse: 'kunde@x.example', vorgangs_ids: ['V-2026-0001'] });
	assert.equal(k.length, 20);
	assert.equal(k[0].vorgangs_id, 'V-2026-0001', 'starker Hinweis zuerst');
	assert.equal(k[1].vorgangs_id, 'V-2026-0030', 'danach die neuesten');
	const ohne = dt.kandidatenFiltern(zeilen, { absender_adresse: 'kunde@x.example' });
	assert.equal(ohne.length, 20);
	assert.ok(!ohne.some((x) => x.vorgangs_id === 'V-2026-0001'));
});
