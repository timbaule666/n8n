'use strict';
const { Workflow, bedingung, bedingungen, uuid } = require('../../tools/lib/n8n');
const { PFAD } = require('../../src/uebersicht');

const SEITE_HEADER = {
	entries: [
		{ name: 'Content-Type', value: 'text/html; charset=utf-8' },
		{ name: 'Cache-Control', value: 'no-store' },
		// Der Schlüssel steht in der Adresse: nicht an andere Seiten weitergeben.
		{ name: 'Referrer-Policy', value: 'no-referrer' },
		{ name: 'X-Robots-Tag', value: 'noindex' },
		{ name: 'X-Frame-Options', value: 'DENY' },
		{ name: 'X-Content-Type-Options', value: 'nosniff' },
	],
};
const Z = "$('Zugang prüfen').first().json";

module.exports = function () {
	const wf = new Workflow('EPA-12 Übersicht-Seite');
	// Seiten enthalten Kundendaten: erfolgreiche Ausführungen nicht speichern.
	wf.settings.saveDataSuccessExecution = 'none';

	wf.notiz('Notiz Zweck', [-120, -520], [
		'## EPA-12 Übersicht-Seite',
		'**Zweck:** Webseite mit den offenen Vorgängen EINES Kunden: Klärung nötig, wartet auf Freigabe, bereit zur Bearbeitung, wartet auf Kunde, wird verarbeitet. Je Vorgang Betreff, Absender, Fristen, fehlende und erkannte Angaben, Link zur Originalmail. Nur lesen, keine Aktionen.',
		'**Zugang:** geheimer Link …/webhook/' + PFAD + '?k=<Schlüssel>. Gespeichert ist nur der SHA-256-Hash (Tabelle epa_uebersicht_zugaenge, mit Ablauf und gesperrt_am). Der Kunde ergibt sich nur aus dem Zugang; gelesen werden nur Zeilen mit dieser kunde_id.',
		'**Links erzeugen:** EPA-13 Tagesübersicht (jeden Tag ein neuer Link, 30 Tage gültig). **Sperren:** gesperrt_am setzen oder Zeile löschen.',
		'**Trigger:** Webhook GET /webhook/' + PFAD + '. Muss veröffentlicht sein. Keine Credentials nötig.',
	].join('\n'), { breite: 900, hoehe: 300 });

	const hook = wf.node('Übersicht-Link', 'n8n-nodes-base.webhook', [0, 0], {
		httpMethod: 'GET',
		path: PFAD,
		responseMode: 'responseNode',
		options: {},
	}, { webhookId: uuid('EPA-12', PFAD) });
	const lesen = wf.code('Anfrage lesen', [220, 0], ['uebersicht'], `
const crypto = require('crypto');
const k = String(($input.first().json.query || {}).k || '');
const gueltig = uebersicht.istGueltigesToken(k);
return [{ json: { hash: gueltig ? uebersicht.tokenHash(crypto, k) : '__ungueltig__', jetzt: new Date().toISOString() } }];
`);
	const zugang = wf.tabelle('Zugang lesen', [440, 0], 'get', 'epa_uebersicht_zugaenge', { bedingungen: [['schluessel_hash', 'eq', '={{ $json.hash }}']] }, { alwaysOutputData: true });
	const pruefen = wf.code('Zugang prüfen', [660, 0], ['uebersicht'], `
const z = $input.first().json;
const r = uebersicht.zugangPruefen({ zugang: z && z.id !== undefined ? z : null, jetzt: $('Anfrage lesen').first().json.jetzt });
return [{ json: { ...r, ablauf: r.ok ? z.ablauf : null } }];
`);
	const ok = wf.node('Zugang gültig?', 'n8n-nodes-base.if', [880, 0], {
		conditions: bedingungen([bedingung('={{ $json.ok }}', { type: 'boolean', operation: 'true', singleValue: true })]),
		options: {},
	});
	const einmal = { alwaysOutputData: true, executeOnce: true };
	const kunde = wf.tabelle('Kunde lesen', [1100, -100], 'get', 'epa_config_allgemein', { bedingungen: [['kunde_id', 'eq', `={{ ${Z}.kunde_id }}`]] }, einmal);
	const vorgaenge = wf.tabelle('Vorgänge lesen', [1320, -100], 'get', 'epa_vorgaenge', { bedingungen: [['kunde_id', 'eq', `={{ ${Z}.kunde_id }}`]], alle: true }, einmal);
	const freigaben = wf.tabelle('Offene Freigaben lesen', [1540, -100], 'get', 'epa_freigaben', {
		bedingungen: [['kunde_id', 'eq', `={{ ${Z}.kunde_id }}`], ['status', 'eq', 'offen']],
		alle: true,
	}, einmal);
	const felder = wf.tabelle('Pflichtfelder lesen', [1760, -100], 'get', 'epa_config_pflichtfelder', { bedingungen: [['kunde_id', 'eq', `={{ ${Z}.kunde_id }}`]], alle: true }, einmal);
	const bauen = wf.code('Seite bauen', [1980, -100], ['uebersicht'], `
const z = $('Zugang prüfen').first().json;
const jetzt = $('Anfrage lesen').first().json.jetzt;
const zeilen = (n) => $(n).all().map((i) => i.json).filter((r) => r && r.id !== undefined && r.kunde_id === z.kunde_id);
const k = zeilen('Kunde lesen')[0] || { kunde_id: z.kunde_id };
const gruppen = uebersicht.gruppieren({ kunde_id: z.kunde_id, vorgaenge: zeilen('Vorgänge lesen'), freigaben: zeilen('Offene Freigaben lesen'), felder: zeilen('Pflichtfelder lesen'), jetzt });
return [{ json: { status: 200, html: uebersicht.seite({ kunde: { kunde_id: k.kunde_id, postfach: k.postfach }, gruppen, jetzt, zone: k.zeitzone || 'Europe/Berlin', ablauf: z.ablauf }) } }];
`);
	const abweisen = wf.code('Seite: kein Zugang', [1100, 120], ['uebersicht'], `
const z = $input.first().json;
return [{ json: { status: z.status || 404, html: uebersicht.seiteMeldung(z.titel || 'Link ungültig', z.text || '') } }];
`);
	const antwort = wf.node('Seite ausliefern', 'n8n-nodes-base.respondToWebhook', [2200, 0], {
		respondWith: 'text',
		responseBody: '={{ $json.html }}',
		options: { responseCode: '={{ $json.status }}', responseHeaders: SEITE_HEADER },
	});

	wf.kette(hook, lesen, zugang, pruefen, ok);
	wf.verbinde(ok, kunde, 0);
	wf.verbinde(ok, abweisen, 1);
	wf.kette(kunde, vorgaenge, freigaben, felder, bauen, antwort);
	wf.kette(abweisen, antwort);
	return wf;
};
