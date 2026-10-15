'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pf = require('../src/pflichtfelder');
const { validiereConfig } = require('../src/configValidator');

const beispiel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'datatables', 'beispiel-transport.json'), 'utf8'));
const FELDER = validiereConfig({ ...beispiel.epa_config_allgemein[0], postfach: 'a@b.de', freigeber: '["c@b.de"]' }, beispiel.epa_config_pflichtfelder).config.vorgangstypen.transport;
const feld = (name) => FELDER.find((f) => f.feldname === name);
const HEUTE = '2026-10-13';

const ex = (werte) => Object.fromEntries(Object.entries(werte).map(([k, v]) => [k, { wert: v, quelle: 'Mailtext', konfidenz: 0.9 }]));
const VOLL = {
	Start_PLZ: '20095', Start_Ort: 'Hamburg', Ziel_PLZ: '80331', Ziel_Ort: 'München', Abholdatum: '20.10.2026',
	Gewicht_kg: '1.200', Packstuecke: '4', Ladungsart: 'palette', Ansprechpartner: 'Max Muster', Telefon: '+49 40 123456',
};

test('Vollständige Anfrage: normalisierte Werte', () => {
	const r = pf.pruefen(ex(VOLL), FELDER, { heute: HEUTE });
	assert.equal(r.vollstaendig, true, JSON.stringify(r.fehlende));
	assert.deepEqual(pf.werte(r.daten), {
		Start_PLZ: '20095', Start_Ort: 'Hamburg', Ziel_PLZ: '80331', Ziel_Ort: 'München', Abholdatum: '2026-10-20',
		Gewicht_kg: 1200, Packstuecke: 4, Ladungsart: 'Palette', Ansprechpartner: 'Max Muster', Telefon: '+4940123456',
	});
});

test('null, leer, fehlend und Platzhalter gelten als fehlend', () => {
	const r = pf.pruefen(ex({ ...VOLL, Start_PLZ: null, Ziel_PLZ: '  ', Telefon: 'k.A.', Ansprechpartner: 'TBD', Gewicht_kg: '-', Abholdatum: undefined }), FELDER, { heute: HEUTE });
	assert.equal(r.vollstaendig, false);
	assert.deepEqual(r.fehlende.map((f) => [f.feldname, f.grund]), [
		['Start_PLZ', 'fehlt'], ['Ziel_PLZ', 'fehlt'], ['Abholdatum', 'fehlt'], ['Gewicht_kg', 'Platzhalter statt Angabe'],
		['Ansprechpartner', 'Platzhalter statt Angabe'], ['Telefon', 'Platzhalter statt Angabe'],
	]);
	assert.equal(r.fehlende[0].anzeigename, 'PLZ Abholort');
	// Feld fehlt komplett in der LLM-Ausgabe
	assert.equal(pf.pruefen({}, FELDER, { heute: HEUTE }).fehlende.length, FELDER.filter((f) => f.pflicht).length);
});

test('Optionale Felder: fehlend ist ok, ungültig ist ein Hinweis', () => {
	const r = pf.pruefen(ex({ ...VOLL, Packstuecke: null, Ladungsart: 'Container' }), FELDER, { heute: HEUTE });
	assert.equal(r.vollstaendig, true);
	assert.deepEqual(r.hinweise.map((h) => h.feldname), ['Ladungsart']);
	assert.equal(r.daten.Ladungsart.wert, null);
	assert.equal(r.daten.Ladungsart.roh, 'Container');
});

test('PLZ', () => {
	const p = (w) => pf.feldPruefen(feld('Start_PLZ'), w);
	assert.deepEqual(p('D-20095'), { ok: true, wert: '20095' });
	assert.deepEqual(p(20095), { ok: true, wert: '20095' });
	assert.equal(p('2009').ok, false);
	assert.equal(p('200951').ok, false);
	assert.equal(p('Hamburg').ok, false);
});

test('Datum: Formate, ungültige Tage, Grenzen relativ zu heute, ohne Jahr', () => {
	const d = (w) => pf.feldPruefen(feld('Abholdatum'), w, { heute: HEUTE });
	assert.deepEqual(d('2026-10-20'), { ok: true, wert: '2026-10-20' });
	assert.deepEqual(d('1.11.26'), { ok: true, wert: '2026-11-01' });
	assert.deepEqual(d('20.10.'), { ok: true, wert: '2026-10-20' });
	assert.deepEqual(d('05.01.'), { ok: true, wert: '2027-01-05' });
	assert.deepEqual(d('13.10.'), { ok: true, wert: '2026-10-13' });
	assert.equal(d('31.02.2027').ok, false);
	assert.equal(d('nächsten Dienstag').ok, false);
	assert.match(d('01.10.2026').grund, /zu früh/);
	assert.match(d('01.01.2028').grund, /zu weit/);
});

