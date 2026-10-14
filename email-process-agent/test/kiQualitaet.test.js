'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const q = require('../src/kiQualitaet');
const pf = require('../src/pflichtfelder');
const mn = require('../src/mailNormalisieren');
const { validiereConfig } = require('../src/configValidator');

const beispiel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
const CONFIG = validiereConfig({ ...beispiel.epa_config_allgemein[0], postfach: 'a@b.de', freigeber: '["c@b.de"]' }, beispiel.epa_config_pflichtfelder).config;
const FELDER = CONFIG.vorgangstypen.transport;
const HEUTE = '2026-10-14';
const FAELLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'testphase', 'ki-testfaelle.json'), 'utf8')).faelle;
const ex = (w) => Object.fromEntries(Object.entries(w).map(([k, v]) => [k, { wert: v, quelle: 'Mailtext', konfidenz: 0.9 }]));

test('Testfälle: Sollwerte sind gültig, Felder existieren, Mails lassen sich normalisieren', () => {
	assert.ok(FAELLE.length >= 15);
	assert.equal(new Set(FAELLE.map((f) => f.fall_id)).size, FAELLE.length);
	for (const f of FAELLE) {
		assert.ok(['anfrage', 'keine_anfrage', 'unklar'].includes(f.erwartete_klasse), f.fall_id);
		for (const [k, v] of Object.entries(f.erwartete_felder)) {
			const d = FELDER.find((x) => x.feldname === k);
			assert.ok(d, `${f.fall_id}: Feld ${k} unbekannt`);
			if (v !== null) assert.equal(pf.feldPruefen(d, v, { heute: HEUTE }).ok, true, `${f.fall_id}.${k}=${v}`);
		}
		const m = mn.normalisieren(q.testMail(f), CONFIG, []);
		assert.equal(mn.vorpruefung(m), null, `${f.fall_id}: Vorprüfung darf nicht vorher aussortieren`);
		assert.ok(m.text.length > 10);
	}
});

test('Vergleich: richtig, richtig leer, falsch, fehlend, zu viel; Klasse', () => {
	const fall = { fall_id: 'X', erwartete_klasse: 'anfrage', erwartete_felder: JSON.stringify({ Start_PLZ: '50667', Ziel_PLZ: null, Telefon: '0221 1234567', Gewicht_kg: '1200', Ansprechpartner: 'Jana Beispiel', Ziel_Ort: null, Start_Ort: 'Köln' }) };
	const pruefung = pf.pruefen(ex({ Start_PLZ: '50667', Ziel_PLZ: null, Telefon: '0221/123 45 67', Gewicht_kg: '1100', Ansprechpartner: 'Frau  jana beispiel', Ziel_Ort: 'Leipzig' }), FELDER, { heute: HEUTE });
	const r = q.vergleichen({ fall, klasse: { weg: 'pruefen' }, pruefung, felder: FELDER, feldPruefen: pf.feldPruefen, heute: HEUTE });
	const art = Object.fromEntries(r.felder.map((f) => [f.feldname, f.art]));
	assert.deepEqual(art, { Start_PLZ: 'richtig', Start_Ort: 'fehlend', Ziel_PLZ: 'richtig_leer', Ziel_Ort: 'zuviel', Gewicht_kg: 'falsch', Ansprechpartner: 'richtig', Telefon: 'richtig' });
	assert.equal(r.klasse_ok, true);
	const nein = q.vergleichen({ fall: { fall_id: 'Y', erwartete_klasse: 'keine_anfrage', erwartete_felder: '{}' }, klasse: { weg: 'pruefen' }, pruefung: null, felder: FELDER, feldPruefen: pf.feldPruefen, heute: HEUTE });
	assert.equal(nein.klasse_ok, false);
	assert.equal(nein.klasse_ist, 'anfrage');
	assert.equal(q.vergleichen({ fall: { fall_id: 'Z', erwartete_klasse: 'unklar' }, klasse: null, pruefung: null, felder: FELDER, feldPruefen: pf.feldPruefen }).klasse_ist, 'fehler');
});

test('Zusammenfassung und Bericht', () => {
	const e = [
		{ fall_id: 'A', klasse_soll: 'anfrage', klasse_ist: 'anfrage', klasse_ok: true, felder: [{ feldname: 'Telefon', art: 'richtig' }, { feldname: 'Gewicht_kg', art: 'fehlend' }] },
		{ fall_id: 'B', klasse_soll: 'keine_anfrage', klasse_ist: 'anfrage', klasse_ok: false, felder: [] },
		{ fall_id: 'C', klasse_soll: 'anfrage', klasse_ist: 'anfrage', klasse_ok: true, felder: [{ feldname: 'Telefon', art: 'falsch' }, { feldname: 'Gewicht_kg', art: 'richtig' }] },
	];
	const z = q.zusammenfassen(e);
	assert.equal(z.klassifizierung.trefferquote, 66.7);
	assert.deepEqual(z.klassifizierung.falsch, ['B: keine_anfrage → anfrage']);
	assert.deepEqual(z.felder.map((f) => [f.feldname, f.trefferquote]), [['Gewicht_kg', 50], ['Telefon', 50]]);
	const b = q.bericht(z, { lauf: 'L1', modell: 'm', prompt_version: 'v1' });
	assert.match(b, /Klassifizierung: 2\/3 richtig \(66.7 %\)/);
	assert.match(b, /\| Telefon \| 2 \| 1 \| 0 \| 1 \| 0 \| 0 \| 50 % \|/);
});
