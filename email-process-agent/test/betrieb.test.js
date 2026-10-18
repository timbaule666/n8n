'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const b = require('../src/betrieb');
const u = require('../src/uebersicht');

const JETZT = '2026-10-18T08:00:00.000Z';
const OK_SYSTEM = [
	{ schluessel: 'epa04_lauf', letzter_lauf: '2026-10-18T07:05:00Z' },
	{ schluessel: 'watchdog', letzter_lauf: '2026-10-18T05:30:00Z', letztes_ergebnis: '{"gesamt":"ok","befunde":[]}' },
	{ schluessel: 'loeschjob', letzter_lauf: '2026-10-18T00:15:00Z' },
	{ schluessel: 'zustelltest:k1', letzter_lauf: '2026-10-18T05:50:00Z', letztes_ergebnis: '{"ok":true,"art":"ok"}' },
	{ schluessel: 'alarmierung', alarm_kanal: 'telegram_test' },
];
const basis = (x = {}) => ({
	configs: [
		{ kunde_id: 'k1', postfach: 'a@x.de', aktiv: true, postfach_workflow_id: 'WF1', freigeber: '["disponent@x.de"]' },
		{ kunde_id: 'k2', postfach: 'b@x.de', aktiv: false },
	],
	gueltig: { k1: true, k2: true },
	vorgaenge: [{ kunde_id: 'k1', vorgangs_id: 'V-1', status: 'Bereit zur Bearbeitung', erste_mail_am: '2026-10-18T07:00:00Z', updatedAt: '2026-10-18T07:00:00Z' }],
	freigaben: [{ kunde_id: 'k1', vorgangs_id: 'V-1', status: 'gesendet', entscheider: 'disponent@x.de', updatedAt: '2026-10-17T10:00:00Z' }],
	system: OK_SYSTEM,
	fehler: [],
	zugaenge: [{ kunde_id: b.BETREIBER, erstellt_am: '2026-10-18T06:00:00Z', ablauf: '2027-01-16T06:00:00Z', gesperrt_am: null }],
	jetzt: JETZT,
	...x,
});