test('Zahl: deutsche/englische Formate, Einheiten, Grenzen, Ganzzahl', () => {
	assert.equal(pf.zahlLesen('1.200'), 1200);
	assert.equal(pf.zahlLesen('1.200,5'), 1200.5);
	assert.equal(pf.zahlLesen('1,200.5'), 1200.5);
	assert.equal(pf.zahlLesen('2,5'), 2.5);
	assert.equal(pf.zahlLesen('ca. 800 kg'), 800);
	assert.equal(pf.zahlLesen('12 Paletten'), 12);
	assert.equal(pf.zahlLesen('1.5'), 1.5);
	assert.equal(pf.zahlLesen('viel'), null);
	assert.equal(pf.zahlLesen('1-2'), null);
	assert.match(pf.feldPruefen(feld('Gewicht_kg'), '50000').grund, /größer/);
	assert.match(pf.feldPruefen(feld('Gewicht_kg'), '0').grund, /kleiner/);
	assert.match(pf.feldPruefen(feld('Packstuecke'), '2,5').grund, /ganze Zahl/);
});

test('Telefon, E-Mail, Text, Enum', () => {
	assert.deepEqual(pf.feldPruefen(feld('Telefon'), '040 / 123-456'), { ok: true, wert: '040123456' });
	assert.equal(pf.feldPruefen(feld('Telefon'), '12345').ok, false);
	assert.equal(pf.feldPruefen(feld('Telefon'), 'ruf mich an').ok, false);
	assert.deepEqual(pf.feldPruefen({ typ: 'email', validierungsregel: {} }, 'mailto:Max@Kunde.de'), { ok: true, wert: 'max@kunde.de' });
	assert.equal(pf.feldPruefen({ typ: 'email', validierungsregel: {} }, 'max@').ok, false);
	assert.match(pf.feldPruefen(feld('Start_Ort'), 'H').grund, /zu kurz/);
	assert.deepEqual(pf.feldPruefen(feld('Start_Ort'), '  Bad   Oldesloe '), { ok: true, wert: 'Bad Oldesloe' });
	assert.deepEqual(pf.feldPruefen(feld('Ladungsart'), 'STÜCKGUT'), { ok: true, wert: 'Stückgut' });
});

test('Enum: Mehrzahl und Beugung nur bei eindeutigem Treffer', () => {
	const l = (w) => pf.feldPruefen(feld('Ladungsart'), w);
	assert.deepEqual(l('Paletten'), { ok: true, wert: 'Palette' });
	assert.deepEqual(l('Pakete'), { ok: true, wert: 'Paket' });
	assert.deepEqual(l('PALETTE'), { ok: true, wert: 'Palette' });
	assert.deepEqual(l('  paletten '), { ok: true, wert: 'Palette' });
	assert.equal(l('Container').ok, false);
	assert.equal(l('Pal').ok, false);
	const mehrdeutig = { typ: 'enum', validierungsregel: { werte: ['Kiste', 'Kisten'] } };
	assert.deepEqual(pf.feldPruefen(mehrdeutig, 'kisten'), { ok: true, wert: 'Kisten' });
	const doppelt = { typ: 'enum', validierungsregel: { werte: ['Rolle', 'Roll'] } };
	assert.equal(pf.feldPruefen(doppelt, 'Rollen').ok, false, 'zwei mögliche Grundformen: nicht raten');
});

test('Feldspezifische Platzhalter und geringe Konfidenz', () => {
	const f = [{ ...feld('Start_Ort'), platzhalter_muster: ['Musterstadt'] }];
	assert.equal(pf.pruefen(ex({ Start_Ort: 'musterstadt' }), f).fehlende[0].grund, 'Platzhalter statt Angabe');
	const r = pf.pruefen({ Start_Ort: { wert: 'Hamburg', quelle: 'Mailtext', konfidenz: 0.3 } }, f);
	assert.equal(r.vollstaendig, true);
	assert.deepEqual(r.unsicher, [{ feldname: 'Start_Ort', anzeigename: 'Abholort', konfidenz: 0.3 }]);
});

test('Objekt statt Wert wird abgelehnt', () => {
	const r = pf.pruefen({ Start_Ort: { wert: { a: 1 } } }, [feld('Start_Ort')]);
	assert.match(r.fehlende[0].grund, /unerwartetes Format/);
});

