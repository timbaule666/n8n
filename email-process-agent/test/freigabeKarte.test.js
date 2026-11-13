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
	const a = f.karteZustand({ ...FG, status: 'gesendet', fehlende_felder: '[{"feldname":"Telefon","anzeigename":"Telefonnummer"}]' }, { jetzt: JETZT, frist: '2026-11-12T16:00:00Z' });
	assert.equal(a.titel, '⏳ Wartet auf Antwort des Kunden');
	assert.equal(a.verschieben, true);
	assert.match(karteText(a), /Rückfrage verschickt von disponent@firma\.de · 10\.11\.2026, 18:32/);
	assert.match(karteText(a), /Gefragt: Telefonnummer/);
	assert.match(karteText(a), /Antwort erwartet bis 12\.11\.2026, 17:00/);
	assert.equal(a.karte.body[0].style, 'accent');
	assert.equal(a.karte.actions, undefined, 'keine Buttons mehr');
	assert.match(karteText(f.karteZustand({ ...FG, status: 'gesendet', bearbeitet: true })), /Rückfrage bearbeitet und verschickt/);
	assert.match(karteText(f.karteZustand({ ...FG, art: 'erinnerung', status: 'gesendet' })), /Erinnerung verschickt/);
	const m = f.karteZustand({ ...FG, status: 'gesendet', entscheidung: 'manuell_gesendet', entscheider: 'Outlook (direkt gesendet)' });
	assert.match(karteText(m), /Rückfrage direkt in Outlook verschickt · /);
	assert.doesNotMatch(karteText(m), /von Outlook/);
});

test('karteZustand: abgelehnt mit Grund, fehler, ersetzt, erneuert, unzustellbar', () => {
	const ab = f.karteZustand({ ...FG, status: 'abgelehnt', grund: 'Kunde ruft selbst an' }, { jetzt: JETZT });
	assert.equal(ab.titel, '❌ Abgelehnt');
	assert.equal(ab.verschieben, false);
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

test('kartenPlan: verschickt -> nach Warten verschieben, alte Warten-Karten mit entfernen', () => {
	const W = '19:warten1@thread.tacv2';
	const alt = { freigabe_id: 'F-alt', teams_nachricht: JSON.stringify({ ...TN, channel_id: W, id: '1111111111' }) };
	const fremd = { freigabe_id: 'F-x', teams_nachricht: JSON.stringify({ ...TN, id: '2222222222' }) };
	const p = f.kartenPlan({ fg: { ...FG, freigabe_id: 'F-neu', status: 'gesendet', teams_nachricht: JSON.stringify(TN) }, andere: [alt, fremd, { freigabe_id: 'F-neu', teams_nachricht: JSON.stringify(TN) }], wartenKanal: W, jetzt: JETZT });
	assert.equal(p.aktion, 'verschieben');
	assert.equal(p.ziel_channel_id, W);
	assert.deepEqual(p.entfernen.map((t) => t.id), [TN.id, '1111111111']);
	assert.match(p.html, /EPA_KARTE:/);
});

test('kartenPlan: Karte in Warten wird bei Antwort entfernt, bleibt bei gesendet', () => {
	const W = '19:warten1@thread.tacv2';
	const inW = JSON.stringify({ ...TN, channel_id: W });
	assert.equal(f.kartenPlan({ fg: { ...FG, freigabe_id: 'F', status: 'gesendet', teams_nachricht: inW }, zustand: 'beantwortet', wartenKanal: W }).aktion, 'entfernen');
	assert.equal(f.kartenPlan({ fg: { ...FG, freigabe_id: 'F', status: 'unzustellbar', teams_nachricht: inW }, wartenKanal: W }).aktion, 'entfernen');
	assert.equal(f.kartenPlan({ fg: { ...FG, freigabe_id: 'F', status: 'gesendet', teams_nachricht: inW }, wartenKanal: W }).aktion, 'nichts');
});

test('kartenPlan: abgelehnt ändern, ohne Warten-Kanal ändern, beantwortet in Rückfragen nichts', () => {
	const W = '19:warten1@thread.tacv2';
	assert.equal(f.kartenPlan({ fg: { ...FG, freigabe_id: 'F', status: 'abgelehnt', teams_nachricht: JSON.stringify(TN) }, wartenKanal: W }).aktion, 'aendern');
	assert.equal(f.kartenPlan({ fg: { ...FG, freigabe_id: 'F', status: 'gesendet', teams_nachricht: JSON.stringify(TN) }, wartenKanal: '' }).aktion, 'aendern');
	assert.equal(f.kartenPlan({ fg: { ...FG, freigabe_id: 'F', status: 'ersetzt', teams_nachricht: JSON.stringify(TN) }, zustand: 'beantwortet', wartenKanal: W }).aktion, 'nichts');
	assert.equal(f.kartenPlan({ fg: { ...FG, freigabe_id: 'F', status: 'gesendet' }, wartenKanal: W }).aktion, 'nichts');
});

test('Warten-Karte übernimmt die vollständige Freigabe-Karte ohne Button und Link-Hinweis', () => {
	const original = { type: 'AdaptiveCard', version: '1.4', body: [
		{ type: 'ColumnSet', columns: [{ type: 'Column', items: [{ type: 'TextBlock', text: 'Freigabe erforderlich' }] }] },
		{ type: 'TextBlock', text: '**Jana Wolff** · Transport Dortmund – Unna (V-1)' },
		{ type: 'ColumnSet', columns: [{ type: 'Column', items: [{ type: 'TextBlock', text: 'VORHANDEN' }, { type: 'TextBlock', text: '✅ Abhol-PLZ: 44135' }] }, { type: 'Column', items: [{ type: 'TextBlock', text: 'FEHLT NOCH' }, { type: 'TextBlock', text: '❌ Telefonnummer' }] }] },
		{ type: 'Container', items: [{ type: 'TextBlock', text: 'ENTWURF DER RÜCKFRAGE' }, { type: 'TextBlock', text: 'alter Entwurf' }] },
		{ type: 'TextBlock', isSubtle: true, text: 'Link einmal verwendbar, gültig bis 12.11.2026. Es wird nichts ohne Klick versendet.' },
	], actions: [{ type: 'Action.OpenUrl', title: 'Entwurf prüfen und freigeben', url: 'https://x' }] };
	const k = f.karteZustand({ ...FG, status: 'gesendet', entwurf_text: 'verschickter Text' }, { jetzt: JETZT, frist: '2026-11-12T16:00:00Z', original: JSON.stringify(original) });
	const t = JSON.stringify(k.karte);
	assert.match(t, /Wartet auf Antwort des Kunden/);
	assert.match(t, /✅ Abhol-PLZ: 44135/);
	assert.match(t, /❌ Telefonnummer/);
	assert.match(t, /VERSCHICKTE RÜCKFRAGE/);
	assert.match(t, /verschickter Text/);
	assert.match(t, /Antwort erwartet bis/);
	assert.doesNotMatch(t, /alter Entwurf|Link einmal|Freigabe erforderlich|Action\.OpenUrl/);
	assert.equal(k.karte.actions, undefined);
	assert.equal(f.karteWarten('kaputt{', FG, { kopf: 'x', zeilen: [] }), null);
	assert.equal(f.kartenPlan({ fg: { ...FG, freigabe_id: 'F', status: 'gesendet', teams_nachricht: JSON.stringify(TN), teams_karte: JSON.stringify(original) }, wartenKanal: '19:w@thread.tacv2' }).html.includes('EPA_KARTE'), true);
});

test('karteOhneLink: Button und Link fallen weg, nichts mit URL wird gespeichert', () => {
	const k = { type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: 'x' }, { type: 'Container', selectAction: { type: 'Action.OpenUrl', url: 'https://a/webhook/epa-freigabe?t=geheim' }, items: [] }], actions: [{ type: 'Action.OpenUrl', url: 'https://a/webhook/epa-freigabe?t=geheim' }] };
	const o = f.karteOhneLink(k);
	assert.doesNotMatch(JSON.stringify(o), /geheim|https/);
	assert.equal(o.actions, undefined);
	assert.equal(f.karteOhneLink({ body: [{ type: 'TextBlock', text: 'siehe https://a/webhook/epa-freigabe?t=geheim' }] }), null);
	assert.equal(f.karteOhneLink(null), null);
});