test('Alles in Ordnung: nur aktive Kunden, alle Verbindungen grün, Sicherheit ok', () => {
	const d = b.auswerten(basis());
	assert.equal(d.stufe, 'ok', JSON.stringify(d.befunde));
	assert.deepEqual(d.kunden.map((k) => k.kunde_id), ['k1']);
	const k = d.kunden[0];
	assert.deepEqual([k.outlook.ok, k.teams.ok, k.ki.ok, k.versand.ok], [true, true, true, true]);
	assert.deepEqual(k.haengend, []);
	assert.equal(k.letzte_mail, '2026-10-18T07:00:00.000Z');
	assert.equal(d.sicherheit.filter((s) => !s.ok).length, 0);
	const html = b.seite({ daten: d, jetzt: JETZT, ablauf: '2027-01-16T06:00:00Z' });
	assert.match(html, /Alles läuft/);
	assert.match(html, /--bg:#ffffff/);
	assert.match(html, /Alle Freigaben der letzten 7 Tage kamen von eingetragenen Freigebern/);
	assert.match(html, /Dashboard-Link gültig bis 16\.01\.27/);
});

test('Anmeldefehler des Postfachs nach dem Watchdog-Lauf ist sofort rot; Watchdog-Befunde für Teams und KI', () => {
	const d = b.auswerten(basis({
		system: OK_SYSTEM.map((z) => (z.schluessel === 'watchdog' ? { ...z, letztes_ergebnis: '{"gesamt":"alarm","befunde":[{"code":"VERBINDUNG_TEAMS","kunde_id":"k1"},{"code":"VERBINDUNG_LLM","kunde_id":null}]}' } : z)),
		fehler: [{ createdAt: '2026-10-18T07:30:00Z', workflow_id: 'WF1', fehlercode: 'AUTH_FEHLER', statuscode: 401, meldung: 'The credential "Microsoft Outlook account 2" needs to be reconnected.', alarmiert_am: '2026-10-18T07:30:01Z' }],
	}));
	const k = d.kunden[0];
	assert.deepEqual([k.outlook.ok, k.teams.ok, k.ki.ok], [false, false, false]);
	assert.equal(d.stufe, 'kritisch');
	const t = d.befunde.map((x) => x.text).join('\n');
	assert.match(t, /Outlook-Postfach nicht erreichbar – Credential in n8n neu verbinden/);
	assert.match(t, /Teams nicht erreichbar/);
	assert.match(t, /KI nicht erreichbar/);
	// Ein Anmeldefehler VOR dem letzten Watchdog-Lauf zählt nicht mehr (Watchdog hat danach geprüft).
	const alt = b.auswerten(basis({ fehler: [{ createdAt: '2026-10-18T05:00:00Z', workflow_id: 'WF1', fehlercode: 'AUTH_FEHLER', alarmiert_am: 'x' }] }));
	assert.equal(alt.kunden[0].outlook.ok, true);
});

test('Hängende Vorgänge, Zustelltest, Läufe, Fehler ohne Alarm', () => {
	const d = b.auswerten(basis({
		vorgaenge: [
			{ kunde_id: 'k1', vorgangs_id: 'V-7', status: 'In Prüfung', updatedAt: '2026-10-18T06:00:00Z' },
			{ kunde_id: 'k1', vorgangs_id: 'V-8', status: 'Neu', updatedAt: '2026-10-18T07:30:00Z' },
		],
		system: [
			{ schluessel: 'epa04_lauf', letzter_lauf: '2026-10-18T02:00:00Z' },
			{ schluessel: 'watchdog', letzter_lauf: '2026-10-18T05:30:00Z', letztes_ergebnis: '{"gesamt":"ok"}' },
			{ schluessel: 'zustelltest:k1', letzter_lauf: '2026-10-18T05:50:00Z', letztes_ergebnis: '{"ok":false,"art":"nicht_angekommen"}' },
		],
		fehler: [{ createdAt: '2026-10-18T07:00:00Z', workflow_name: 'EPA-11', meldung: 'x', alarmiert_am: null }],
	}));
	assert.deepEqual(d.kunden[0].haengend, ['V-7']);
	const t = d.befunde.map((x) => `${x.stufe}:${x.text}`).join('\n');
	assert.match(t, /kritisch:k1: 1 Vorgang\/Vorgänge hängen seit über 1 h \(V-7\)/);
	assert.match(t, /kritisch:k1: letzter Zustelltest fehlgeschlagen \(nicht_angekommen\)/);
	assert.match(t, /kritisch:Nachfassen \(EPA-04\) seit über 3 h/);
	assert.match(t, /kritisch:1 Fehler ohne zugestellten Alarm – Alarmweg \(Teams\)/);
	assert.match(t, /warnung:Sicherheit: Löschjob \(EPA-08\) läuft nicht/);
	assert.equal(d.befunde[0].stufe, 'kritisch');
});

test('Sicherheit: fremder Freigeber, direkt gesendet, Fälschungsverdacht, mehrere oder ablaufende Dashboard-Links', () => {
	const d = b.auswerten(basis({
		freigaben: [
			{ kunde_id: 'k1', vorgangs_id: 'V-2', status: 'gesendet', entscheider: 'fremd@y.de', updatedAt: '2026-10-17T10:00:00Z' },
			{ kunde_id: 'k1', vorgangs_id: 'V-3', status: 'gesendet', entscheider: 'Outlook (direkt gesendet)', updatedAt: '2026-10-17T11:00:00Z' },
			{ kunde_id: 'k1', vorgangs_id: 'V-9', status: 'gesendet', entscheider: 'fremd@y.de', updatedAt: '2026-10-01T10:00:00Z' },
		],
		vorgaenge: [{ kunde_id: 'k1', vorgangs_id: 'V-4', status: 'Bereit zur Bearbeitung', spoofing_hinweis: 'Domain passt nicht', updatedAt: JETZT }],
		zugaenge: [
			{ kunde_id: b.BETREIBER, erstellt_am: '2026-10-18T06:00:00Z', ablauf: '2026-10-25T06:00:00Z', gesperrt_am: null },
			{ kunde_id: b.BETREIBER, erstellt_am: '2026-10-10T06:00:00Z', ablauf: '2027-01-08T06:00:00Z', gesperrt_am: null },
			{ kunde_id: b.BETREIBER, erstellt_am: '2026-10-01T06:00:00Z', ablauf: '2026-12-30T06:00:00Z', gesperrt_am: '2026-10-10T06:00:00Z' },
			{ kunde_id: 'k1', erstellt_am: '2026-10-18T06:05:00Z', ablauf: '2026-11-17T06:05:00Z', gesperrt_am: null },
		],
	}));
	const t = d.befunde.map((x) => `${x.stufe}:${x.text}`).join('\n');
	assert.match(t, /kritisch:Sicherheit: Freigabe durch nicht eingetragene Person: V-2$/m);
	assert.match(t, /warnung:Sicherheit: An der Freigabe vorbei direkt in Outlook gesendet \(7 Tage\): V-3/);
	assert.match(t, /warnung:Sicherheit: Verdacht auf gefälschten Absender in offenen Vorgängen: V-4/);
	assert.match(t, /kritisch:Sicherheit: 2 gültige Dashboard-Links/);
	assert.match(t, /warnung:Sicherheit: Dashboard-Link läuft bald ab/);
	assert.match(d.sicherheit.find((s) => s.info).text, /^1 gültige Kunden-Übersichtslink/);
});

test('Seite: escaped, Link-Nachricht, Trennung Kunden- und Betreiber-Links', () => {
	const d = b.auswerten(basis({ configs: [{ kunde_id: 'k1', postfach: '<b>x</b>', aktiv: true, freigeber: '[]' }] }));
	const html = b.seite({ daten: d, jetzt: JETZT, ablauf: '2027-01-16T08:00:00Z' });
	assert.equal(html.includes('<b>x</b>'), false);
	assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
	assert.match(html, /http-equiv="refresh"/);
	assert.match(b.linkNachricht({ link: 'https://a.b/webhook/epa-betrieb?k=x', ablauf: '2027-01-16T08:00:00Z' }), /href="https:\/\/a\.b\/webhook\/epa-betrieb\?k=x"/);
	assert.equal(b.BETREIBER, u.BETREIBER);
	const z = { id: 1, kunde_id: u.BETREIBER, ablauf: '2027-01-01T00:00:00Z' };
	assert.equal(u.zugangPruefen({ zugang: z, jetzt: JETZT }).ok, false);
	assert.equal(u.zugangPruefen({ zugang: z, jetzt: JETZT, betreiber: true }).ok, true);
	assert.equal(u.zugangPruefen({ zugang: { ...z, kunde_id: 'k1' }, jetzt: JETZT, betreiber: true }).ok, false);
	assert.equal(u.zugangPruefen({ zugang: { ...z, kunde_id: 'k1' }, jetzt: JETZT }).ok, true);
});