test('Text mit Regel person: Anrede weg, Team-, Abteilungs- und Firmennamen gelten als fehlend', () => {
	const a = (w) => pf.feldPruefen(feld('Ansprechpartner'), w);
	assert.deepEqual(a('Frau Lisa Probe'), { ok: true, wert: 'Lisa Probe' });
	assert.deepEqual(a('Herrn Dr. Max Muster'), { ok: true, wert: 'Dr. Max Muster' });
	assert.deepEqual(a('Pieter Example'), { ok: true, wert: 'Pieter Example' });
	for (const ok of ['Anna Teamer', 'Agnes Kogler', 'Müller-Lüdenscheidt']) assert.equal(a(ok).ok, true, ok);
	for (const nein of ['Team Kaffee Beispiel', 'Ihr Dispositionsteam', 'Vertriebsteam Nord', 'Logistik-Team', 'Einkauf', 'Beispiel Transport GmbH', 'Kaffee & Co. KG']) {
		assert.match(a(nein).grund || '', /kein Personenname/, nein);
	}
	// Pflichtfeld: ein Teamname führt zur Rückfrage statt zu einem erfundenen Ansprechpartner.
	const r = pf.pruefen(ex({ ...VOLL, Ansprechpartner: 'Team Kaffee Beispiel' }), FELDER, { heute: HEUTE });
	assert.equal(r.vollstaendig, false);
	assert.ok(r.fehlende.some((f) => f.feldname === 'Ansprechpartner'));
	// Ohne Regel bleibt Text unverändert.
	assert.deepEqual(pf.feldPruefen({ typ: 'text', validierungsregel: {} }, 'Team Nord'), { ok: true, wert: 'Team Nord' });
});

test('Datum ohne Jahr: von der KI ergänztes Jahr wird verworfen, wenn es nicht in der Mail steht', () => {
	const felder = [{ feldname: 'Abholdatum', anzeigename: 'Abholdatum', typ: 'datum', pflicht: true, validierungsregel: { min_tage_ab_heute: 0, max_tage_ab_heute: 365 } }];
	const opt = (quelltext) => ({ heute: '2026-10-15', quelltext });
	const p = (wert, text) => pf.pruefen({ Abholdatum: { wert, quelle: 'Mailtext', konfidenz: 0.9 } }, felder, opt(text)).daten.Abholdatum.wert;
	assert.equal(p('2023-11-03', 'könnt ihr am 3.11. in 04109 Leipzig 12 Pakete abholen?'), '2026-11-03');
	assert.equal(p('2023-11-03', 'Abholung am 03.11. bitte'), '2026-11-03');
	assert.equal(p('2026-03-02', 'Abholung am 2.3., danke'), '2027-03-02', 'nächstes Vorkommen ab heute');
	// Jahr steht in der Mail: Wert bleibt, wie er ist (und wird ggf. als Vergangenheit abgelehnt)
	assert.equal(p('2026-03-02', 'Abholung am 02.03.2026'), null);
	assert.equal(p('2026-11-03', 'am 3.11.26 bitte'), '2026-11-03');
	assert.equal(p('2023-11-03', 'am 3.11.23 bitte'), null, 'zweistelliges Jahr in der Mail');
	// Ohne Quelltext unverändert wie bisher
	assert.equal(pf.pruefen({ Abholdatum: { wert: '2023-11-03' } }, felder, { heute: '2026-10-15' }).daten.Abholdatum.wert, null);
	assert.equal(pf.jahrNichtImText('2023-11-03', 'Lieferung 13.11. und 3.11.'), '3.11.');
	assert.equal(pf.jahrNichtImText('2023-11-03', 'Lieferung 13.11.'), null, 'Tag 13 ist nicht Tag 3');
});

test('Ansprechpartner nur mit Vornamen: vollständiger Name aus dem Absendernamen, wenn er passt', () => {
	const felder = [{ feldname: 'Ansprechpartner', anzeigename: 'Ansprechpartner', typ: 'text', pflicht: true, validierungsregel: { min_laenge: 2, max_laenge: 80, person: true } }];
	const p = (wert, absenderName) => pf.pruefen({ Ansprechpartner: { wert, quelle: 'Mailtext', konfidenz: 0.9 } }, felder, { absenderName }).daten.Ansprechpartner.wert;
	assert.equal(p('Max', 'Max Müller'), 'Max Müller');
	assert.equal(p('Müller', 'Max Müller'), 'Max Müller');
	assert.equal(p('Herr Müller', 'Max Müller'), 'Max Müller');
	assert.equal(p('Max', 'Tim Baule'), 'Max', 'passt nicht: bleibt, wie genannt (keine Rückfrage wegen Nachname)');
	assert.equal(p('Max', 'Dispo-Team'), 'Max');
	assert.equal(p('Max', 'max@firma.example'), 'Max');
	assert.equal(p('Max', undefined), 'Max');
	assert.equal(p('Max Muster', 'Max Müller'), 'Max Muster', 'vollständige Angaben aus der Mail bleiben');
	assert.equal(pf.nameVervollstaendigen('Max', 'Einkauf GmbH'), null);
});
