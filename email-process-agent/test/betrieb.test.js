'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const b = require('../src/betrieb');
const u = require('../src/uebersicht');

const JETZT = '2026-10-18T08:00:00.000Z';
const basis = (x = {}) => ({
	configs: [{ kunde_id: 'k1', postfach: 'a@x.de', aktiv: true }, { kunde_id: 'k2', postfach: 'b@x.de', aktiv: false }],
	gueltig: { k1: true, k2: true },
	vorgaenge: [
		{ kunde_id: 'k1', status: 'Eskaliert / Manuell', erste_mail_am: '2026-10-17T10:00:00Z' },
		{ kunde_id: 'k1', status: 'Bereit zur Bearbeitung', erste_mail_am: '2026-10-18T07:00:00Z' },
		{ kunde_id: 'k1', status: 'Abgeschlossen', erste_mail_am: '2026-10-01T07:00:00Z' },
		{ kunde_id: 'k1', status: 'Bereit zur Bearbeitung', erste_mail_am: '2026-09-01T07:00:00Z' },
		{ kunde_id: 'k1', status: 'Ignoriert', erste_mail_am: '2026-10-18T07:30:00Z' },
	],
	freigaben: [{ kunde_id: 'k1', status: 'unzustellbar' }, { kunde_id: 'k1', status: 'offen' }],
	system: [
		{ schluessel: 'epa04_lauf', letzter_lauf: '2026-10-18T07:05:00Z', letztes_ergebnis: '{"aufgaben":2,"pruefungen":1}' },
		{ schluessel: 'watchdog', letzter_lauf: '2026-10-18T05:30:00Z', letztes_ergebnis: '{"gesamt":"ok","befunde":[]}' },
		{ schluessel: 'zustelltest:k1', letzter_lauf: '2026-10-18T05:50:00Z', letztes_ergebnis: '{"ok":true,"art":"ok"}' },
		{ schluessel: 'alarmierung', alarm_kanal: 'telegram_test' },
	],
	fehler: [],
	gruppen: u.GRUPPEN,
	jetzt: JETZT,
	...x,
});

test('Auswertung: Zahlen je Kunde, Hinweise, Verlauf über 14 Tage', () => {
	const d = b.auswerten(basis());
	assert.equal(d.stufe, 'warnung');
	const k1 = d.kunden.find((k) => k.kunde_id === 'k1');
	assert.deepEqual(k1.zahlen, { klaerung: 1, freigabe: 0, bereit: 2, kunde: 0, system: 0 });
	assert.equal(k1.unzustellbar, 1);
	assert.equal(k1.letzte_mail, '2026-10-18T07:00:00.000Z');
	assert.deepEqual(k1.zustelltest, { ok: true, art: 'ok', am: '2026-10-18T05:50:00Z' });
	assert.deepEqual(d.befunde.map((x) => x.stufe), ['warnung', 'warnung']);
	assert.match(d.befunde.map((x) => x.text).join('|'), /kamen beim Kunden nicht an.*Klärung/);
	// Inaktive Kunden werden ausgeblendet und erzeugen keinen Befund
	assert.deepEqual(d.kunden.map((k) => k.kunde_id), ['k1']);
	assert.equal(d.befunde.some((x) => x.text.startsWith('k2')), false);
	assert.equal(d.verlauf.length, 14);
	assert.deepEqual(d.verlauf.slice(-2), [{ tag: '2026-10-17', anzahl: 1 }, { tag: '2026-10-18', anzahl: 1 }]);
	// 01.10. und 01.09. liegen außerhalb der 14 Tage
	assert.equal(d.verlauf.reduce((n, v) => n + v.anzahl, 0), 2);
	assert.equal(d.laeufe.alarm_kanal, 'telegram_test');
});

