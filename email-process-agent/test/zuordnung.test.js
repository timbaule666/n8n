'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { zuordnen, bewerteKandidat } = require('../src/zuordnung');

const mail = (extra = {}) => ({
	absender_adresse: 'max@kunde.de', conversation_id: 'c-neu', bezug_message_ids: [], betreff_normalisiert: 'transport hamburg',
	vorgangs_ids_erwaehnt: [], ...extra,
});
const vorgang = (id, extra = {}) => ({
	vorgangs_id: id, status: 'Warten auf Kunde', version: 3, conversation_id: `c-${id}`, bekannte_message_ids: [`<${id}@x>`],
	absender_adresse: 'max@kunde.de', betreff_normalisiert: 'transport hamburg', ...extra,
});

test('Punkte je Signal (Bauplan 5.2)', () => {
	const b = bewerteKandidat(mail({ bezug_message_ids: ['<A@x>'], conversation_id: 'c-A', vorgangs_ids_erwaehnt: ['A'] }), vorgang('A'));
	assert.deepEqual(b.punkte.map((p) => p.punkte), [60, 40, 25, 15, 60]);
	assert.equal(b.summe, 200);
	assert.equal(b.konflikt, false);
	const kollege = bewerteKandidat(mail({ absender_adresse: 'eva@kunde.de', betreff_normalisiert: 'x' }), vorgang('A'));
	assert.deepEqual(kollege.punkte, [{ signal: 'gleiche Absender-Domain', punkte: 10 }]);
	const fremd = bewerteKandidat(mail({ absender_adresse: 'dritter@andere.de', conversation_id: 'c-A' }), vorgang('A'));
	assert.equal(fremd.konflikt, true);
	assert.equal(fremd.summe, 40 + 15 - 40);
});

test('Antwort im Thread -> eindeutig', () => {
	const r = zuordnen(mail({ bezug_message_ids: ['<A@x>'], conversation_id: 'c-A' }), [vorgang('A'), vorgang('B', { betreff_normalisiert: 'anderes' })]);
	assert.equal(r.ergebnis, 'eindeutig');
	assert.equal(r.vorgangs_id, 'A');
	assert.equal(r.bewertung.length, 2);
});

test('Kollege derselben Firma antwortet im Thread -> eindeutig', () => {
	const r = zuordnen(mail({ absender_adresse: 'eva@kunde.de', bezug_message_ids: ['<A@x>'], conversation_id: 'c-A' }), [vorgang('A')]);
	assert.equal(r.ergebnis, 'eindeutig');
});

test('Keine Kandidaten bzw. nur schwache Signale -> neu', () => {
	assert.equal(zuordnen(mail(), []).ergebnis, 'neu');
	assert.equal(zuordnen(mail({ betreff_normalisiert: 'ganz anders' }), [vorgang('A')]).ergebnis, 'neu'); // nur Absender 25
});

test('Zwei offene Vorgänge desselben Absenders mit gleichem Betreff, ohne Thread -> unklar', () => {
	const r = zuordnen(mail(), [vorgang('A'), vorgang('B')]);
	assert.equal(r.ergebnis, 'unklar');
	assert.equal(r.vorgangs_id, null);
	assert.equal(r.bewertung.length, 2);
});

test('Weiterleitung eines bekannten Threads durch Dritte -> unklar (Konfliktmarker)', () => {
	const r = zuordnen(mail({ absender_adresse: 'dritter@andere.de', bezug_message_ids: ['<A@x>'], conversation_id: 'c-A' }), [vorgang('A')]);
	assert.equal(r.ergebnis, 'unklar');
	assert.match(r.grund, /fremden Domain/);
	// auch wenn die Punkte unter der Neu-Schwelle liegen
	const r2 = zuordnen(mail({ absender_adresse: 'dritter@andere.de', conversation_id: 'c-A', betreff_normalisiert: 'x' }), [vorgang('A')]);
	assert.equal(r2.ergebnis, 'unklar');
});

test('Zwei starke Kandidaten (Thread A, Vorgangs-ID B genannt) -> unklar', () => {
	const r = zuordnen(mail({ bezug_message_ids: ['<A@x>'], conversation_id: 'c-A', vorgangs_ids_erwaehnt: ['B'] }), [vorgang('A'), vorgang('B')]);
	assert.equal(r.ergebnis, 'unklar');
	assert.match(r.grund, /mehrere Kandidaten/);
});

test('Nur Vorgangs-ID im Betreff + gleicher Absender -> eindeutig', () => {
	const r = zuordnen(mail({ vorgangs_ids_erwaehnt: ['A'], betreff_normalisiert: 'nachtrag v-2026-0001' }), [vorgang('A')]);
	assert.equal(r.ergebnis, 'eindeutig');
});

test('Schwellen aus der Config werden beachtet', () => {
	const m = mail({ conversation_id: 'c-A', betreff_normalisiert: 'x' }); // 40 + 25 = 65
	assert.equal(zuordnen(m, [vorgang('A')]).ergebnis, 'unklar');
	assert.equal(zuordnen(m, [vorgang('A')], { eindeutig: 60 }).ergebnis, 'eindeutig');
	assert.equal(zuordnen(m, [vorgang('A')], { neu: 70, eindeutig: 80 }).ergebnis, 'neu');
});