test('meldungVerschickt: Absender und wichtigste Daten', () => {
	const m = f.meldungVerschickt({ ...FG, status: 'gesendet', fehlende_felder: '[{"feldname":"Telefon","anzeigename":"Telefonnummer"}]' }, { absender_name: 'Jana Wolff', absender_adresse: 'jana@kunde.de', betreff: 'Transport Dortmund – Unna', vorgangs_id: 'V-2026-0070' }, { frist: '2026-11-18T10:00:00Z' });
	const t = JSON.stringify(m.karte);
	assert.equal(m.titel, '✅ Rückfrage verschickt');
	assert.match(t, /Jana Wolff <jana@kunde\.de>/);
	assert.match(t, /Transport Dortmund – Unna/);
	assert.match(t, /Telefonnummer/);
	assert.match(t, /von disponent@firma\.de · 10\.11\.2026, 18:32/);
	assert.match(t, /18\.11\.2026, 11:00/);
	assert.match(m.html, /EPA_KARTE:/);
});

test('weitereKarten: nur Freigabe-Karten desselben Vorgangs, nicht gelöscht, ohne Ausnahmen', () => {
	const n = [
		{ id: '1', text: 'Freigabe erforderlich … (V-2026-0076)' },
		{ id: '2', text: 'Freigabe erforderlich … (V-2026-0076)', geloescht: '2026-11-10' },
		{ id: '3', text: 'Freigabe erforderlich … (V-2026-0077)' },
		{ id: '4', text: '❌ Abgelehnt (V-2026-0076)' },
		{ id: '5', text: 'Freigabe erforderlich … (V-2026-0076)' },
	];
	assert.deepEqual(f.weitereKarten(n, 'V-2026-0076', ['5']), ['1']);
	assert.deepEqual(f.weitereKarten(n, 'kaputt', []), []);
});

test('karteOhneLink: echte Freigabe-Karte mit $schema wird gespeichert (ohne $schema, ohne Button)', () => {
	const k = { type: 'AdaptiveCard', '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body: [{ type: 'TextBlock', text: 'Freigabe erforderlich' }], actions: [{ type: 'Action.OpenUrl', title: 'Entwurf prüfen und freigeben', url: 'https://x.example/webhook/epa-freigabe?t=geheim' }] };
	const o = f.karteOhneLink(k);
	assert.ok(o, 'Karte darf nicht verworfen werden');
	assert.equal(o.$schema, undefined);
	assert.equal(o.actions, undefined);
	assert.equal(o.body[0].text, 'Freigabe erforderlich');
	assert.doesNotMatch(JSON.stringify(o), /https?:\/\//);
});