test('Auswertung: kritisch bei fehlgeschlagenem Zustelltest, stehendem Nachfassen, Fehler ohne Alarm, ungültiger Config', () => {
	const d = b.auswerten(basis({
		gueltig: { k1: false },
		system: [
			{ schluessel: 'epa04_lauf', letzter_lauf: '2026-10-18T02:00:00Z' },
			{ schluessel: 'watchdog', letzter_lauf: '2026-10-18T05:30:00Z', letztes_ergebnis: '{"gesamt":"warnung","befunde":[{"code":"VERBINDUNG_TEAMS"}]}' },
			{ schluessel: 'zustelltest:k1', letzter_lauf: '2026-10-18T05:50:00Z', letztes_ergebnis: '{"ok":false,"art":"nicht_angekommen"}' },
		],
		fehler: [
			{ createdAt: '2026-10-18T07:00:00Z', workflow_name: 'EPA-11 Zustelltest', statuscode: 502, fehlercode: 'UPSTREAM_FEHLER', meldung: 'x', alarmiert_am: null },
			{ createdAt: '2026-10-12T07:00:00Z', workflow_name: 'EPA-01', meldung: 'alt', alarmiert_am: '2026-10-12T07:00:01Z' },
		],
	}));
	assert.equal(d.stufe, 'kritisch');
	const t = d.befunde.map((x) => `${x.stufe}:${x.text}`).join('\n');
	assert.match(t, /kritisch:k1: Config ungültig/);
	assert.match(t, /kritisch:k1: letzter Zustelltest fehlgeschlagen \(nicht_angekommen\)/);
	assert.match(t, /kritisch:Nachfassen \(EPA-04\) seit über 3 h/);
	assert.match(t, /warnung:Watchdog meldet „warnung“ \(VERBINDUNG_TEAMS\)/);
	assert.match(t, /kritisch:1 Fehler ohne zugestellten Alarm/);
	assert.match(t, /warnung:1 Fehler in den letzten 24 h/);
	assert.equal(d.befunde[0].stufe, 'kritisch');
	assert.deepEqual(d.fehler.liste.map((f) => f.workflow), ['EPA-11 Zustelltest', 'EPA-01']);
});

test('Alles in Ordnung ohne Befunde; Seite escaped, Diagramm mit Hover-Titeln', () => {
	const d = b.auswerten(basis({ freigaben: [], vorgaenge: [{ kunde_id: 'k1', status: 'Bereit zur Bearbeitung', erste_mail_am: '2026-10-18T07:00:00Z' }], configs: [{ kunde_id: 'k1', postfach: '<b>x</b>', aktiv: true }] }));
	assert.equal(d.stufe, 'ok');
	const html = b.seite({ daten: d, jetzt: JETZT, ablauf: '2027-01-16T08:00:00Z', gruppen: u.GRUPPEN });
	assert.match(html, /Alles in Ordnung/);
	assert.equal(html.includes('<b>x</b>'), false);
	assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
	assert.match(html, /<title>18\.10\.2026: 1 Anfrage<\/title>/);
	assert.match(html, /http-equiv="refresh"/);
	const svg = b.verlaufSvg([{ tag: '2026-10-17', anzahl: 0 }, { tag: '2026-10-18', anzahl: 12 }]);
	assert.equal((svg.match(/class="balken"/g) || []).length, 1);
	assert.match(svg, />15<\/text>/);
	assert.match(b.linkNachricht({ link: 'https://a.b/webhook/epa-betrieb?k=x', ablauf: '2027-01-16T08:00:00Z' }), /href="https:\/\/a\.b\/webhook\/epa-betrieb\?k=x"/);
});

test('Kunden- und Betreiber-Links sind getrennt', () => {
	assert.equal(b.BETREIBER, u.BETREIBER);
	const z = { id: 1, kunde_id: u.BETREIBER, ablauf: '2027-01-01T00:00:00Z' };
	assert.equal(u.zugangPruefen({ zugang: z, jetzt: JETZT }).ok, false);
	assert.equal(u.zugangPruefen({ zugang: z, jetzt: JETZT, betreiber: true }).ok, true);
	assert.equal(u.zugangPruefen({ zugang: { ...z, kunde_id: 'k1' }, jetzt: JETZT, betreiber: true }).ok, false);
	assert.equal(u.zugangPruefen({ zugang: { ...z, kunde_id: 'k1' }, jetzt: JETZT }).ok, true);
});
