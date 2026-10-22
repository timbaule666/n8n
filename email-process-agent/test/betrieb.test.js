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
	assert.match(t, /warnung:k1: 1 Vorgang\/Vorgänge hängen seit über 1 h \(V-7\)/);
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

test('Agent-Status pro Kunde: Ampel, letzter Lauf, Zahlen von heute, kritische zuerst', () => {
	const HEUTE = '2026-10-17T22:00:00Z';
	const configs = [
		{ kunde_id: 'k1', postfach: 'a@x.de', aktiv: true, postfach_workflow_id: 'WF1', freigeber: '[]' },
		{ kunde_id: 'k3', postfach: 'c@x.de', aktiv: true, postfach_workflow_id: 'WF3', freigeber: '[]' },
		{ kunde_id: 'k4', postfach: 'd@x.de', aktiv: true, postfach_workflow_id: 'WF4', freigeber: '[]' },
	];
	const system = [
		...OK_SYSTEM,
		{ schluessel: 'zustelltest:k3', letzter_lauf: '2026-10-18T05:50:00Z', letztes_ergebnis: '{"ok":true}' },
		{ schluessel: 'zustelltest:k4', letzter_lauf: '2026-10-18T05:50:00Z', letztes_ergebnis: '{"ok":false,"art":"nicht_angekommen"}' },
	];
	const mails = [
		...Array.from({ length: 33 }, () => ({ kunde_id: 'k1', status: 'fertig', ergebnis: 'bereit', createdAt: '2026-10-18T06:00:00Z' })),
		{ kunde_id: 'k1', status: 'fertig', ergebnis: 'zuordnung_unklar', createdAt: '2026-10-18T06:26:00Z' },
		{ kunde_id: 'k1', status: 'fehler', createdAt: '2026-10-16T06:00:00Z' },
		{ kunde_id: 'k3', status: 'fertig', ergebnis: 'antwort_extraktion_fehlgeschlagen', createdAt: '2026-10-18T07:00:00Z' },
		{ kunde_id: 'k3', status: 'fertig', ergebnis: 'klassifizierung_unklar', createdAt: '2026-10-18T07:10:00Z' },
		{ kunde_id: 'k3', status: 'fertig', ergebnis: 'unzustellbar', createdAt: '2026-10-18T07:20:00Z' },
		{ kunde_id: 'k4', status: 'fertig', ergebnis: 'bereit', createdAt: '2026-10-18T05:41:00Z' },
		{ kunde_id: 'k4', status: 'fehler', createdAt: '2026-10-18T05:42:00Z' },
		{ kunde_id: 'k2', status: 'fehler', createdAt: '2026-10-18T05:42:00Z' },
	];
	const d = b.auswerten(basis({ configs, gueltig: {}, system, vorgaenge: [], freigaben: [] }));
	const a = b.agentStatus({ daten: d, mails, heuteAb: HEUTE, jetzt: JETZT });
	assert.deepEqual(a.map((x) => [x.kunde_id, x.stufe]), [['k4', 'kritisch'], ['k3', 'warnung'], ['k1', 'ok']]);
	const [k4, k3, k1] = a;
	assert.deepEqual([k1.heute, k1.erfolgreich, k1.exceptions, k1.fehler, k1.letzter_lauf], [34, 33, 1, 0, '2026-10-18T06:26:00.000Z']);
	assert.equal(k1.symbol + ' ' + k1.text, '🟢 Healthy');
	assert.deepEqual([k3.heute, k3.erfolgreich, k3.exceptions, k3.fehler], [3, 0, 3, 0]);
	assert.match(k3.grund, /3 Exceptions heute/);
	assert.deepEqual([k4.heute, k4.erfolgreich, k4.fehler], [2, 1, 1]);
	assert.match(k4.grund, /Zustelltest fehlgeschlagen · 1 Fehler heute/);
	assert.equal(k4.symbol, '🔴');

	// Warnung: hängende Vorgänge, lange keine Mail
	const h = b.auswerten(basis({ vorgaenge: [{ kunde_id: 'k1', vorgangs_id: 'V-7', status: 'Neu', updatedAt: '2026-10-18T06:00:00Z' }] }));
	const ah = b.agentStatus({ daten: h, mails: [{ kunde_id: 'k1', status: 'fertig', createdAt: '2026-10-15T06:00:00Z' }], heuteAb: HEUTE, jetzt: JETZT });
	assert.equal(ah[0].stufe, 'warnung');
	assert.match(ah[0].grund, /1 Vorgang\/Vorgänge hängen · seit über 48 h keine Mail/);

	// Gesamtzustand zählt Agents aus der Ampel; Tabelle im HTML, escaped
	const k = b.kennzahlen({ daten: d, configs, vorgaenge: [], mails, heuteAb: HEUTE, agenten: a });
	assert.equal(k.erfolgsquote, 97.4); // 38 fertig, 1 Fehler (k2 inaktiv, k1-Fehler von vorgestern)
	// k4 hat schon einen kritischen Befund (Zustelltest) – die Fehler heute zählen nicht doppelt
	assert.equal(k.kritisch, 1);
	assert.equal(k.zustand.stufe, 'kritisch');
	const html = b.seite({ daten: d, kopf: k, agenten: a, jetzt: JETZT, ablauf: JETZT });
	assert.match(html, /<h2 class="abschnitt">Agent-Status pro Kunde<\/h2>/);
	assert.match(html, /<th>Kunde<\/th><th>Agent<\/th><th>Status<\/th><th>Letzter Lauf<\/th><th class="n">Heute<\/th><th class="n">Erfolgreich<\/th><th class="n">Exceptions<\/th><th class="n">Fehler<\/th>/);
	assert.match(html, /<tr class="kritisch"><td><b>k4<\/b>/);
	assert.match(html, /🟢 Healthy/);
	assert.match(html, /<td>08:26<\/td>/); // 06:26 UTC = 08:26 Berlin
	assert.match(html, /<td class="n rot">1<\/td><\/tr>/);
	// Nur technische Fehler heute: zusätzlicher kritischer Fehler in Kachel, Zustand und Liste
	const ok = b.auswerten(basis());
	const af = b.agentStatus({ daten: ok, mails: [{ kunde_id: 'k1', status: 'fehler', createdAt: '2026-10-18T07:00:00Z' }], heuteAb: HEUTE, jetzt: JETZT });
	const kf = b.kennzahlen({ daten: ok, configs: basis().configs, vorgaenge: [], mails: [], heuteAb: HEUTE, agenten: af });
	assert.equal(kf.kritisch, 1);
	assert.equal(kf.zustand.symbol, '🔴');
	assert.match(b.seite({ daten: ok, kopf: kf, agenten: af, jetzt: JETZT, ablauf: JETZT }), /<b>Verarbeitung mit Fehler abgebrochen<\/b> <span class="leise">· k1/);
	const x = b.agentStatus({ daten: b.auswerten(basis({ configs: [{ kunde_id: '<i>', aktiv: true, postfach: '<p>' }] })), mails: [], heuteAb: HEUTE, jetzt: JETZT });
	assert.equal(b.seite({ daten: d, kopf: k, agenten: x, jetzt: JETZT, ablauf: JETZT }).includes('<i>'), false);
});

