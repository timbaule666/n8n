'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../src/freigabe');

const TN = { team_id: '30fdf51a-7712-457a-b4d3-a53a6143faea', channel_id: '19:74a8abc@thread.tacv2', id: '1794332199686' };
const FG = { vorgangs_id: 'V-2026-0070', art: 'rueckfrage', runde: 1, betreff: 'RE: Ware defekt', entscheider: 'disponent@firma.de', gesendet_am: '2026-11-10T17:32:00Z' };
const JETZT = '2026-11-10T17:40:00Z';
const karteText = (k) => JSON.stringify(k.karte);

test('teamsNachrichtLesen: JSON-Text, Objekt, ungültig', () => {
	assert.deepEqual(f.teamsNachrichtLesen(JSON.stringify(TN)), TN);
	assert.deepEqual(f.teamsNachrichtLesen(TN), TN);
	assert.equal(f.teamsNachrichtLesen(''), null);
	assert.equal(f.teamsNachrichtLesen('kaputt{'), null);
	assert.equal(f.teamsNachrichtLesen({ ...TN, team_id: 'x' }), null);
	assert.equal(f.teamsNachrichtLesen({ ...TN, channel_id: 'abc' }), null);
	assert.equal(f.teamsNachrichtLesen({ ...TN, id: '../x' }), null);
});

test('karteZustand: freigegeben, bearbeitet, manuell gesendet', () => {
	const a = f.karteZustand({ ...FG, status: 'gesendet' }, { jetzt: JETZT });
	assert.equal(a.titel, '✅ Freigegeben und gesendet');
	assert.match(karteText(a), /Von disponent@firma\.de · 10\.11\.2026, 18:32/);
	assert.equal(a.karte.body[0].style, 'good');
	assert.equal(a.karte.actions, undefined, 'keine Buttons mehr');
	assert.equal(f.karteZustand({ ...FG, status: 'gesendet', bearbeitet: true }).titel, '✅ Bearbeitet und gesendet');
	const m = f.karteZustand({ ...FG, status: 'gesendet', entscheidung: 'manuell_gesendet', entscheider: 'Outlook (direkt gesendet)' });
	assert.equal(m.titel, '✅ Direkt in Outlook gesendet');
	assert.doesNotMatch(karteText(m), /Von Outlook/);
});

test('karteZustand: abgelehnt mit Grund, fehler, ersetzt, erneuert, unzustellbar', () => {
	const ab = f.karteZustand({ ...FG, status: 'abgelehnt', grund: 'Kunde ruft selbst an' }, { jetzt: JETZT });
	assert.equal(ab.titel, '❌ Abgelehnt');
	assert.match(karteText(ab), /Grund: Kunde ruft selbst an/);
	assert.equal(f.karteZustand({ ...FG, status: 'fehler' }).karte.body[0].style, 'warning');
	assert.equal(f.karteZustand({ ...FG, status: 'ersetzt' }).titel, '↩️ Nicht mehr nötig');
	assert.equal(f.karteZustand({ ...FG, status: 'offen' }, { zustand: 'erneuert' }).titel, '⏰ Dieser Link gilt nicht mehr');
	assert.equal(f.karteZustand({ ...FG, status: 'unzustellbar' }).titel, '📭 Gesendet, aber nicht zugestellt');
});

test('karteZustand: offen und in_versand ändern nichts', () => {
	assert.equal(f.karteZustand({ ...FG, status: 'offen' }), null);
	assert.equal(f.karteZustand({ ...FG, status: 'in_versand' }), null);
	assert.equal(f.karteZustand(null), null);
});

test('karteZustand: HTML-Rückfall mit Marker, Text maskiert', () => {
	const k = f.karteZustand({ ...FG, status: 'abgelehnt', vorgangs_id: '<b>V</b>' });
	assert.match(k.html, /<!--EPA_KARTE:[A-Za-z0-9+/=]+-->$/);
	assert.doesNotMatch(k.html.split('<!--')[0], /<b>V<\/b>/);
	const m = k.html.match(/EPA_KARTE:([^-]+)-->/)[1];
	assert.deepEqual(JSON.parse(Buffer.from(m, 'base64').toString('utf8')), k.karte);
	assert.equal(k.karte.body[1].facts[1].value, 'Rückfrage (Runde 1)');
	assert.equal(f.karteZustand({ ...FG, art: 'erinnerung', status: 'gesendet' }).karte.body[1].facts[1].value, 'Erinnerung');
});
