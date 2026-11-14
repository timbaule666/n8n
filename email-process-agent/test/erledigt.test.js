'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const e = require('../src/erledigt');
const f = require('../src/freigabe');

const JETZT = '2026-11-16T10:00:00.000Z';
const ZEILE = { id: 3, kunde_id: 'k', vorgangs_id: 'V-2026-0003', token_hash: 'h', ablauf: '2026-12-16T10:00:00.000Z', verbraucht_am: null };
const VORGANG = { id: 9, vorgangs_id: 'V-2026-0003', status: 'Bereit zur Bearbeitung', betreff: 'Transport <Bonn>', absender_name: 'Lena' };

test('Knopf nur bei vollständigen Anfragen mit gültiger Vorgangsnummer', () => {
	assert.equal(e.mitKnopf('bereit', 'V-2026-0003'), true);
	assert.equal(e.mitKnopf('antwort_bereit', 'V-2026-0003'), true);
	for (const a of ['luecken', 'freigabe', 'keine_anfrage_storno', 'log_karte', '']) assert.equal(e.mitKnopf(a, 'V-2026-0003'), false, a);
	assert.equal(e.mitKnopf('bereit', ''), false);
	assert.equal(e.mitKnopf('bereit', 'x'), false);
});

test('Link und Knopf: Token im Link, im HTML escaped, wird in der Karte zum Knopf', () => {
	const t = f.tokenErzeugen(crypto);
	const url = e.link('https://x.example/', t.token);
	assert.equal(url, 'https://x.example/webhook/epa-erledigt?t=' + encodeURIComponent(t.token));
	const html = e.htmlMitKnopf('<b>Vollständige Anfrage</b>', url + '&x="');
	assert.match(html, /<a href="https:\/\/x\.example\/webhook\/epa-erledigt\?t=[^"]+&amp;x=&quot;">✅ Erledigt – Karte entfernen<\/a>$/);
});

test('Gespeichert wird nur der Hash, Ablauf 30 Tage, Teams-Nachricht als JSON', () => {
	const z = e.linkZeile({ kunde_id: 'k', vorgangs_id: 'V-2026-0003', hash: 'abc', jetzt: JETZT, teams: { team_id: 't', channel_id: 'c', nachricht_id: 123 } });
	assert.equal(z.token_hash, 'abc');
	assert.equal(z.ablauf, '2026-12-16T10:00:00.000Z');
	assert.equal(z.verbraucht_am, null);
	assert.deepEqual(JSON.parse(z.teams_nachricht), { team_id: 't', channel_id: 'c', id: '123' });
	assert.equal(e.linkZeile({ kunde_id: 'k', vorgangs_id: 'V', hash: 'a', jetzt: JETZT, teams: {} }).teams_nachricht, '');
	assert.ok(!JSON.stringify(z).includes('epa-erledigt'));
});

test('Prüfung: gültig nur bei unverbrauchtem, nicht abgelaufenem Link und Status "Bereit zur Bearbeitung"', () => {
	assert.deepEqual(e.linkPruefen(ZEILE, VORGANG, JETZT), { ok: true });
	assert.equal(e.linkPruefen(null, VORGANG, JETZT).status, 404);
	assert.equal(e.linkPruefen({ ...ZEILE, verbraucht_am: JETZT }, VORGANG, JETZT).status, 409);
	assert.equal(e.linkPruefen({ ...ZEILE, ablauf: JETZT }, VORGANG, JETZT).status, 410);
	assert.equal(e.linkPruefen(ZEILE, null, JETZT).status, 404);
	assert.equal(e.linkPruefen(ZEILE, { ...VORGANG, status: 'Abgeschlossen' }, JETZT).status, 409);
	const p = e.linkPruefen(ZEILE, { ...VORGANG, status: 'In Prüfung' }, JETZT);
	assert.equal(p.status, 409);
	assert.match(p.meldung, /In Prüfung/);
});

test('Wer hat es erledigt: nur Freigeber/Vertreter aus der Config', () => {
	const auswahl = e.personen({ freigeber: '["A@x.de","b@x.de"]', vertreter: ['a@x.de', 'c@x.de'] });
	assert.deepEqual(auswahl, ['a@x.de', 'b@x.de', 'c@x.de']);
	assert.deepEqual(e.personen({ freigeber: 'kaputt' }), []);
	assert.deepEqual(e.werPruefen(' B@x.de ', auswahl), { ok: true, wer: 'b@x.de' });
	assert.equal(e.werPruefen('', auswahl).ok, false);
	assert.equal(e.werPruefen('fremd@y.de', auswahl).ok, false);
});

test('Bestätigungsseite: Formular mit POST, Token versteckt, Inhalte escaped, keine Änderung per GET', () => {
	const html = e.seiteFormular(f.seite, { token: 'TOK', vorgang: VORGANG, auswahl: ['a@x.de'] });
	assert.match(html, /<form class="karte" method="post"/);
	assert.match(html, /name="t" value="TOK"/);
	assert.match(html, /value="erledigt"/);
	assert.match(html, /Transport &lt;Bonn&gt;/);
	assert.match(html, /<option value="a@x.de">/);
});