test('Vorgangsstatus heute: Ringdiagramm, Legende, Automation Rate', () => {
	const HEUTE = '2026-10-17T22:00:00Z';
	const d = b.auswerten(basis());
	const m = (n, status, ergebnis, kunde_id = 'k1', createdAt = '2026-10-18T06:00:00Z') => Array.from({ length: n }, () => ({ kunde_id, status, ergebnis, createdAt }));
	const mails = [
		...m(20, 'fertig', 'bereit'), ...m(5, 'fertig', 'antwort_bereit'), ...m(1, 'fertig', 'antwort_keine_daten'), ...m(1, 'fertig', 'antwort_gemeldet'),
		...m(4, 'fertig', 'luecken'), ...m(1, 'fertig', 'antwort_luecken'),
		...m(2, 'fertig', 'zuordnung_unklar'), ...m(1, 'fertig', 'antwort_extraktion_fehlgeschlagen'),
		...m(1, 'fehler', null),
		// nicht gezählt
		...m(3, 'fertig', 'duplikat'), ...m(2, 'fertig', 'ignoriert_auto_antwort'), ...m(1, 'fertig', 'ignoriert'), ...m(1, 'in_arbeit', null),
		...m(4, 'fertig', 'bereit', 'k2'), ...m(4, 'fertig', 'bereit', 'k1', '2026-10-17T10:00:00Z'),
	];
	const v = b.vorgangsstatus({ daten: d, mails, heuteAb: HEUTE });
	assert.deepEqual(v.zahlen, { automatisch: 27, freigabe: 5, exception: 3, fehler: 1 });
	assert.equal(v.gesamt, 36);
	assert.equal(v.automation_rate, 75);
	const k = b.kennzahlen({ daten: d, configs: basis().configs, vorgaenge: [], mails, heuteAb: HEUTE });
	const html = b.seite({ daten: d, kopf: k, verteilung: v, jetzt: JETZT, ablauf: JETZT });
	assert.match(html, /<h2 class="abschnitt">Vorgangsstatus heute<\/h2>/);
	assert.equal((html.match(/<circle r="70"[^>]*stroke-dasharray/g) || []).length, 4);
	assert.match(html, /<div class="name">Human Approval<\/div><div class="wert">5<\/div>/);
	assert.match(html, /75,0 %<\/span> Automation Rate/);
	// Ohne Daten: leerer Ring, keine Quote
	const leer = b.vorgangsstatus({ daten: d, mails: [], heuteAb: HEUTE });
	assert.equal(leer.automation_rate, null);
	const h2 = b.seite({ daten: d, kopf: k, verteilung: leer, jetzt: JETZT, ablauf: JETZT });
	assert.match(h2, /keine Daten/);
	assert.equal(h2.includes('stroke-dasharray'), false);
	// Duplikate zählen in der Agent-Tabelle nicht als Mail
	assert.equal(b.agentStatus({ daten: d, mails, heuteAb: HEUTE, jetzt: JETZT })[0].heute, 36 + 3 + 1);
});
