'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const imp = require('../src/testfaelleImport');
const pf = require('../src/pflichtfelder');
const q = require('../src/kiQualitaet');
const { vorlageInhalt } = require('../tools/testfaelle-import');

const beispiel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
const FELDER = imp.felderAusConfig(beispiel.epa_config_pflichtfelder, 'beispiel-transport');
const OPT = { feldPruefen: pf.feldPruefen, heute: '2026-10-14' };
const KOPF = imp.vorlageSpalten(FELDER).join(';');
const pruefen = (csv, opt = {}) => imp.zeilenPruefen(imp.csvLesen(csv), FELDER, { ...OPT, ...opt });

test('CSV: Semikolon und Komma, Anführungszeichen, Zeilenumbruch in Zellen, BOM, leere Zeilen', () => {
	const a = imp.csvLesen('﻿a;b;c\r\n1;"x; ""y""\nz";3\r\n\r\n');
	assert.equal(a.trenn, ';');
	assert.deepEqual(a.spalten, ['a', 'b', 'c']);
	assert.deepEqual(a.daten, [{ _zeile: 2, a: '1', b: 'x; "y"\nz', c: '3' }]);
	assert.deepEqual(imp.csvLesen('a,b\n1,2').daten, [{ _zeile: 2, a: '1', b: '2' }]);
	assert.throws(() => imp.csvLesen('a;b\n"offen;2'), /nicht geschlossen/);
});

test('Felder aus der Config: Reihenfolge, nur aktive, Regeln als Objekt', () => {
	assert.equal(FELDER.length, 10);
	assert.equal(FELDER[0].feldname, 'Start_PLZ');
	assert.deepEqual(FELDER.find((f) => f.feldname === 'Ansprechpartner').validierungsregel, { min_laenge: 2, max_laenge: 80, person: true });
	assert.equal(imp.felderAusConfig([{ kunde_id: 'x', feldname: 'A', typ: 'text', aktiv: false }], 'x').length, 0);
});

test('Die mitgelieferte Vorlage ist aktuell und besteht die Prüfung ohne Fehler', () => {
	const datei = fs.readFileSync(path.join(__dirname, '..', 'config', 'testphase', 'vorlage-ki-testfaelle.csv'), 'utf8');
	assert.equal(datei, vorlageInhalt(FELDER), 'Vorlage neu erzeugen: node tools/testfaelle-import.js --vorlage --config=config/datatables/beispiel-transport.json');
	const r = imp.zeilenPruefen(imp.csvLesen(datei), FELDER, OPT);
	assert.deepEqual(r.fehler, []);
	assert.equal(r.faelle.length, 3);
	const [a, b, c] = r.faelle;
	assert.equal(a.erwartete_klasse, 'anfrage');
	assert.equal(JSON.parse(a.erwartete_felder).Telefon, '0221 9876543');
	assert.equal(JSON.parse(b.erwartete_felder).Start_PLZ, null, '"-" = steht nicht in der Mail');
	assert.equal('Packstuecke' in JSON.parse(b.erwartete_felder), false, 'leere Zelle = nicht bewertet');
	assert.equal(c.erwartete_felder, '{}');
	assert.equal(a.aktiv, true);
	// Der Prüfstand liest die Sollwerte genauso wie die synthetischen Fälle.
	assert.equal(q.sollFelder(b).Gewicht_kg, '2000');
});

test('Hinweise auf echte Daten führen zum Abbruch', () => {
	const r = pruefen(`${KOPF}\nR-1;Betreff;max@firma.de;Max;anfrage;"Bitte an hans.meier@spedition-echt.de, IBAN DE89 3704 0044 0532 0130 00, Kopie an a@kunde.example"`);
	assert.equal(r.faelle.length, 0);
	assert.ok(r.fehler.some((f) => /absender "max@firma.de" ist keine Test-Adresse/.test(f)));
	assert.ok(r.fehler.some((f) => /hans.meier@spedition-echt.de/.test(f)));
	assert.ok(!r.fehler.some((f) => /a@kunde.example/.test(f)), 'Test-Domains sind erlaubt');
	assert.ok(r.fehler.some((f) => /IBAN/.test(f)));
	for (const d of ['x.example', 'kunde.test', 'example.com', 'a.b.invalid']) assert.ok(imp.TEST_DOMAIN.test(d), d);
	for (const d of ['example.de', 'firma.de', 'test.com']) assert.ok(!imp.TEST_DOMAIN.test(d), d);
});

test('Formfehler: Spalten, fall_id, Klasse, doppelte und schon vorhandene Fälle', () => {
	assert.match(pruefen('fall_id;text\nR-1;x').fehler.join('|'), /Spalte "betreff" fehlt/);
	assert.match(pruefen(`${KOPF};soll_Gewicht\n`).fehler.join('|'), /Spalte "soll_Gewicht" ist unbekannt/);
	const r = pruefen(`${KOPF}\nR 1;b;a@x.example;;anfrage;t\nR-2;b;a@x.example;;vielleicht;t\nR-3;b;a@x.example;;anfrage;\nR-4;b;a@x.example;;Keine Anfrage;t\nR-4;b;a@x.example;;anfrage;t\nR-5;b;a@x.example;;anfrage;t`, { vorhandeneIds: ['R-5'] });
	const t = r.fehler.join('|');
	assert.match(t, /Zeile 2 \(R 1\): fall_id .* ungültige Zeichen/);
	assert.match(t, /Zeile 3 \(R-2\): erwartete_klasse muss/);
	assert.match(t, /Zeile 4 \(R-3\): text fehlt/);
	assert.match(t, /Zeile 6 \(R-4\): fall_id "R-4" gibt es schon/);
	assert.match(t, /Zeile 7 \(R-5\): fall_id "R-5" gibt es schon/);
	assert.deepEqual(r.faelle.map((f) => [f.fall_id, f.erwartete_klasse]), [['R-4', 'keine_anfrage']]);
	assert.match(pruefen(KOPF).fehler.join('|'), /keine Testfälle/);
});

test('Hinweise: ungültiger Sollwert, Sollwerte bei Nicht-Anfrage, fall_id S…', () => {
	const sp = imp.vorlageSpalten(FELDER);
	const zeile = (werte) => sp.map((s) => werte[s] ?? '').join(';');
	const csv = [sp.join(';'),
		zeile({ fall_id: 'R-1', betreff: 'b', absender: 'a@x.example', erwartete_klasse: 'anfrage', text: 't', soll_Start_PLZ: '123' }),
		zeile({ fall_id: 'S99', betreff: 'b', absender: 'a@x.example', erwartete_klasse: 'keine_anfrage', text: 't', soll_Telefon: '0221 1234567' }),
	].join('\n');
	const r = pruefen(csv);
	assert.deepEqual(r.fehler, []);
	const w = r.warnungen.join('|');
	assert.match(w, /Sollwert Start_PLZ "123" besteht die Feldprüfung nicht/);
	assert.match(w, /S99.*synthetischen/);
	assert.match(w, /nur bei erwartete_klasse = anfrage/);
});
