'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const k = require('../src/kanaele');

const QUELLEN = path.join(__dirname, '..', 'workflows-src', 'datatable');

// Anlässe, die zur Laufzeit zusammengesetzt werden (p.weg, 'antwort_' + ergebnis, 'kalender_' + ergebnis, keine_anfrage_ + anlass).
const DYNAMISCH = [
	'bereit', 'luecken', 'manipulation', 'extraktion_fehlgeschlagen',
	'antwort_bereit', 'antwort_luecken', 'antwort_manipulation', 'antwort_keine_daten', 'antwort_storno', 'antwort_zusatzinfo',
	'kalender_frei', 'kalender_belegt', 'kalender_keine_freie_zeit', 'kalender_kalender_fehler',
	'keine_anfrage_storno', 'keine_anfrage_rueckruf', 'keine_anfrage_status', 'keine_anfrage_anhang', 'keine_anfrage_reklamation',
];

function literaleAnlaesse() {
	const gefunden = new Set();
	const dateien = fs.readdirSync(QUELLEN).filter((f) => f.endsWith('.js')).map((f) => path.join(QUELLEN, f))
		.concat(fs.readdirSync(path.join(QUELLEN, 'code')).map((f) => path.join(QUELLEN, 'code', f)));
	for (const d of dateien) {
		const s = fs.readFileSync(d, 'utf8');
		for (const m of s.matchAll(/\['anlass', 'string', '([a-z_]+)'\]/g)) gefunden.add(m[1]);
		for (const m of s.matchAll(/anlass: '([a-z_]+)'(?!\s*\+)/g)) gefunden.add(m[1]);
	}
	return [...gefunden];
}

test('jeder Anlass aus den Workflows hat einen Kanal', () => {
	const literal = literaleAnlaesse();
	assert.ok(literal.length >= 10, 'zu wenige Anlässe gefunden: ' + literal.join(','));
	const offen = [...literal, ...DYNAMISCH].filter((a) => !k.istBekannt(a));
	// "Kundenantwort" ist ein Status-Anlass im Audit, keine Meldung.
	assert.deepEqual(offen.filter((a) => a !== 'Kundenantwort'), []);
});

test('Zuordnung: vollständig, Rückfrage, ansehen, System, Log', () => {
	assert.equal(k.kanalArt('bereit'), 'anfragen');
	assert.equal(k.kanalArt('antwort_bereit'), 'anfragen');
	assert.equal(k.kanalArt('kalender_belegt'), 'anfragen');
	assert.equal(k.kanalArt('freigabe'), 'rueckfragen');
	assert.equal(k.kanalArt('antwort_keine_daten'), 'rueckfragen');
	assert.equal(k.kanalArt('keine_reaktion'), 'rueckfragen');
	assert.equal(k.kanalArt('keine_anfrage_storno'), 'ansehen');
	assert.equal(k.kanalArt('keine_anfrage_reklamation'), 'ansehen');
	assert.equal(k.kanalArt('antwort_storno'), 'ansehen');
	assert.equal(k.kanalArt('systemwarnung_manipulation'), 'ansehen');
	assert.equal(k.kanalArt('max_runden'), 'ansehen');
	assert.equal(k.kanalArt('zustelltest_fehlgeschlagen'), 'system');
	assert.equal(k.kanalArt('freigabe_nicht_zugestellt'), 'system');
	assert.equal(k.kanalArt('log_karte'), 'logs');
	assert.equal(k.kanalArt('gibt_es_nicht'), 'system');
	assert.equal(k.kanalArt(''), 'system');
});

test('kanalId: fünf Kanäle, alte Config ohne "ansehen", ohne kanaele', () => {
	const fuenf = { anfragen: 'A', rueckfragen: 'R', ansehen: 'B', system: 'S', logs: 'L' };
	assert.equal(k.kanalId(fuenf, 'bereit'), 'A');
	assert.equal(k.kanalId(JSON.stringify(fuenf), 'keine_anfrage_rueckruf'), 'B');
	assert.equal(k.kanalId({ anfragen: 'A', rueckfragen: 'R', system: 'S', logs: 'L' }, 'antwort_storno'), 'S');
	assert.equal(k.kanalId('', 'bereit'), '');
	assert.equal(k.kanalId('kaputt{', 'bereit'), '');
});

test('freigabeImKanal nur mit eingerichtetem Kanal Rückfragen', () => {
	assert.equal(k.freigabeImKanal({ rueckfragen: 'R' }), true);
	assert.equal(k.freigabeImKanal('{"rueckfragen":"R"}'), true);
	assert.equal(k.freigabeImKanal({}), false);
	assert.equal(k.freigabeImKanal(null), false);
});

test('fünf Kanäle in fester Reihenfolge', () => {
	assert.deepEqual(k.ARTEN, ['anfragen', 'rueckfragen', 'ansehen', 'system', 'logs']);
	assert.deepEqual(k.KANAELE.map((x) => x.name), ['1 Vollständige Anfragen', '2 Rückfragen', '3 Bitte ansehen', '4 Systemmeldungen', '5 Logs']);
});
