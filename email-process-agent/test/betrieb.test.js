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
	const kopf = b.kennzahlen({ daten: d, configs: basis().configs, vorgaenge: basis().vorgaenge, mails: [], heuteAb: '2026-10-17T22:00:00Z' });
	assert.equal(kopf.zustand.text, 'Alle Systeme normal');
	const html = b.seite({ daten: d, kopf, jetzt: JETZT, ablauf: '2027-01-16T06:00:00Z' });
	assert.match(html, /🟢/);
	assert.match(html, /--bg:#ffffff/);
	assert.match(html, /Link gültig bis 16\.01\.27/);
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
	// Ohne Freigaben: der erste Befund nennt den Kunden ("noch kein Zustelltest") und muss escaped erscheinen.
	const d = b.auswerten(basis({ configs: [{ kunde_id: '<b>x</b>', postfach: 'p', aktiv: true, freigeber: '[]' }], freigaben: [] }));
	const kopf = b.kennzahlen({ daten: d, configs: [{ kunde_id: '<b>x</b>', aktiv: true }], vorgaenge: [], mails: [], heuteAb: JETZT });
	const html = b.seite({ daten: d, kopf, jetzt: JETZT, ablauf: '2027-01-16T08:00:00Z' });
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

test('Kennzahlen: Kunden, Agents, Vorgänge heute, Erfolgsquote, Exceptions, kritische Fehler, Zustand', () => {
	const configs = [
		{ kunde_id: 'k1', aktiv: true, postfach_workflow_id: 'WF1', freigeber: '["disponent@x.de"]', postfach: 'a@x.de' },
		{ kunde_id: 'k3', aktiv: true, postfach_workflow_id: 'WF3', freigeber: '[]', postfach: 'c@x.de' },
		{ kunde_id: 'k2', aktiv: false, postfach_workflow_id: 'WF2' },
	];
	const HEUTE = '2026-10-17T22:00:00Z';
	const vorgaenge = [
		{ kunde_id: 'k1', vorgangs_id: 'V-1', status: 'Bereit zur Bearbeitung', createdAt: '2026-10-18T06:00:00Z', updatedAt: '2026-10-18T06:00:00Z' },
		{ kunde_id: 'k1', vorgangs_id: 'V-2', status: 'Ignoriert', createdAt: '2026-10-18T06:10:00Z' },
		{ kunde_id: 'k1', vorgangs_id: 'V-3', status: 'Eskaliert / Manuell', createdAt: '2026-10-15T06:00:00Z', updatedAt: '2026-10-15T06:00:00Z' },
		{ kunde_id: 'k3', vorgangs_id: 'V-4', status: 'Zuordnung unklar', createdAt: '2026-10-18T07:00:00Z', updatedAt: '2026-10-18T07:00:00Z' },
		{ kunde_id: 'k2', vorgangs_id: 'V-5', status: 'Neu', createdAt: '2026-10-18T07:00:00Z' },
	];
	const mails = [
		...Array.from({ length: 69 }, () => ({ kunde_id: 'k1', status: 'fertig', createdAt: '2026-10-18T06:00:00Z' })),
		{ kunde_id: 'k1', status: 'fehler', createdAt: '2026-10-18T06:00:00Z' },
		{ kunde_id: 'k1', status: 'in_arbeit', createdAt: '2026-10-18T07:59:00Z' },
		{ kunde_id: 'k1', status: 'fehler', createdAt: '2026-10-17T20:00:00Z' },
	];
	const system = [...OK_SYSTEM, { schluessel: 'zustelltest:k3', letzter_lauf: '2026-10-18T05:50:00Z', letztes_ergebnis: '{"ok":true}' }];
	const d = b.auswerten(basis({ configs, vorgaenge: vorgaenge.filter((v) => v.status !== 'Ignoriert'), system }));
	const k = b.kennzahlen({ daten: d, configs, vorgaenge, mails, heuteAb: HEUTE });
	assert.equal(k.kunden, 2);
	assert.equal(k.agents, 2);
	assert.equal(k.vorgaenge_heute, 2); // V-1, V-4 (nicht ignoriert, nicht inaktiver Kunde, nicht von gestern)
	assert.equal(k.erfolgsquote, 98.6); // 69 von 70
	assert.equal(k.exceptions, 2); // V-3, V-4
	assert.equal(k.kritisch, 0);
	assert.equal(k.zustand.stufe, 'warnung');
	assert.equal(k.zustand.text, '2 Agents benötigen Aufmerksamkeit');
	const html = b.seite({ daten: d, kopf: k, jetzt: JETZT, ablauf: '2027-01-16T08:00:00Z' });
	assert.match(html, /98,6 %/);
	assert.match(html, /🟡/);
	assert.match(html, />2<\/div><div class="name">Offene Exceptions/);

	// Kritisch: rot mit Grund; ohne Mails heute keine Quote
	const krit = b.auswerten(basis({ fehler: [{ createdAt: '2026-10-18T07:00:00Z', meldung: 'x', alarmiert_am: null }] }));
	const kk = b.kennzahlen({ daten: krit, configs: basis().configs, vorgaenge: [], mails: [], heuteAb: HEUTE });
	assert.equal(kk.zustand.symbol, '🔴');
	assert.equal(kk.zustand.text, 'Kritischer Fehler');
	assert.match(kk.zustand.grund, /Fehler ohne zugestellten Alarm/);
	assert.equal(kk.erfolgsquote, null);
	assert.match(b.seite({ daten: krit, kopf: kk, jetzt: JETZT, ablauf: JETZT }), /<div class="zahl">–<\/div><div class="name">Erfolgsquote heute/);
});

test('Kritische Fehler: Kachel öffnet Liste, jeder Fehler einzeln aufklappbar mit Einzelheiten', () => {
	const d = b.auswerten(basis({
		system: OK_SYSTEM.map((z) => (z.schluessel === 'zustelltest:k1' ? { ...z, letztes_ergebnis: '{"ok":false,"art":"nicht_angekommen"}' } : z)),
		fehler: [{ createdAt: '2026-10-18T07:00:00Z', workflow_name: 'EPA SW Freigabe senden', vorgangs_id: 'V-9', meldung: 'Chat <öffnen>', alarmiert_am: null }],
	}));
	const k = b.kennzahlen({ daten: d, configs: basis().configs, vorgaenge: [], mails: [], heuteAb: JETZT });
	assert.equal(k.kritisch, 2);
	const html = b.seite({ daten: d, kopf: k, jetzt: JETZT, ablauf: '2027-01-16T08:00:00Z' });
	assert.match(html, /<a class="kachel alarm" href="#kritisch">/);
	assert.match(html, /<section id="kritisch" class="fehlerliste">/);
	assert.equal((html.match(/<details class="fehler">/g) || []).length, 2);
	assert.match(html, /<b>Zustelltest fehlgeschlagen<\/b> <span class="leise">· k1<\/span>/);
	assert.match(html, /<dt>Was tun<\/dt><dd>Im Postfach nach Unzustellbarkeitsmeldungen/);
	assert.match(html, /<li>2026-10-18 07:00 UTC · EPA SW Freigabe senden · V-9: Chat &lt;öffnen&gt;<\/li>/);
	// Ohne kritische Fehler: keine Liste, Kachel nicht anklickbar
	const ok = b.auswerten(basis());
	const ko = b.kennzahlen({ daten: ok, configs: basis().configs, vorgaenge: [], mails: [], heuteAb: JETZT });
	const h2 = b.seite({ daten: ok, kopf: ko, jetzt: JETZT, ablauf: JETZT });
	assert.equal(h2.includes('id="kritisch"'), false);
	assert.equal(h2.includes('href="#kritisch"'), false);
});
